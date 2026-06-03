# 第 55 章：沙箱、权限策略与远程命令安全

第 54 章补完了 Environment Runner：

```txt
work secret
workspace root
git source checkout
child env
CCR v2
file input
file output
token refresh
self-hosted runner
```

这让远程任务能在真实仓库里跑起来。

但这也带来一个更严肃的问题：

```txt
远程 session 能运行 Bash。
远程 session 能写文件。
远程 session 能访问网络。
远程 session 可能没有本地交互式确认。
远程 session 跑在用户自己的 BYOC 机器上。
```

如果没有安全边界，BYOC runner 就不是“远程 Claude Code”，而是“远程任意命令执行器”。

官方 Claude Code 的关键不只是能做事，而是：

```txt
知道哪些事需要问
知道哪些事必须拒绝
知道哪些事即使允许也要关进沙箱
知道远程和 headless 场景不能假装有用户在旁边点确认
```

本章目标：

- 梳理现有 permission pipeline
- 梳理 permission mode
- 梳理 Bash 权限判断顺序
- 梳理 FileRead / FileEdit / FileWrite 的路径安全
- 梳理 sandbox-runtime 适配层
- 梳理 `autoAllowBashIfSandboxed`
- 梳理 `dangerouslyDisableSandbox` 的策略边界
- 梳理远程 permission request / response
- 给 BYOC / self-hosted runner 增加最小安全策略
- 给 Mini 增加可测试的 policy gate

到本章结束，你的 Mini 会具备：

- remote security policy
- runner-level permission mode allowlist
- sandbox required mode
- sandbox unavailable fail-closed
- command sandbox wrapper
- explicit unsandbox override gate
- file read/write working directory boundary
- dangerous path safety check
- UNC / suspicious Windows path拦截
- Bash deny / ask / allow 规则优先级
- compound command 子命令检查
- sandbox auto-allow
- headless no-prompt fallback
- remote permission forwarding
- policy redaction
- command audit record
- 安全相关测试矩阵

本章会把第 54 章的执行层升级成：

```txt
能跑
  -> 能按策略跑
  -> 能在无交互远程环境里安全失败
```

## 参考源码

本章参考这些真实模块：

```txt
src/types/permissions.ts
src/utils/permissions/PermissionMode.ts
src/utils/permissions/permissions.ts
src/utils/permissions/permissionSetup.ts
src/utils/permissions/filesystem.ts
src/utils/permissions/shellRuleMatching.ts
src/utils/permissions/dangerousPatterns.ts
src/hooks/useCanUseTool.tsx

src/entrypoints/sandboxTypes.ts
src/utils/sandbox/sandbox-adapter.ts
src/commands/sandbox-toggle/index.ts
src/commands/sandbox-toggle/sandbox-toggle.tsx
src/components/sandbox/*

packages/builtin-tools/src/tools/BashTool/BashTool.tsx
packages/builtin-tools/src/tools/BashTool/bashPermissions.ts
packages/builtin-tools/src/tools/BashTool/shouldUseSandbox.ts
packages/builtin-tools/src/tools/BashTool/bashSecurity.ts
packages/builtin-tools/src/tools/BashTool/pathValidation.ts
packages/builtin-tools/src/tools/BashTool/commandSemantics.ts

packages/builtin-tools/src/tools/FileReadTool/FileReadTool.ts
packages/builtin-tools/src/tools/FileEditTool/FileEditTool.ts
packages/builtin-tools/src/tools/FileWriteTool/FileWriteTool.ts

src/bridge/sessionRunner.ts
src/bridge/bridgeMain.ts
src/remote/RemoteSessionManager.ts
src/ssh/SSHSessionManager.ts
src/services/acp/permissions.ts
```

这些源码体现了一个核心原则：

```txt
权限判断不是一个 if。
权限判断是一条 pipeline。
```

Pipeline 里每一步都有优先级。

一旦顺序错了，就会出现安全绕过：

```txt
deny 被 ask 降级
危险路径被 allow 覆盖
compound command 只检查第一段
sandbox override 绕过策略
headless 模式里 ask 永远等不到用户
```

## 总体模型

安全边界分三层：

```txt
Permission Layer
  决定能不能调用工具
  决定 allow / ask / deny
  负责规则、模式、路径、分类器、hook

Sandbox Layer
  限制真正进程能力
  负责文件系统、网络、socket、命令包装、违规记录

Runner Policy Layer
  远程场景的部署策略
  负责禁止高危模式、强制沙箱、禁止无交互 ask、注入策略环境
```

三层关系：

```txt
model emits tool_use
  -> canUseTool
  -> hasPermissionsToUseTool
  -> tool.checkPermissions
  -> allow / ask / deny
  -> tool.call
  -> sandbox wrap command
  -> process executes
  -> audit / output / cleanup
```

远程场景再加一层：

```txt
child CLI emits control_request
  -> bridge / remote manager
  -> Web / ACP / SSH client approval
  -> control_response
  -> child resumes or denies tool
```

BYOC runner 的基本策略应该是：

```txt
默认不使用 bypassPermissions。
默认开启 sandbox。
sandbox 不可用时失败，而不是静默降级。
远程无交互时 ask 必须变成 deny 或转发给远端用户。
```

## Permission Modes

现有权限模式在 `src/types/permissions.ts`：

```ts
export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const;

export type InternalPermissionMode =
  | ExternalPermissionMode
  | 'auto'
  | 'bubble';

export type PermissionMode = InternalPermissionMode;
```

用户可见模式：

| mode | 含义 | 远程建议 |
| --- | --- | --- |
| `default` | 默认，需要时询问 | 允许 |
| `acceptEdits` | 工作区内编辑自动允许 | 谨慎允许 |
| `plan` | 规划模式 | 允许 |
| `dontAsk` | ask 转 deny | 适合 headless |
| `bypassPermissions` | 尽量跳过提示 | 默认禁止 |
| `auto` | 分类器自动判定 | 可选，需要模型支持 |

`PermissionMode.ts` 负责把字符串转为模式：

```ts
export function permissionModeFromString(str: string): PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(str)
    ? (str as PermissionMode)
    : 'default';
}
```

对 BYOC / self-hosted runner 来说，不要让远端任意指定 mode。

应该加一层 allowlist。

## Remote Permission Policy

给 Work Secret 加一个安全策略：

```ts
export type RemoteSecurityPolicy = {
  allowedPermissionModes: PermissionMode[];
  defaultPermissionMode: PermissionMode;
  requireSandbox: boolean;
  failIfSandboxUnavailable: boolean;
  allowUnsandboxedCommands: boolean;
  allowBypassPermissions: boolean;
  allowAutoMode: boolean;
  allowedNetworkDomains: string[];
  allowedWriteRoots: string[];
  deniedWriteRoots: string[];
  deniedReadRoots: string[];
  maxCommandTimeoutMs: number;
  maxBackgroundTasks: number;
};
```

默认策略：

```ts
export const DEFAULT_REMOTE_SECURITY_POLICY: RemoteSecurityPolicy = {
  allowedPermissionModes: ['default', 'acceptEdits', 'dontAsk', 'plan'],
  defaultPermissionMode: 'default',
  requireSandbox: true,
  failIfSandboxUnavailable: true,
  allowUnsandboxedCommands: false,
  allowBypassPermissions: false,
  allowAutoMode: false,
  allowedNetworkDomains: [],
  allowedWriteRoots: [],
  deniedWriteRoots: [],
  deniedReadRoots: [],
  maxCommandTimeoutMs: 120_000,
  maxBackgroundTasks: 2,
};
```

策略设计要保守。

尤其是：

```txt
allowBypassPermissions 默认 false
allowUnsandboxedCommands 默认 false
failIfSandboxUnavailable 默认 true
```

远程 runner 和本地交互 CLI 最大的区别是：

```txt
本地用户看到提示，可以现场判断。
远程 child 可能没有可用提示面板。
```

因此远程环境不能把“询问用户”当成兜底。

## Policy Normalization

Work Secret 可以带 policy，但 runner 要做 normalization：

```ts
export function normalizeRemoteSecurityPolicy(
  input: Partial<RemoteSecurityPolicy> | undefined,
): RemoteSecurityPolicy {
  const base = DEFAULT_REMOTE_SECURITY_POLICY;
  const policy: RemoteSecurityPolicy = {
    ...base,
    ...input,
    allowedPermissionModes:
      input?.allowedPermissionModes ?? base.allowedPermissionModes,
    allowedNetworkDomains:
      input?.allowedNetworkDomains ?? base.allowedNetworkDomains,
    allowedWriteRoots: input?.allowedWriteRoots ?? base.allowedWriteRoots,
    deniedWriteRoots: input?.deniedWriteRoots ?? base.deniedWriteRoots,
    deniedReadRoots: input?.deniedReadRoots ?? base.deniedReadRoots,
  };

  if (!policy.allowBypassPermissions) {
    policy.allowedPermissionModes = policy.allowedPermissionModes.filter(
      mode => mode !== 'bypassPermissions',
    );
  }

  if (!policy.allowAutoMode) {
    policy.allowedPermissionModes = policy.allowedPermissionModes.filter(
      mode => mode !== 'auto',
    );
  }

  if (!policy.allowedPermissionModes.includes(policy.defaultPermissionMode)) {
    policy.defaultPermissionMode = 'default';
  }

  return policy;
}
```

这里有一个故意的选择：

```txt
非法策略不应该扩大权限。
非法策略只会被收窄。
```

## Mode Resolution

远程任务最终 mode 来自：

```txt
work secret permissionMode
environment policy defaultPermissionMode
runner global override
```

实现：

```ts
export function resolveRemotePermissionMode(input: {
  requestedMode: string | undefined;
  policy: RemoteSecurityPolicy;
}): PermissionMode {
  const requested = input.requestedMode
    ? permissionModeFromString(input.requestedMode)
    : input.policy.defaultPermissionMode;

  if (!input.policy.allowedPermissionModes.includes(requested)) {
    return input.policy.defaultPermissionMode;
  }

  return requested;
}
```

不要抛错直接停止 session。

更好的行为是：

```txt
远端请求高权限
  -> runner 降级到 policy default
  -> audit 记录 requested / effective
```

但是如果远端明确要求 `bypassPermissions` 且策略禁止，可以选择 fail-closed。

Mini 推荐：

```ts
export function assertRequestedModeAllowed(input: {
  requestedMode: string | undefined;
  effectiveMode: PermissionMode;
  policy: RemoteSecurityPolicy;
}): void {
  if (
    input.requestedMode === 'bypassPermissions' &&
    input.effectiveMode !== 'bypassPermissions'
  ) {
    throw new Error('Remote policy forbids bypassPermissions mode');
  }
}
```

这样高危请求不会静默变成普通任务而误导调用方。

## ToolPermissionContext

`Tool.ts` 里的核心上下文：

```ts
export type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode;
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>;
  alwaysAllowRules: ToolPermissionRulesBySource;
  alwaysDenyRules: ToolPermissionRulesBySource;
  alwaysAskRules: ToolPermissionRulesBySource;
  isBypassPermissionsModeAvailable: boolean;
  isAutoModeAvailable?: boolean;
  strippedDangerousRules?: ToolPermissionRulesBySource;
  shouldAvoidPermissionPrompts?: boolean;
  awaitAutomatedChecksBeforeDialog?: boolean;
  prePlanMode?: PermissionMode;
}>;
```

空上下文：

```ts
export const getEmptyToolPermissionContext = () => ({
  mode: 'default',
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: true,
});
```

远程 runner 需要覆盖几个字段：

```ts
export function buildRemoteToolPermissionContext(input: {
  mode: PermissionMode;
  workspaceRoot: string;
  repoDir: string;
  policy: RemoteSecurityPolicy;
}): ToolPermissionContext {
  const context = getEmptyToolPermissionContext();

  return {
    ...context,
    mode: input.mode,
    isBypassPermissionsModeAvailable: input.policy.allowBypassPermissions,
    isAutoModeAvailable: input.policy.allowAutoMode,
    shouldAvoidPermissionPrompts: true,
    additionalWorkingDirectories: new Map([
      [
        input.repoDir,
        {
          path: input.repoDir,
          source: 'session',
        },
      ],
    ]),
    alwaysDenyRules: {
      session: [
        ...toFileDenyRules(input.policy.deniedReadRoots, 'Read'),
        ...toFileDenyRules(input.policy.deniedWriteRoots, 'Edit'),
      ],
    },
    alwaysAllowRules: {
      session: toFileAllowRules(input.policy.allowedWriteRoots),
    },
    alwaysAskRules: {},
  };
}
```

注意：

```txt
additionalWorkingDirectories 不是 allow all。
它只是让路径边界知道哪些目录属于工作区。
具体文件读写仍然经过 deny / ask / safety checks。
```

## Permission Pipeline

真实主流程在 `src/utils/permissions/permissions.ts`。

关键顺序：

```txt
1a entire tool deny
1b entire tool ask
1c tool.checkPermissions
1d tool implementation deny
1e requires user interaction
1f content-specific ask rules
1g safetyCheck
2a bypassPermissions
2b always allow
3 passthrough -> ask
dontAsk ask -> deny
auto classifier
headless ask -> deny unless hooks decide
```

这个顺序非常重要。

其中几个不可破坏的点：

```txt
deny 在 allow 前。
safetyCheck 在 bypassPermissions 前。
content-specific ask 在 bypassPermissions 前。
requiresUserInteraction 不被 bypass 偷偷放行。
headless 不能返回永远等待用户的 ask。
```

Mini 可以把这个顺序写成小型版本：

```ts
export async function decideToolPermission(input: {
  tool: Tool;
  toolInput: Record<string, unknown>;
  context: ToolUseContext;
}): Promise<PermissionDecision> {
  const rules = input.context.getAppState().toolPermissionContext;

  const denied = getDenyRuleForTool(rules, input.tool);
  if (denied) {
    return denyByRule(input.tool.name, denied);
  }

  const toolDecision = await input.tool.checkPermissions(
    input.tool.inputSchema.parse(input.toolInput),
    input.context,
  );

  if (toolDecision.behavior === 'deny') {
    return toolDecision;
  }

  if (
    toolDecision.behavior === 'ask' &&
    toolDecision.decisionReason?.type === 'safetyCheck'
  ) {
    return toolDecision;
  }

  if (rules.mode === 'bypassPermissions') {
    return {
      behavior: 'allow',
      updatedInput: input.toolInput,
      decisionReason: { type: 'mode', mode: rules.mode },
    };
  }

  const allowed = toolAlwaysAllowedRule(rules, input.tool);
  if (allowed) {
    return allowByRule(input.toolInput, allowed);
  }

  if (toolDecision.behavior === 'passthrough') {
    return {
      behavior: 'ask',
      message: `Claude requested permissions to use ${input.tool.name}.`,
    };
  }

  return toolDecision;
}
```

真实实现更复杂，但 Mini 必须保留优先级。

## Headless Ask

远程 runner 经常没有本地 dialog。

现有逻辑里：

```txt
shouldAvoidPermissionPrompts=true
```

会让 ask 走：

```txt
run PermissionRequest hooks
没有 hook 决定 -> deny
```

这适合 headless。

但是 Web / Remote Control 场景还有另一种路径：

```txt
child emits control_request
bridge forwards to remote UI
remote user approves
child receives control_response
```

因此远程场景分两类：

```txt
No remote permission channel
  shouldAvoidPermissionPrompts=true
  ask -> deny

Has remote permission channel
  ask -> control_request
  wait remote response
```

不要混淆。

BYOC runner 如果是纯 self-hosted batch 模式，建议：

```txt
dontAsk 或 default + shouldAvoidPermissionPrompts
```

如果是 Web Console 实时控制，建议：

```txt
default + remote permission forwarding
```

## Remote Permission Forwarding

`src/bridge/sessionRunner.ts` 会解析 child stdout：

```txt
type: control_request
request.subtype: can_use_tool
```

然后调用：

```txt
onPermissionRequest(sessionId, request, accessToken)
```

远端管理器也有同样模型。

`src/remote/RemoteSessionManager.ts`：

```ts
export type RemotePermissionResponse =
  | {
      behavior: 'allow';
      updatedInput: Record<string, unknown>;
    }
  | {
      behavior: 'deny';
      message: string;
    };
```

响应：

```ts
const response: SDKControlResponse = {
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: requestId,
    response: {
      behavior: result.behavior,
      ...(result.behavior === 'allow'
        ? { updatedInput: result.updatedInput }
        : { message: result.message }),
    },
  },
};
```

这条链路说明：

```txt
远程 permission 不是 runner 自己决定。
runner 只是转发。
最终 allow / deny 应由用户界面、策略或 ACP client 决定。
```

## ACP Permission Bridge

ACP 里 `createAcpCanUseTool()` 先跑本地 permission pipeline：

```txt
hasPermissionsToUseTool
  -> allow / deny 直接返回
  -> ask 才委托给 ACP client
```

这点很重要。

远程客户端不能覆盖本地硬性拒绝：

```txt
deny rule
safetyCheck non-approvable
policy-rejected mode
```

Mini 也要保持：

```ts
export async function remoteCanUseTool(input: {
  localDecision: PermissionDecision;
  requestRemote: () => Promise<RemotePermissionResponse>;
}): Promise<PermissionDecision> {
  if (input.localDecision.behavior === 'allow') {
    return input.localDecision;
  }

  if (input.localDecision.behavior === 'deny') {
    return input.localDecision;
  }

  const remote = await input.requestRemote();
  if (remote.behavior === 'allow') {
    return {
      behavior: 'allow',
      updatedInput: remote.updatedInput,
    };
  }

  return {
    behavior: 'deny',
    message: remote.message,
    decisionReason: { type: 'mode', mode: 'default' },
  };
}
```

不要让 remote UI 的 allow 覆盖 local deny。

## Sandbox Settings Schema

`src/entrypoints/sandboxTypes.ts` 定义了 settings schema。

核心字段：

```ts
export const SandboxSettingsSchema = lazySchema(() =>
  z
    .object({
      enabled: z.boolean().optional(),
      failIfUnavailable: z.boolean().optional(),
      autoAllowBashIfSandboxed: z.boolean().optional(),
      allowUnsandboxedCommands: z.boolean().optional(),
      network: SandboxNetworkConfigSchema(),
      filesystem: SandboxFilesystemConfigSchema(),
      ignoreViolations: z.record(z.string(), z.array(z.string())).optional(),
      enableWeakerNestedSandbox: z.boolean().optional(),
      enableWeakerNetworkIsolation: z.boolean().optional(),
      excludedCommands: z.array(z.string()).optional(),
      ripgrep: z
        .object({
          command: z.string(),
          args: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .passthrough(),
);
```

网络：

```ts
export const SandboxNetworkConfigSchema = lazySchema(() =>
  z
    .object({
      allowedDomains: z.array(z.string()).optional(),
      allowManagedDomainsOnly: z.boolean().optional(),
      allowUnixSockets: z.array(z.string()).optional(),
      allowAllUnixSockets: z.boolean().optional(),
      allowLocalBinding: z.boolean().optional(),
      httpProxyPort: z.number().optional(),
      socksProxyPort: z.number().optional(),
    })
    .optional(),
);
```

文件系统：

```ts
export const SandboxFilesystemConfigSchema = lazySchema(() =>
  z
    .object({
      allowWrite: z.array(z.string()).optional(),
      denyWrite: z.array(z.string()).optional(),
      denyRead: z.array(z.string()).optional(),
      allowRead: z.array(z.string()).optional(),
      allowManagedReadPathsOnly: z.boolean().optional(),
    })
    .optional(),
);
```

BYOC runner 需要把 policy 映射成这些字段。

## Sandbox Runtime Config

`src/utils/sandbox/sandbox-adapter.ts` 的 `convertToSandboxRuntimeConfig()` 做了几件事：

```txt
从 WebFetch allow rule 提取 allowedDomains
从 WebFetch deny rule 提取 deniedDomains
从 Edit allow rule 提取 allowWrite
从 Edit deny rule 提取 denyWrite
从 Read deny rule 提取 denyRead
合并 sandbox.filesystem
合并 additionalDirectories
保护 settings.json
保护 .claude/skills
保护 bare repo escape 文件
处理 worktree main repo 写权限
配置 ripgrep
```

关键输出：

```ts
return {
  network: {
    allowedDomains,
    deniedDomains,
    allowUnixSockets,
    allowAllUnixSockets,
    allowLocalBinding,
    httpProxyPort,
    socksProxyPort,
  },
  filesystem: {
    denyRead,
    allowRead,
    allowWrite,
    denyWrite,
  },
  ignoreViolations,
  enableWeakerNestedSandbox,
  enableWeakerNetworkIsolation,
  ripgrep,
};
```

这里体现了一个设计：

```txt
permission rules 决定 UI / tool 层。
sandbox config 决定 OS / process 层。
两者必须从同一份 settings / policy 派生。
```

否则会出现：

```txt
UI 允许，但 sandbox 拦截。
UI 拒绝，但 sandbox 放行。
```

UI 拒绝但 sandbox 放行还可以接受，因为工具不会执行。

UI 允许但 sandbox 拦截会影响体验，但安全上是可接受的。

真正危险的是：

```txt
UI 允许，sandbox 未启用，policy 本以为已经限制。
```

所以远程 runner 要 fail-closed。

## Sandbox Availability

现有 adapter：

```ts
function isSandboxingEnabled(): boolean {
  if (!isSupportedPlatform()) {
    return false;
  }

  if (checkDependencies().errors.length > 0) {
    return false;
  }

  if (!isPlatformInEnabledList()) {
    return false;
  }

  return getSandboxEnabledSetting();
}
```

如果用户显式开启 sandbox 但不可用，会返回 reason：

```ts
function getSandboxUnavailableReason(): string | undefined {
  if (!getSandboxEnabledSetting()) {
    return undefined;
  }

  if (!isSupportedPlatform()) {
    return `sandbox.enabled is set but ${platform} is not supported`;
  }

  if (!isPlatformInEnabledList()) {
    return `sandbox.enabled is set but ${getPlatform()} is not in sandbox.enabledPlatforms`;
  }

  const deps = checkDependencies();
  if (deps.errors.length > 0) {
    return `sandbox.enabled is set but dependencies are missing: ${deps.errors.join(', ')}`;
  }

  return undefined;
}
```

BYOC runner 要把这个 reason 当成硬错误：

```ts
export function assertRemoteSandboxReady(policy: RemoteSecurityPolicy): void {
  if (!policy.requireSandbox) {
    return;
  }

  if (SandboxManager.isSandboxingEnabled()) {
    return;
  }

  const reason =
    SandboxManager.getSandboxUnavailableReason() ??
    'sandbox is required by remote policy but is not enabled';

  if (policy.failIfSandboxUnavailable) {
    throw new Error(reason);
  }
}
```

远程默认建议：

```txt
failIfSandboxUnavailable=true
```

不要让远程 session 在用户以为有 sandbox 的情况下裸跑。

## Applying Sandbox Policy

Mini 可以在 runner 写入 child 的本地 settings overlay。

但更简单、更可测的做法是：

```txt
通过环境变量传递 remote sandbox policy
child 启动时转换成 flagSettings
```

定义：

```ts
export type RemoteSandboxEnv = {
  CLAUDE_CODE_REMOTE_SANDBOX_POLICY: string;
};
```

构造：

```ts
export function buildRemoteSandboxPolicyEnv(
  policy: RemoteSecurityPolicy,
): Record<string, string> {
  return {
    CLAUDE_CODE_REMOTE_SANDBOX_POLICY: Buffer.from(
      JSON.stringify({
        sandbox: {
          enabled: policy.requireSandbox,
          failIfUnavailable: policy.failIfSandboxUnavailable,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: policy.allowUnsandboxedCommands,
          network: {
            allowedDomains: policy.allowedNetworkDomains,
          },
          filesystem: {
            allowWrite: policy.allowedWriteRoots,
            denyWrite: policy.deniedWriteRoots,
            denyRead: policy.deniedReadRoots,
          },
        },
      }),
    ).toString('base64url'),
  };
}
```

child bootstrap 再把它加载进 flagSettings。

如果你不想改 settings loader，也可以让 runner 在 workspace 写一个 session-only settings 文件。

但要注意：

```txt
不要写到用户全局配置。
不要把 secret 写进 settings。
session 结束后要清理。
```

## Sandbox Auto-Allow

`shouldUseSandbox()` 决定一个 Bash 命令是否会被 sandbox：

```ts
export function shouldUseSandbox(input: Partial<SandboxInput>): boolean {
  if (!SandboxManager.isSandboxingEnabled()) {
    return false;
  }

  if (
    input.dangerouslyDisableSandbox &&
    SandboxManager.areUnsandboxedCommandsAllowed()
  ) {
    return false;
  }

  if (!input.command) {
    return false;
  }

  if (containsExcludedCommand(input.command)) {
    return false;
  }

  return true;
}
```

然后 Bash permission 有一个特殊路径：

```txt
sandbox enabled
autoAllowBashIfSandboxed enabled
shouldUseSandbox(input)
  -> checkSandboxAutoAllow
```

`checkSandboxAutoAllow()` 仍然尊重：

```txt
explicit deny
explicit ask
compound command subcommand deny / ask
```

只有没有显式规则阻止时才 allow。

这很关键。

错误实现是：

```txt
sandbox on -> Bash 全部 allow
```

正确实现是：

```txt
sandbox on -> 显式 deny/ask 仍然优先 -> 其余命令 auto allow
```

## Unsandboxed Override

BashTool input schema 里有：

```ts
dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional()).describe(
  'Set this to true to dangerously override sandbox mode and run commands without sandboxing.',
);
```

这不是普通开关。

它必须受策略控制：

```txt
sandbox.allowUnsandboxedCommands=true 才有效
```

远程 runner 默认要设置：

```txt
allowUnsandboxedCommands=false
```

并且最好在 permission 阶段就拦截：

```ts
export function checkRemoteSandboxOverride(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  policy: RemoteSecurityPolicy;
}): PermissionDecision | null {
  if (input.toolName !== 'Bash') {
    return null;
  }

  if (input.toolInput.dangerouslyDisableSandbox !== true) {
    return null;
  }

  if (input.policy.allowUnsandboxedCommands) {
    return null;
  }

  return {
    behavior: 'deny',
    message: 'Remote policy does not allow running Bash outside the sandbox.',
    decisionReason: {
      type: 'sandboxOverride',
      reason: 'dangerouslyDisableSandbox',
    },
  };
}
```

即使 `shouldUseSandbox()` 会忽略 override，也应该在 permission 层给出明确拒绝。

这样审计更清楚。

## Excluded Commands

`excludedCommands` 是用户便利功能，不是安全边界。

源码注释已经说明：

```txt
excludedCommands is a user-facing convenience feature,
not a security boundary.
```

含义：

```txt
某些命令不适合在 sandbox 中跑
用户可以配置让它们裸跑
但真正的安全控制仍然是 permission prompt / policy
```

远程策略里建议：

```txt
禁止使用 excludedCommands 作为自动放行理由。
如果命令命中 excludedCommands 且远程要求 sandbox，直接 deny。
```

Mini 实现：

```ts
export function assertNoExcludedCommandBypass(input: {
  commandWillUseSandbox: boolean;
  policy: RemoteSecurityPolicy;
}): void {
  if (input.policy.requireSandbox && !input.commandWillUseSandbox) {
    throw new Error(
      'Remote policy requires sandbox, but this command would run outside it',
    );
  }
}
```

## Bash Permission Layers

Bash 权限判断比文件工具复杂很多。

核心层级：

```txt
AST parse / injection check
semantic check
sandbox auto-allow
exact deny / allow
prompt deny / ask classifier
operator / pipe / redirect check
path constraints
subcommand split
deny priority merge
allow only when all pieces safe
otherwise ask
```

真实函数是：

```ts
export async function bashToolHasPermission(
  input: z.infer<typeof BashTool.inputSchema>,
  context: ToolUseContext,
): Promise<PermissionResult> {
  // ...
}
```

本章 Mini 只需要保留最关键顺序：

```ts
export async function miniBashPermission(input: {
  command: string;
  context: ToolPermissionContext;
  sandbox: boolean;
}): Promise<PermissionResult> {
  const parse = await parseCommandForSecurity(input.command);
  if (parse.kind !== 'simple') {
    return askForComplexCommand(parse.reason);
  }

  const deny = matchBashRules(input.command, input.context, 'deny');
  if (deny) {
    return denyByRule('Bash', deny);
  }

  const ask = matchBashRules(input.command, input.context, 'ask');
  if (ask) {
    return askByRule('Bash', ask);
  }

  if (input.sandbox) {
    return {
      behavior: 'allow',
      updatedInput: { command: input.command },
      decisionReason: {
        type: 'other',
        reason: 'Auto-allowed with sandbox',
      },
    };
  }

  const allow = matchBashRules(input.command, input.context, 'allow');
  if (allow) {
    return allowByRule({ command: input.command }, allow);
  }

  return {
    behavior: 'ask',
    message: 'Bash command requires approval.',
  };
}
```

真实实现还会处理 redirection、pipeline、wrapper、env var、path constraints。

这些不是“可选增强”，而是安全必要项。

## Deny 优先级

Bash 里有很多注释都在强调：

```txt
Deny takes precedence over ask.
Deny takes precedence over allow.
Compound command must check each subcommand.
```

例如：

```txt
echo hello && rm -rf target
```

如果只看整条命令开头，它像 `echo`。

但真正需要匹配的是每个 subcommand：

```txt
echo hello
rm -rf target
```

Mini 实现：

```ts
export function checkCompoundDeny(input: {
  command: string;
  context: ToolPermissionContext;
}): PermissionResult | null {
  const subcommands = splitCommandSafely(input.command);

  for (const subcommand of subcommands) {
    const deny = matchBashRules(subcommand, input.context, 'deny');
    if (deny) {
      return {
        behavior: 'deny',
        message: `Permission to use Bash with command ${input.command} has been denied.`,
        decisionReason: { type: 'rule', rule: deny },
      };
    }
  }

  return null;
}
```

不要让 full-command ask 先返回。

否则：

```txt
ask wildcard 命中 echo
deny prefix 命中 rm
结果被降级成 ask
```

这是错误的。

## Env Var 和 Wrapper

Bash 权限匹配会处理：

```txt
SAFE_ENV_VARS
ANT_ONLY_SAFE_ENV_VARS
stripSafeWrappers
stripAllLeadingEnvVars
```

目的：

```txt
允许规则匹配 timeout 10 git status
允许 deny rule 拦截 FOO=bar rm file
避免 allow rule 被危险 env var 绕过
```

安全原则：

```txt
allow rule 只剥离安全 env var。
deny / ask rule 可以更激进剥离 env var。
```

原因：

```txt
FOO=bar denied_command
```

如果用户 deny 了 `denied_command`，不应该被 env var 前缀绕过。

但：

```txt
PATH=/tmp command
```

不能为了 allow rule 剥离 `PATH`。

因为这会改变实际运行的二进制。

Mini 要保持这条规则：

```ts
export function normalizeForDeny(command: string): string[] {
  return fixedPointCandidates(command, [
    stripSafeWrappers,
    stripAllLeadingEnvVars,
  ]);
}

export function normalizeForAllow(command: string): string[] {
  return fixedPointCandidates(command, [stripSafeWrappers]);
}
```

## Command Injection Check

Bash 权限一开始会尝试 AST parse：

```txt
parse command
if too complex -> ask
if semantic fail -> ask
else collect simple commands
```

复杂结构包括：

```txt
command substitution
ambiguous expansion
parser differential
control flow that cannot be safely reduced
```

Mini 可以先做保守版本：

```ts
export function parseCommandForSecurity(command: string): SecurityParseResult {
  if (command.length > 10_000) {
    return { kind: 'too-complex', reason: 'Command is too long' };
  }

  if (/[`$][({]/.test(command)) {
    return {
      kind: 'too-complex',
      reason: 'Command contains dynamic substitution',
    };
  }

  if (/\n\s*(if|for|while|case)\b/.test(command)) {
    return {
      kind: 'too-complex',
      reason: 'Command contains control flow',
    };
  }

  return {
    kind: 'simple',
    subcommands: splitCommandSafely(command),
  };
}
```

这比真实实现粗糙，但方向正确：

```txt
不能证明安全 -> ask / deny
```

远程无交互时：

```txt
不能证明安全 -> deny
```

## Path Constraints for Bash

Bash 不只是运行命令。

它还会通过 redirection 写文件：

```txt
echo x > file
cmd >> log
cmd < input
```

所以 Bash 权限必须检查路径。

真实实现有：

```txt
extractOutputRedirections
checkPathConstraints
compoundCommandHasCd
cd + redirect 防绕过
```

Mini 需要做：

```ts
export function checkBashRedirectionPaths(input: {
  command: string;
  permissionContext: ToolPermissionContext;
}): PermissionResult | null {
  const redirects = extractSimpleOutputRedirects(input.command);

  for (const redirectPath of redirects) {
    const decision = checkWritePath(redirectPath, input.permissionContext);
    if (decision.behavior !== 'allow') {
      return decision;
    }
  }

  return null;
}
```

并且：

```txt
如果 compound command 里有 cd，就不要用原 cwd 直接判定后续 redirection。
```

保守策略：

```ts
if (commandHasCd(input.command) && redirects.length > 0) {
  return {
    behavior: 'ask',
    message: 'Command changes directory and writes files.',
    decisionReason: {
      type: 'safetyCheck',
      reason: 'cd plus redirection requires approval',
      classifierApprovable: false,
    },
  };
}
```

远程 headless 下就是 deny。

## File Permission Model

File 工具有三个核心函数：

```txt
checkReadPermissionForTool
checkWritePermissionForTool
checkPathSafetyForAutoEdit
```

FileRead：

```txt
UNC / suspicious path -> ask
Read deny -> deny
Read ask -> ask
Edit allow implies read
working directory -> allow
internal readable path -> allow
Read allow -> allow
otherwise ask
```

FileWrite / FileEdit：

```txt
Edit deny -> deny
internal editable path -> allow
.claude session allow special case
safety check -> ask
Edit ask -> ask
acceptEdits + working dir -> allow
Edit allow -> allow
otherwise ask
```

这个顺序也不能乱。

尤其是：

```txt
safety check 必须在 allow rule 前。
deny rule 必须在 internal allow 前。
read deny 必须在 edit implies read 前。
```

## Dangerous Paths

`filesystem.ts` 定义危险文件：

```ts
export const DANGEROUS_FILES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.claude.json',
] as const;
```

危险目录：

```ts
export const DANGEROUS_DIRECTORIES = [
  '.git',
  '.vscode',
  '.idea',
  '.claude',
] as const;
```

为什么这些危险？

| 路径 | 风险 |
| --- | --- |
| `.git` | hook、config、fsmonitor、bare repo escape |
| `.gitconfig` | alias、credential、include |
| `.gitmodules` | submodule URL / command surface |
| shell rc | 后续 shell 启动执行 |
| `.mcp.json` | 工具服务器配置 |
| `.claude` | agent、skill、settings、hook |
| `.vscode` / `.idea` | IDE task / extension / interpreter 配置 |

远程 runner 对这些路径要更严格。

默认：

```txt
read 可按规则
write 必须显式 session allow
headless 无远程 permission channel 时 deny
```

## Suspicious Windows Paths

真实实现会检测：

```txt
NTFS Alternate Data Streams
8.3 short names
long path prefixes
trailing dots and spaces
DOS device names
three or more consecutive dots
UNC paths
```

原因：

```txt
这些路径可能绕过字符串检查
可能触发网络认证
可能指向特殊设备
可能和实际文件解析不一致
```

Mini 要至少实现：

```ts
export function hasSuspiciousPathPattern(path: string): boolean {
  if (path.startsWith('\\\\') || path.startsWith('//')) {
    return true;
  }
  if (/~\d/.test(path)) {
    return true;
  }
  if (
    path.startsWith('\\\\?\\') ||
    path.startsWith('\\\\.\\') ||
    path.startsWith('//?/') ||
    path.startsWith('//./')
  ) {
    return true;
  }
  if (/[.\s]+$/.test(path)) {
    return true;
  }
  if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(path)) {
    return true;
  }
  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(path)) {
    return true;
  }
  return false;
}
```

远程无交互：

```txt
suspicious path -> deny
```

不要尝试“规范化后继续”。

路径规范化容易引入 TOCTOU。

## Working Directory Boundary

`pathInAllowedWorkingPath()` 做了几个关键动作：

```txt
检查原始路径
检查 symlink resolved paths
解析 working directories
跨平台相对路径判断
大小写归一
拒绝 path traversal
```

Mini 版本：

```ts
export function pathInsideAnyRoot(input: {
  path: string;
  roots: string[];
}): boolean {
  const target = normalizeCase(resolve(input.path));
  return input.roots.some(root => {
    const base = normalizeCase(resolve(root));
    const rel = relative(base, target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

function normalizeCase(path: string): string {
  return path.toLowerCase();
}
```

真实实现还会处理 symlink。

Mini 如果暂时不做 symlink resolved path，至少要在文档里标为 gap。

BYOC runner 的 working root 应该是：

```txt
repoDir
explicit allowedWriteRoots
session outputs dir
session uploads dir read-only
```

不要把整个 runner root 加进去。

否则一个 session 可以读写另一个 session。

## Internal Paths

真实实现允许一些 internal path：

```txt
session memory
plan files
tool result files
scratchpad
agent memory scoped path
```

这些不应该简单套用到远程 runner。

远程场景应区分：

```txt
Claude Code 内部运行所需路径
用户仓库路径
session input / output path
```

建议：

```txt
internal read allow: tool result, session memory
internal write allow: current session plan, current session outputs
never allow: global settings, other sessions
```

Mini 可以明确声明：

```ts
export type RemotePathClass =
  | 'repo'
  | 'session_uploads'
  | 'session_outputs'
  | 'runner_internal'
  | 'other_session'
  | 'outside';
```

分类：

```ts
export function classifyRemotePath(input: {
  path: string;
  repoDir: string;
  sessionDir: string;
  outputsDir: string;
  uploadsDir: string;
  runnerRoot: string;
}): RemotePathClass {
  if (pathInside(input.path, input.outputsDir)) return 'session_outputs';
  if (pathInside(input.path, input.uploadsDir)) return 'session_uploads';
  if (pathInside(input.path, input.repoDir)) return 'repo';
  if (pathInside(input.path, input.sessionDir)) return 'runner_internal';
  if (pathInside(input.path, input.runnerRoot)) return 'other_session';
  return 'outside';
}
```

策略：

| class | read | write |
| --- | --- | --- |
| `repo` | allow | mode / rule |
| `session_uploads` | allow | deny |
| `session_outputs` | allow | allow |
| `runner_internal` | ask / deny | deny |
| `other_session` | deny | deny |
| `outside` | ask / deny | ask / deny |

远程 headless 下 ask 变 deny。

## Network Policy

Sandbox network config 支持：

```txt
allowedDomains
deniedDomains
allowUnixSockets
allowAllUnixSockets
allowLocalBinding
httpProxyPort
socksProxyPort
```

BYOC runner 默认建议：

```txt
allowedDomains = source host + API host + model API host
allowAllUnixSockets = false
allowLocalBinding = false
```

如果使用 DeepSeek Anthropic-compatible endpoint：

```txt
api.deepseek.com
```

需要在 allowedDomains 里。

如果使用 Claude API：

```txt
api.anthropic.com
```

需要在 allowedDomains 里。

如果使用自托管 RCS：

```txt
rcs.example.com
```

也需要在 allowedDomains 里。

实现：

```ts
export function buildAllowedDomains(input: {
  streamUrl: string;
  sourceRemoteUrl: string;
  modelBaseUrl?: string;
  extra: string[];
}): string[] {
  return uniqueStrings([
    new URL(input.streamUrl).hostname,
    new URL(input.sourceRemoteUrl).hostname,
    input.modelBaseUrl ? new URL(input.modelBaseUrl).hostname : undefined,
    ...input.extra,
  ]);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}
```

不要默认允许任意网络。

如果某些构建任务需要联网，应该显式加域名。

## Command Audit

远程 runner 至少要记录：

```txt
sessionId
workId
toolName
permission mode
decision behavior
decision reason type
sandbox expected
sandbox actual
command hash
path class
duration
exit code
```

不要记录：

```txt
完整 command 中的 secret
完整 env
Authorization header
API key
token
```

实现：

```ts
export type CommandAuditEvent = {
  sessionId: string;
  workId: string;
  toolName: string;
  behavior: 'allow' | 'ask' | 'deny';
  reasonType?: string;
  permissionMode: PermissionMode;
  sandboxRequired: boolean;
  sandboxUsed?: boolean;
  commandHash?: string;
  path?: string;
  pathClass?: RemotePathClass;
  timestamp: string;
};
```

hash：

```ts
export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest).toString('hex');
}
```

这样能排查重复命令，而不泄漏命令内容。

## Runner Integration

第 54 章的 `buildChildEnv()` 要增加：

```ts
export function buildChildSecurityEnv(input: {
  secret: WorkSecretV2;
  policy: RemoteSecurityPolicy;
  effectiveMode: PermissionMode;
}): Record<string, string> {
  return {
    CLAUDE_CODE_REMOTE_PERMISSION_MODE: input.effectiveMode,
    CLAUDE_CODE_REMOTE_REQUIRE_SANDBOX: input.policy.requireSandbox
      ? '1'
      : '0',
    CLAUDE_CODE_REMOTE_ALLOW_UNSANDBOXED_COMMANDS:
      input.policy.allowUnsandboxedCommands ? '1' : '0',
    ...buildRemoteSandboxPolicyEnv(input.policy),
  };
}
```

child args 要加：

```ts
if (effectiveMode) {
  args.push('--permission-mode', effectiveMode);
}
```

如果 policy 要强制 `dontAsk`：

```txt
--permission-mode dontAsk
```

如果有 remote permission channel：

```txt
--permission-mode default
```

不要在没有 permission channel 的情况下用 `default` 然后让 child 等用户。

## Bridge Spawn Integration

现有 `src/bridge/sessionRunner.ts` 已经会给 child 设置：

```ts
const env: NodeJS.ProcessEnv = {
  ...deps.env,
  CLAUDE_CODE_ENVIRONMENT_KIND: 'bridge',
  ...(deps.sandbox && { CLAUDE_CODE_FORCE_SANDBOX: '1' }),
  CLAUDE_CODE_SESSION_ACCESS_TOKEN: opts.accessToken,
  CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2: '1',
  ...(opts.useCcrV2 && {
    CLAUDE_CODE_USE_CCR_V2: '1',
    CLAUDE_CODE_WORKER_EPOCH: String(opts.workerEpoch),
  }),
};
```

并给 args 加：

```ts
...(deps.permissionMode
  ? ['--permission-mode', deps.permissionMode]
  : [])
```

第 55 章建议把 BYOC runner 对齐这个模式：

```txt
env 传 remote / sandbox / token / ccr
args 传 permission mode
stdout 监听 control_request
stdin 写 control_response
```

也就是说，BYOC runner 不需要发明第二套权限协议。

复用 SDK control protocol。

## Sandbox Command Execution

BashTool 真正执行时：

```ts
const shellCommand = await exec(command, abortController.signal, 'bash', {
  timeout: timeoutMs,
  onProgress,
  preventCwdChanges,
  shouldUseSandbox: shouldUseSandbox(input),
  shouldAutoBackground,
});
```

这里 `shouldUseSandbox(input)` 是执行层最终决定。

Runner policy 应该在更早阶段校验：

```ts
const willUseSandbox = shouldUseSandbox(toolInput);
if (policy.requireSandbox && !willUseSandbox) {
  return {
    behavior: 'deny',
    message: 'Remote policy requires sandbox for Bash commands.',
    decisionReason: {
      type: 'sandboxOverride',
      reason: 'excludedCommand',
    },
  };
}
```

不要只依赖 shell exec 里包不包 sandbox。

因为 permission prompt 和审计也需要知道这个决定。

## Background Tasks

BashTool 支持：

```txt
run_in_background
auto background on timeout
assistant auto background
TaskOutput polling
```

远程 runner 需要限制后台任务数量。

原因：

```txt
headless session 可能积累长期进程
work complete 时子任务还在跑
capacity 判断可能失真
清理困难
```

Policy：

```ts
export function checkBackgroundPolicy(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  policy: RemoteSecurityPolicy;
  activeBackgroundTasks: number;
}): PermissionDecision | null {
  if (input.toolName !== 'Bash') {
    return null;
  }

  if (input.toolInput.run_in_background !== true) {
    return null;
  }

  if (input.activeBackgroundTasks >= input.policy.maxBackgroundTasks) {
    return {
      behavior: 'deny',
      message: 'Remote policy background task limit reached.',
      decisionReason: {
        type: 'other',
        reason: 'Background task limit reached',
      },
    };
  }

  return null;
}
```

Session 结束时必须：

```txt
停止 active background tasks
flush output
complete work
```

## Hooks

Permission pipeline 支持 PermissionRequest hooks。

远程场景下 hooks 是有价值的：

```txt
企业策略
项目本地安全规则
自动拒绝敏感路径
自动允许固定测试命令
```

但 hooks 不能成为绕过硬策略的方式。

顺序应该是：

```txt
hard policy deny
tool / path safety deny
permission hooks
remote UI ask
```

如果 hook allow 了：

```txt
仍不能覆盖 safetyCheck non-approvable
仍不能覆盖 policy forbid bypass
仍不能覆盖 sandbox required
```

Mini 可以在 hook 前运行：

```ts
const hardPolicy = checkHardRemotePolicy(...);
if (hardPolicy) return hardPolicy;
```

## Hard Policy Gate

把远程硬策略集中成一个函数：

```ts
export async function checkHardRemotePolicy(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  policy: RemoteSecurityPolicy;
  permissionMode: PermissionMode;
  activeBackgroundTasks: number;
}): Promise<PermissionDecision | null> {
  if (
    input.permissionMode === 'bypassPermissions' &&
    !input.policy.allowBypassPermissions
  ) {
    return {
      behavior: 'deny',
      message: 'Remote policy forbids bypassPermissions mode.',
      decisionReason: {
        type: 'mode',
        mode: input.permissionMode,
      },
    };
  }

  const sandboxOverride = checkRemoteSandboxOverride(input);
  if (sandboxOverride) {
    return sandboxOverride;
  }

  const background = checkBackgroundPolicy(input);
  if (background) {
    return background;
  }

  return null;
}
```

集中的好处：

```txt
测试简单
审计简单
不会散落在 BashTool / runner / bridge 多处
```

## Runner CanUseTool

远程 runner 可以封装一个 canUseTool：

```ts
export function createRemoteCanUseTool(input: {
  baseCanUseTool: CanUseToolFn;
  policy: RemoteSecurityPolicy;
  permissionMode: PermissionMode;
  remoteApproval?: RemoteApprovalClient;
  audit: (event: CommandAuditEvent) => void;
}): CanUseToolFn {
  return async (tool, toolInput, context, assistantMessage, toolUseID) => {
    const hard = await checkHardRemotePolicy({
      toolName: tool.name,
      toolInput,
      policy: input.policy,
      permissionMode: input.permissionMode,
      activeBackgroundTasks: countActiveBackgroundTasks(),
    });

    if (hard) {
      input.audit(toAuditEvent(tool, toolInput, hard, input));
      return hard;
    }

    const local = await input.baseCanUseTool(
      tool,
      toolInput,
      context,
      assistantMessage,
      toolUseID,
    );

    if (local.behavior !== 'ask') {
      input.audit(toAuditEvent(tool, toolInput, local, input));
      return local;
    }

    if (!input.remoteApproval) {
      const denied: PermissionDecision = {
        behavior: 'deny',
        message: 'Permission prompt is not available in this remote session.',
        decisionReason: {
          type: 'asyncAgent',
          reason: 'Remote permission channel is not available',
        },
      };
      input.audit(toAuditEvent(tool, toolInput, denied, input));
      return denied;
    }

    const remote = await input.remoteApproval.request({
      tool,
      input: toolInput,
      local,
      toolUseID,
    });

    input.audit(toAuditEvent(tool, toolInput, remote, input));
    return remote;
  };
}
```

原则：

```txt
hard policy 先跑
local pipeline 再跑
remote approval 只处理 ask
没有 remote approval 时 ask 变 deny
```

## Settings for Remote Child

BYOC child 启动前要保证 settings 生效。

可以生成 session-only settings：

```ts
export type RemoteSessionSettings = {
  permissions: {
    defaultMode: PermissionMode;
    allow: string[];
    deny: string[];
    ask: string[];
    additionalDirectories: string[];
  };
  sandbox: {
    enabled: boolean;
    failIfUnavailable: boolean;
    autoAllowBashIfSandboxed: boolean;
    allowUnsandboxedCommands: boolean;
    network: {
      allowedDomains: string[];
    };
    filesystem: {
      allowWrite: string[];
      denyWrite: string[];
      denyRead: string[];
    };
  };
};
```

构造：

```ts
export function buildRemoteSessionSettings(input: {
  policy: RemoteSecurityPolicy;
  mode: PermissionMode;
  repoDir: string;
  outputsDir: string;
  uploadsDir: string;
}): RemoteSessionSettings {
  return {
    permissions: {
      defaultMode: input.mode,
      allow: [],
      deny: [
        `Edit(${input.uploadsDir}/**)`,
      ],
      ask: [],
      additionalDirectories: [input.repoDir],
    },
    sandbox: {
      enabled: input.policy.requireSandbox,
      failIfUnavailable: input.policy.failIfSandboxUnavailable,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: input.policy.allowUnsandboxedCommands,
      network: {
        allowedDomains: input.policy.allowedNetworkDomains,
      },
      filesystem: {
        allowWrite: [input.repoDir, input.outputsDir],
        denyWrite: [input.uploadsDir, ...input.policy.deniedWriteRoots],
        denyRead: input.policy.deniedReadRoots,
      },
    },
  };
}
```

这个 settings 是 session-only。

不要持久化进用户全局设置。

## Secret Handling

安全策略里可能包含域名、路径，不应该包含密钥。

密钥仍然走第 54 章的 env injection：

```txt
CLAUDE_CODE_SESSION_ACCESS_TOKEN
ANTHROPIC_AUTH_TOKEN
```

但是审计和 settings 里不能写：

```txt
token
auth header
full env
```

统一 redaction：

```ts
export function redactSecurityEvent(
  event: Record<string, unknown>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    const lower = key.toLowerCase();
    if (
      lower.includes('token') ||
      lower.includes('secret') ||
      lower.includes('authorization') ||
      lower.includes('auth')
    ) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}
```

## Testing：Policy Normalization

测试：

```ts
import { describe, expect, test } from 'bun:test';
import {
  normalizeRemoteSecurityPolicy,
  resolveRemotePermissionMode,
} from '../securityPolicy.js';

describe('remote security policy', () => {
  test('removes bypass mode unless explicitly allowed', () => {
    const policy = normalizeRemoteSecurityPolicy({
      allowedPermissionModes: ['default', 'bypassPermissions'],
      allowBypassPermissions: false,
    });

    expect(policy.allowedPermissionModes).toEqual(['default']);
  });

  test('falls back to default mode when requested mode is not allowed', () => {
    const policy = normalizeRemoteSecurityPolicy({
      allowedPermissionModes: ['default'],
      defaultPermissionMode: 'default',
    });

    expect(
      resolveRemotePermissionMode({
        requestedMode: 'acceptEdits',
        policy,
      }),
    ).toBe('default');
  });
});
```

## Testing：Sandbox Required

测试：

```ts
import { describe, expect, test } from 'bun:test';
import { checkRemoteSandboxOverride } from '../remoteCanUseTool.js';

describe('remote sandbox override', () => {
  test('denies unsandboxed Bash when policy forbids it', () => {
    const result = checkRemoteSandboxOverride({
      toolName: 'Bash',
      toolInput: {
        command: 'git status',
        dangerouslyDisableSandbox: true,
      },
      policy: {
        ...DEFAULT_REMOTE_SECURITY_POLICY,
        allowUnsandboxedCommands: false,
      },
    });

    expect(result?.behavior).toBe('deny');
  });

  test('ignores non-Bash tools', () => {
    const result = checkRemoteSandboxOverride({
      toolName: 'Read',
      toolInput: { file_path: '/tmp/a.txt' },
      policy: DEFAULT_REMOTE_SECURITY_POLICY,
    });

    expect(result).toBeNull();
  });
});
```

## Testing：Path Classification

测试：

```ts
import { describe, expect, test } from 'bun:test';
import { classifyRemotePath } from '../remotePaths.js';

describe('classifyRemotePath', () => {
  const layout = {
    runnerRoot: '/runner',
    sessionDir: '/runner/environments/env/sessions/sess',
    repoDir: '/runner/environments/env/sessions/sess/repo',
    uploadsDir: '/runner/environments/env/sessions/sess/repo/sess/uploads',
    outputsDir:
      '/runner/environments/env/sessions/sess/repo/sess/.claude-code/outputs',
  };

  test('classifies repo paths', () => {
    expect(
      classifyRemotePath({
        ...layout,
        path: '/runner/environments/env/sessions/sess/repo/src/index.ts',
      }),
    ).toBe('repo');
  });

  test('classifies uploads as session_uploads', () => {
    expect(
      classifyRemotePath({
        ...layout,
        path: '/runner/environments/env/sessions/sess/repo/sess/uploads/a.txt',
      }),
    ).toBe('session_uploads');
  });

  test('blocks other sessions', () => {
    expect(
      classifyRemotePath({
        ...layout,
        path: '/runner/environments/env/sessions/other/repo/a.txt',
      }),
    ).toBe('other_session');
  });
});
```

## Testing：Dangerous Paths

测试：

```ts
import { describe, expect, test } from 'bun:test';
import { hasSuspiciousPathPattern } from '../remotePaths.js';

describe('hasSuspiciousPathPattern', () => {
  test('detects UNC paths', () => {
    expect(hasSuspiciousPathPattern('//server/share/file')).toBe(true);
  });

  test('detects short names', () => {
    expect(hasSuspiciousPathPattern('/repo/GIT~1/config')).toBe(true);
  });

  test('allows normal repo paths', () => {
    expect(hasSuspiciousPathPattern('/repo/src/index.ts')).toBe(false);
  });
});
```

## Testing：Headless Ask

测试没有 remote approval 时 ask 变 deny：

```ts
import { describe, expect, test } from 'bun:test';
import { createRemoteCanUseTool } from '../remoteCanUseTool.js';

describe('createRemoteCanUseTool', () => {
  test('denies ask when no remote approval channel exists', async () => {
    const canUseTool = createRemoteCanUseTool({
      policy: DEFAULT_REMOTE_SECURITY_POLICY,
      permissionMode: 'default',
      baseCanUseTool: async () => ({
        behavior: 'ask',
        message: 'needs approval',
      }),
      audit: () => {},
    });

    const result = await canUseTool(
      fakeTool('Bash'),
      { command: 'git status' },
      fakeContext(),
      fakeAssistantMessage(),
      'toolu_1',
    );

    expect(result.behavior).toBe('deny');
  });
});
```

## Testing：Remote Approval Cannot Override Deny

测试：

```ts
import { describe, expect, test } from 'bun:test';

describe('remote approval', () => {
  test('does not ask remote client after local deny', async () => {
    let remoteCalled = false;

    const result = await remoteCanUseTool({
      localDecision: {
        behavior: 'deny',
        message: 'denied locally',
        decisionReason: {
          type: 'other',
          reason: 'local policy',
        },
      },
      requestRemote: async () => {
        remoteCalled = true;
        return { behavior: 'allow', updatedInput: {} };
      },
    });

    expect(result.behavior).toBe('deny');
    expect(remoteCalled).toBe(false);
  });
});
```

## Testing：Bash Compound Deny

测试：

```ts
import { describe, expect, test } from 'bun:test';
import { checkCompoundDeny } from '../bashPolicy.js';

describe('checkCompoundDeny', () => {
  test('denies dangerous subcommand in compound command', () => {
    const result = checkCompoundDeny({
      command: 'echo ok && rm -rf target',
      context: contextWithDenyRule('Bash(rm:*)'),
    });

    expect(result?.behavior).toBe('deny');
  });
});
```

## Manual Validation

查看 sandbox 设置：

```bash
bun run src/entrypoints/cli.tsx /sandbox
```

远程 bridge 开 sandbox：

```bash
bun run src/entrypoints/cli.tsx bridge --sandbox --permission-mode default
```

BYOC runner 单次测试：

```bash
FEATURE_BYOC_ENVIRONMENT_RUNNER=1 bun run src/entrypoints/cli.tsx environment-runner --secret-file /tmp/work-secret.json --workspace-root /tmp/cc-runner --once
```

测试权限与沙箱相关模块：

```bash
bun test src/utils/permissions src/utils/sandbox packages/builtin-tools/src/tools/BashTool
```

类型检查：

```bash
bun run typecheck
```

注意：

```txt
/tmp/work-secret.json 不要放长期密钥。
测试远程策略时优先使用 mock token。
```

## Debug Checklist

### sandbox 没生效

检查：

```txt
sandbox.enabled
sandbox dependencies
enabledPlatforms
CLAUDE_CODE_FORCE_SANDBOX
shouldUseSandbox(input)
dangerouslyDisableSandbox
excludedCommands
```

远程模式如果 require sandbox，任何一项导致不启用都应失败。

### Bash 被意外放行

检查：

```txt
deny rule 是否在 allow 前
compound command 是否拆分
env var prefix 是否剥离用于 deny
wrapper 是否剥离
sandbox auto-allow 是否尊重 ask / deny
```

### Bash 被意外询问

检查：

```txt
命令是否 too complex
是否命中 ask rule
是否有 redirection
是否有 cd + write
是否命中 dangerous path
是否 sandbox 不可用
```

### FileEdit 被意外允许

检查：

```txt
path 是否在 working directory
是否 acceptEdits
是否命中 session allow
是否 safetyCheck 在 allow 前执行
symlink resolved path 是否检查
```

### FileRead 读不到附件

检查：

```txt
uploads dir 是否在 child cwd 下
Read deny rule 是否覆盖
additionalWorkingDirectories 是否包含 repoDir
路径是否被识别成 UNC / suspicious path
```

### 远程权限一直挂起

检查：

```txt
child 是否输出 control_request
bridge 是否监听 stdout
remote UI 是否收到 request_id
control_response 是否写回 child stdin
request_id 是否一致
```

没有 remote approval channel 时，不应该挂起。

应该 deny。

### bypassPermissions 生效了

检查：

```txt
policy.allowBypassPermissions
isBypassPermissionsModeAvailable
requestedMode
effectiveMode
plan mode 是否继承 bypass availability
```

远程默认应该禁止。

### 输出文件没上传

检查：

```txt
outputs 路径是否在 session outputs dir
sandbox allowWrite 是否包含 outputs dir
CLAUDE_CODE_ENVIRONMENT_KIND=byoc
FILE_PERSISTENCE feature
```

## 和官方能力的差距

本章 Mini 已经补上远程安全主体，但和官方仍有差距：

| 能力 | 本章 Mini | 更完整实现 |
| --- | --- | --- |
| Permission pipeline | 保留核心顺序 | 全量 hooks、classifier、UI suggestions |
| Bash parse | 保守解析 | tree-sitter AST、安全语义分析 |
| Bash rules | deny / ask / allow | prefix、wildcard、wrapper、operator 全覆盖 |
| Sandbox | settings -> runtime | 平台专用隔离、网络代理、违规事件 |
| Network | domain allowlist | per-tool network policy、动态请求确认 |
| File safety | dangerous path + root | symlink 全解析、平台特殊路径全集 |
| Remote approval | control request | 多端竞态、取消、超时、审计 |
| Headless | ask -> deny | hooks / classifier / policy service |
| Audit | 本地事件 | structured trace、server-side join |
| BYOC policy | Work Secret policy | 签名策略、组织级 managed policy |

但从目标看，本章补齐了接近官方 Claude Code 必须有的安全边界：

```txt
权限先判定
沙箱再限制
远程策略强制收窄
headless 不悬挂
deny 不被 allow 覆盖
危险路径不被 mode 绕过
```

## 本章小结

第 55 章把第 54 章的远程执行能力加上了安全控制面。

核心链路是：

```txt
remote work
  -> security policy normalize
  -> permission mode resolve
  -> child env / settings
  -> canUseTool hard policy
  -> permission pipeline
  -> remote approval if needed
  -> sandbox-wrapped Bash
  -> file path safety
  -> audit
```

本章最重要的原则：

```txt
remote policy 只能收窄权限，不能扩大权限。
deny / safetyCheck 必须早于 bypass。
ask 在 headless 下必须转发或拒绝，不能悬挂。
sandbox auto-allow 仍然要尊重 explicit deny / ask。
dangerouslyDisableSandbox 必须受 policy 控制。
workspace root 不能等于 runner root。
uploads 默认只读，outputs 默认可写。
```

到这里，Mini 已经不只是能远程执行，而是能按明确策略远程执行。

下一章可以继续补 **工具审计、会话事件追踪与安全可观测性**：把 permission、sandbox、command、file persistence、CCR v2 事件串成一条可排查的 timeline。
