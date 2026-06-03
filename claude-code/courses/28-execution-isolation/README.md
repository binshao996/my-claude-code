# 第 28 章：执行隔离与 Sandbox Runtime

第二十七章把权限规则和审计补齐了。现在每次工具调用都会先问：

```text
这个工具能不能执行？
```

但权限通过不等于执行安全。

例如用户允许了：

```text
Bash(bun test *)
```

命令执行时仍然可能发生这些问题：

- 测试脚本写入仓库外路径。
- 子进程访问网络。
- 命令卡住不退出。
- 输出无限增长。
- 进程退出后留下临时文件或后台子进程。
- MCP stdio server 没有被正确关闭。

第十四章已经做过应用层 sandbox：路径边界、命令分类、超时和输出截断。那一章的目标是“工具调用前有策略层”。

本章继续升级：把 Shell、文件写入和 MCP 调用放进统一的执行隔离运行时。权限负责决策，Sandbox Runtime 负责约束执行环境。

## 真实工程怎么做

真实工程的执行隔离主要分布在：

- `src/utils/sandbox/sandbox-adapter.ts`：把设置、权限规则、平台能力转换成 sandbox runtime 配置。
- `src/utils/Shell.ts`：Bash/PowerShell 执行器，执行前调用 `SandboxManager.wrapWithSandbox()`。
- `packages/builtin-tools/src/tools/BashTool/shouldUseSandbox.ts`：判断单条命令是否应该进入 sandbox。
- `packages/builtin-tools/src/tools/BashTool/bashPermissions.ts`：sandbox auto-allow 逻辑，但显式 deny/ask 仍然优先。
- `packages/builtin-tools/src/tools/BashTool/BashTool.tsx`：命令执行后把 sandbox violation 注入结果。
- `src/services/mcp/client.ts`：MCP stdio server 连接、调用、abort、关闭和信号升级。
- `src/utils/combinedAbortSignal.ts`：组合用户取消、超时和上游 abort。

真实工程有几个关键设计：

1. sandbox 配置从权限规则和 settings 派生，不是单独维护一套安全配置。
2. Bash 默认尽量运行在 sandbox 内，只有策略允许时才可显式绕过。
3. sandbox auto-allow 只在命令确实进入 sandbox 时生效，并且不能覆盖显式 deny/ask。
4. 文件写入的 allow/deny 路径会进入 runtime 的文件系统规则。
5. 网络域名规则会进入 runtime 的网络规则。
6. 命令输出落盘时要防 symlink 攻击。
7. abort 不只是停止等待，还要终止子进程。
8. MCP stdio server 关闭时要按 `SIGINT -> SIGTERM -> SIGKILL` 升级。

Mini 不需要一次实现真实工程所有平台细节，但架构要和真实工程保持同一个方向。

## 本章目标

完成后，Mini 应该具备：

- `sandbox.enabled` 配置。
- sandbox runtime 初始化和依赖检查。
- 从权限规则生成文件系统 allow/deny。
- 从 WebFetch 规则生成网络 allow/deny。
- Bash 执行前自动包装 sandbox。
- Bash 执行时支持 timeout、abort 和输出上限。
- Bash 执行后清理 sandbox 副产物。
- sandbox violation 写入工具结果和审计事件。
- sandbox auto-allow，但显式 deny/ask 优先。
- MCP stdio server 有调用超时、abort 和进程关闭升级。
- sandbox 不可用时按配置选择警告或失败。

## 安装依赖

真实工程使用 `@anthropic-ai/sandbox-runtime`。Mini 这一章也直接使用它：

```bash
bun add @anthropic-ai/sandbox-runtime
```

然后继续做类型检查：

```bash
bun run typecheck
```

如果你的环境暂时不支持 runtime 的系统依赖，本章仍然要保留 adapter 抽象，让 Mini 能明确提示“sandbox 不可用”，而不是静默裸跑。

## 推荐目录

新增：

```text
src/isolation/
  sandboxTypes.ts
  sandboxSettings.ts
  sandboxConfig.ts
  sandboxManager.ts
  shouldUseSandbox.ts
  isolatedShell.ts
  processRunner.ts
  mcpProcessRuntime.ts
  sandboxAudit.ts

src/commands/
  sandboxCommand.ts
```

修改：

```text
src/tools/bashTool.ts
src/tools/toolRunner.ts
src/tools/fileTools.ts
src/mcp/mcpClient.ts
src/mcp/mcpManager.ts
src/permissions/permissionEngine.ts
src/transcript/types.ts
```

本章不要把 sandbox 逻辑直接塞进 BashTool。BashTool 只负责声明输入、权限和渲染；执行隔离放在 `src/isolation/`。

## 配置类型

先定义 Mini 的 sandbox 配置：

```ts
// src/isolation/sandboxTypes.ts
export type SandboxFilesystemConfig = {
  allowRead?: string[];
  denyRead?: string[];
  allowWrite?: string[];
  denyWrite?: string[];
};

export type SandboxNetworkConfig = {
  allowedDomains?: string[];
  deniedDomains?: string[];
  allowLocalhost?: boolean;
  allowUnixSockets?: string[];
};

export type SandboxSettings = {
  enabled?: boolean;
  failIfUnavailable?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  allowUnsandboxedCommands?: boolean;
  excludedCommands?: string[];
  filesystem?: SandboxFilesystemConfig;
  network?: SandboxNetworkConfig;
};

export type SandboxRuntimeStatus =
  | { type: "disabled" }
  | { type: "ready" }
  | { type: "unavailable"; reason: string; errors: string[]; warnings: string[] };

export type SandboxExecutionMeta = {
  requested: boolean;
  used: boolean;
  unavailableReason?: string;
  violations?: SandboxViolation[];
};

export type SandboxViolation = {
  kind: "filesystem" | "network" | "process" | "unknown";
  message: string;
  path?: string;
  host?: string;
};
```

`enabled` 表示用户希望启用 sandbox；`ready` 表示 runtime 实际可用。两者不能混为一谈。

## Settings

把 settings 扩展为：

```ts
// src/settings/settingsTypes.ts
import type { SandboxSettings } from "../isolation/sandboxTypes";

export type MiniSettings = {
  permissions?: {
    allow?: string[];
    ask?: string[];
    deny?: string[];
  };
  sandbox?: SandboxSettings;
};
```

示例配置：

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": false,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": false,
    "filesystem": {
      "allowWrite": ["."],
      "denyWrite": [".git/**", ".claude/**", ".env", ".env.*"]
    },
    "network": {
      "allowedDomains": ["api.deepseek.com"],
      "deniedDomains": ["*"]
    }
  },
  "permissions": {
    "allow": ["Edit(src/**)", "Bash(bun test *)"],
    "deny": ["Bash(rm *)"]
  }
}
```

注意：配置里的 sandbox 不是替代 permissions。permissions 决定能不能尝试执行，sandbox 限制执行时能碰什么。

## 生成 Runtime 配置

真实工程会从 settings 和 permission rules 生成 runtime config。Mini 也这么做：

```ts
// src/isolation/sandboxConfig.ts
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { MiniSettings } from "../settings/settingsTypes";
import { parsePermissionRule } from "../permissions/permissionRuleParser";

export function buildSandboxRuntimeConfig(settings: MiniSettings): SandboxRuntimeConfig {
  const sandbox = settings.sandbox ?? {};
  const permissions = settings.permissions ?? {};

  const allowWrite = new Set<string>(["."]);
  const denyWrite = new Set<string>([
    ".git/**",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/skills/**",
    ".env",
    ".env.*",
  ]);
  const allowRead = new Set<string>();
  const denyRead = new Set<string>();
  const allowedDomains = new Set<string>();
  const deniedDomains = new Set<string>();

  for (const path of sandbox.filesystem?.allowWrite ?? []) allowWrite.add(path);
  for (const path of sandbox.filesystem?.denyWrite ?? []) denyWrite.add(path);
  for (const path of sandbox.filesystem?.allowRead ?? []) allowRead.add(path);
  for (const path of sandbox.filesystem?.denyRead ?? []) denyRead.add(path);

  for (const domain of sandbox.network?.allowedDomains ?? []) allowedDomains.add(domain);
  for (const domain of sandbox.network?.deniedDomains ?? []) deniedDomains.add(domain);

  for (const rawRule of permissions.allow ?? []) {
    const rule = parsePermissionRule(rawRule);
    if (rule.toolName === "Edit" || rule.toolName === "Write") {
      if (rule.ruleContent) allowWrite.add(rule.ruleContent);
    }
    if (rule.toolName === "WebFetch" && rule.ruleContent?.startsWith("domain:")) {
      allowedDomains.add(rule.ruleContent.slice("domain:".length));
    }
  }

  for (const rawRule of permissions.deny ?? []) {
    const rule = parsePermissionRule(rawRule);
    if (rule.toolName === "Edit" || rule.toolName === "Write") {
      if (rule.ruleContent) denyWrite.add(rule.ruleContent);
    }
    if (rule.toolName === "Read") {
      if (rule.ruleContent) denyRead.add(rule.ruleContent);
    }
    if (rule.toolName === "WebFetch" && rule.ruleContent?.startsWith("domain:")) {
      deniedDomains.add(rule.ruleContent.slice("domain:".length));
    }
  }

  return {
    filesystem: {
      allowRead: [...allowRead],
      denyRead: [...denyRead],
      allowWrite: [...allowWrite],
      denyWrite: [...denyWrite],
    },
    network: {
      allowedDomains: [...allowedDomains],
      deniedDomains: [...deniedDomains],
      allowLocalBinding: sandbox.network?.allowLocalhost,
      allowUnixSockets: sandbox.network?.allowUnixSockets,
    },
  };
}
```

几个默认 deny 很重要：

- `.git/**`：避免命令直接破坏 Git 元数据。
- `.claude/settings*.json`：避免模型修改自己的安全配置。
- `.claude/skills/**`：skill 会被自动加载，属于高权限入口。
- `.env*`：避免误写或泄漏本地环境配置。

真实工程还会处理 worktree 主仓库、额外工作目录、ripgrep 配置、Linux glob 限制等。Mini 先保留主干。

## Sandbox Manager

封装 runtime，统一处理初始化、不可用提示和配置刷新：

```ts
// src/isolation/sandboxManager.ts
import {
  SandboxManager as BaseSandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import type { MiniSettings } from "../settings/settingsTypes";
import type { SandboxRuntimeStatus } from "./sandboxTypes";
import { buildSandboxRuntimeConfig } from "./sandboxConfig";

export class MiniSandboxManager {
  private initialized = false;
  private status: SandboxRuntimeStatus = { type: "disabled" };
  private config: SandboxRuntimeConfig | undefined;

  constructor(private settings: MiniSettings) {}

  getStatus(): SandboxRuntimeStatus {
    return this.status;
  }

  isEnabled(): boolean {
    return this.settings.sandbox?.enabled === true;
  }

  isReady(): boolean {
    return this.status.type === "ready";
  }

  autoAllowBashIfSandboxed(): boolean {
    return this.settings.sandbox?.autoAllowBashIfSandboxed ?? true;
  }

  allowUnsandboxedCommands(): boolean {
    return this.settings.sandbox?.allowUnsandboxedCommands ?? false;
  }

  getExcludedCommands(): string[] {
    return this.settings.sandbox?.excludedCommands ?? [];
  }

  async initialize(): Promise<SandboxRuntimeStatus> {
    if (!this.isEnabled()) {
      this.status = { type: "disabled" };
      return this.status;
    }

    const dependencyCheck = BaseSandboxManager.checkDependencies();
    if (dependencyCheck.errors.length > 0) {
      this.status = {
        type: "unavailable",
        reason: `Sandbox dependencies are missing: ${dependencyCheck.errors.join(", ")}`,
        errors: dependencyCheck.errors,
        warnings: dependencyCheck.warnings,
      };

      if (this.settings.sandbox?.failIfUnavailable) {
        throw new Error(this.status.reason);
      }

      return this.status;
    }

    this.config = buildSandboxRuntimeConfig(this.settings);
    await BaseSandboxManager.initialize(this.config);
    this.initialized = true;
    this.status = { type: "ready" };
    return this.status;
  }

  refresh(settings: MiniSettings): void {
    this.settings = settings;

    if (!this.initialized || !this.isEnabled()) {
      return;
    }

    this.config = buildSandboxRuntimeConfig(settings);
    BaseSandboxManager.updateConfig(this.config);
  }

  async wrapCommand(command: string, shellPath: string, signal: AbortSignal): Promise<string> {
    if (!this.isReady()) {
      return command;
    }

    return BaseSandboxManager.wrapWithSandbox(command, shellPath, this.config, signal);
  }

  cleanupAfterCommand(): void {
    if (!this.isReady()) {
      return;
    }

    BaseSandboxManager.cleanupAfterCommand();
  }

  annotateViolations(command: string, output: string): string {
    if (!this.isReady()) {
      return output;
    }

    return BaseSandboxManager.annotateStderrWithSandboxFailures(command, output);
  }
}
```

这里有一个工程原则：如果用户显式开启了 sandbox，但 runtime 不可用，必须让用户看到原因。不要因为依赖缺失就静默变成裸执行。

## 判断是否使用 Sandbox

不是每条命令都能进 sandbox。真实工程里有 `dangerouslyDisableSandbox`、excluded commands、策略锁定等逻辑。

Mini 先实现：

```ts
// src/isolation/shouldUseSandbox.ts
import type { MiniSandboxManager } from "./sandboxManager";
import { matchWildcard } from "../utils/matchWildcard";

export type SandboxableCommandInput = {
  command?: string;
  dangerouslyDisableSandbox?: boolean;
};

export function shouldUseSandbox(
  input: SandboxableCommandInput,
  sandbox: MiniSandboxManager,
): boolean {
  if (!sandbox.isReady()) {
    return false;
  }

  if (!input.command) {
    return false;
  }

  if (input.dangerouslyDisableSandbox && sandbox.allowUnsandboxedCommands()) {
    return false;
  }

  for (const pattern of sandbox.getExcludedCommands()) {
    if (matchWildcard(pattern, input.command)) {
      return false;
    }
  }

  return true;
}
```

`excludedCommands` 是便利功能，不是安全边界。安全边界仍然是权限 deny、sandbox runtime 和系统级限制。

## 进程执行器

第十四章已经做过简单 shell 执行。这里升级成可复用 `ProcessRunner`：

```ts
// src/isolation/processRunner.ts
import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type ProcessRunOptions = {
  cmd: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  signal: AbortSignal;
  outputDir: string;
  maxOutputBytes: number;
};

export type ProcessRunResult = {
  code: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputPath: string;
};

export async function runProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  await mkdir(options.outputDir, { recursive: true, mode: 0o700 });

  const outputPath = join(options.outputDir, `${randomUUID()}.log`);
  const outputHandle = await open(
    outputPath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_APPEND |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), options.timeoutMs);
  const abort = () => controller.abort("aborted");
  options.signal.addEventListener("abort", abort, { once: true });

  let timedOut = false;

  try {
    const child = spawn(options.cmd[0]!, options.cmd.slice(1), {
      cwd: options.cwd,
      env: sanitizeEnv(options.env),
      stdio: ["ignore", outputHandle.fd, outputHandle.fd],
      windowsHide: true,
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const abortChild = () => {
        timedOut = controller.signal.reason === "timeout";
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 500).unref();
      };

      controller.signal.addEventListener("abort", abortChild, { once: true });
      child.once("error", reject);
      child.once("close", (code) => {
        controller.signal.removeEventListener("abort", abortChild);
        resolve(code);
      });
    });

    const stdout = await readTruncated(outputPath, options.maxOutputBytes);

    return {
      code: exitCode,
      stdout,
      stderr: "",
      timedOut,
      outputPath,
    };
  } catch (error) {
    const stdout = await readTruncated(outputPath, options.maxOutputBytes).catch(() => "");
    return {
      code: null,
      stdout,
      stderr: error instanceof Error ? error.message : String(error),
      timedOut,
      outputPath,
    };
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
    await outputHandle.close().catch(() => {});
  }
}

function sanitizeEnv(env: Record<string, string | undefined> | undefined): Record<string, string> {
  const safe: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    CI: process.env.CI ?? "",
    CLAUDECODE: "1",
  };

  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) {
      safe[key] = value;
    }
  }

  return safe;
}

async function readTruncated(path: string, maxBytes: number): Promise<string> {
  const file = Bun.file(path);
  const size = file.size;
  const bytes = await file.slice(0, Math.min(size, maxBytes)).arrayBuffer();
  const text = new TextDecoder().decode(bytes);

  if (size > maxBytes) {
    return `${text}\n[output truncated: ${size - maxBytes} bytes omitted]`;
  }

  return text;
}
```

几个细节：

- 输出写到文件，而不是无限保存在内存。
- 文件用 `O_NOFOLLOW`，避免输出路径被 symlink 劫持。
- `timeout` 和外部 `AbortSignal` 都能中断执行。
- 环境变量使用 allowlist 起步，避免无意传入敏感变量。

如果你的运行时版本不支持某些 fd 选项，可以在 `processRunner` 内部做兼容，但不要让 Tool 直接关心这些细节。

## Shell 隔离执行

把 BashTool 执行接到 sandbox manager：

```ts
// src/isolation/isolatedShell.ts
import type { MiniSandboxManager } from "./sandboxManager";
import { shouldUseSandbox } from "./shouldUseSandbox";
import { runProcess } from "./processRunner";

export type IsolatedShellInput = {
  command: string;
  timeoutMs?: number;
  dangerouslyDisableSandbox?: boolean;
};

export type IsolatedShellResult = {
  code: number | null;
  output: string;
  timedOut: boolean;
  sandbox: {
    requested: boolean;
    used: boolean;
    unavailableReason?: string;
  };
};

export async function runIsolatedShell(params: {
  input: IsolatedShellInput;
  cwd: string;
  sandbox: MiniSandboxManager;
  signal: AbortSignal;
  outputDir: string;
}): Promise<IsolatedShellResult> {
  const requested = params.sandbox.isEnabled();
  const used = shouldUseSandbox(params.input, params.sandbox);
  const shellPath = process.env.SHELL || "/bin/bash";
  const rawCommand = params.input.command;
  const command = used
    ? await params.sandbox.wrapCommand(rawCommand, shellPath, params.signal)
    : rawCommand;

  const result = await runProcess({
    cmd: [shellPath, "-lc", command],
    cwd: params.cwd,
    timeoutMs: params.input.timeoutMs ?? 120_000,
    signal: params.signal,
    outputDir: params.outputDir,
    maxOutputBytes: 256_000,
  });

  if (used) {
    params.sandbox.cleanupAfterCommand();
  }

  const output = used
    ? params.sandbox.annotateViolations(rawCommand, result.stdout)
    : result.stdout;

  return {
    code: result.code,
    output,
    timedOut: result.timedOut,
    sandbox: {
      requested,
      used,
      unavailableReason:
        requested && !used && params.sandbox.getStatus().type === "unavailable"
          ? params.sandbox.getStatus().reason
          : undefined,
    },
  };
}
```

这里要区分：

- `requested`：用户开启了 sandbox。
- `used`：这条命令实际进了 sandbox。

审计和 UI 都应该展示这两个字段。用户开启了 sandbox 但命令实际裸跑，是必须可见的风险。

## BashTool 接入

BashTool 不再直接 `Bun.spawn`：

```ts
// src/tools/bashTool.ts
import { runIsolatedShell } from "../isolation/isolatedShell";

export const BashTool: ToolDefinition = {
  name: "Bash",
  description: "Run a shell command",
  inputSchema: {},
  async checkPermissions(input, context) {
    return checkBashPermission(input, context);
  },
  async execute(input, context) {
    const command = String(input.command ?? "");
    const timeoutMs =
      typeof input.timeoutMs === "number" ? input.timeoutMs : undefined;

    const result = await runIsolatedShell({
      input: {
        command,
        timeoutMs,
        dangerouslyDisableSandbox: input.dangerouslyDisableSandbox === true,
      },
      cwd: context.cwd,
      sandbox: context.sandbox,
      signal: context.abortController.signal,
      outputDir: context.outputDir,
    });

    return {
      ok: result.code === 0,
      data: {
        code: result.code,
        output: result.output,
        timedOut: result.timedOut,
        sandbox: result.sandbox,
      },
    };
  },
};
```

Tool 的 `execute` 需要拿到更丰富的 context：

```ts
// src/tools/toolTypes.ts
import type { MiniSandboxManager } from "../isolation/sandboxManager";

export type ToolExecutionContext = {
  cwd: string;
  outputDir: string;
  abortController: AbortController;
  sandbox: MiniSandboxManager;
};
```

这样后面 FileTool、MCPTool、WebFetchTool 都能复用同一套执行上下文。

## Sandbox Auto-Allow

第 27 章的权限默认会把未知 Bash 调用变成 ask。启用 sandbox 后，可以做一个受控优化：

```text
如果命令会进入 sandbox，并且没有显式 deny/ask，则允许执行。
```

在权限引擎里增加：

```ts
// src/permissions/permissionEngine.ts
import { shouldUseSandbox } from "../isolation/shouldUseSandbox";

async function maybeAllowSandboxedBash(request: PermissionCheckRequest): Promise<PermissionDecision | undefined> {
  if (request.tool.name !== "Bash") {
    return undefined;
  }

  if (!request.context.sandbox.autoAllowBashIfSandboxed()) {
    return undefined;
  }

  const input = {
    command: String(request.input.command ?? ""),
    dangerouslyDisableSandbox: request.input.dangerouslyDisableSandbox === true,
  };

  if (!shouldUseSandbox(input, request.context.sandbox)) {
    return undefined;
  }

  const denyRule = await findMatchingRule({
    context: request.context,
    behavior: "deny",
    tool: request.tool,
    input: request.input,
  });
  if (denyRule) {
    return undefined;
  }

  const askRule = await findMatchingRule({
    context: request.context,
    behavior: "ask",
    tool: request.tool,
    input: request.input,
  });
  if (askRule) {
    return undefined;
  }

  return {
    behavior: "allow",
    updatedInput: request.input,
    reason: {
      type: "other",
      reason: "Auto-allowed because Bash will run inside sandbox.",
    },
  };
}
```

然后在常规默认 ask 之前调用它。

注意：auto-allow 不应该绕过：

- deny rule。
- ask rule。
- 工具自己的安全 deny。
- `dangerouslyDisableSandbox` 导致的裸跑。
- sandbox 不可用。

## 文件写入仍要做应用层边界

sandbox runtime 能限制子进程，但 Mini 自己的 FileWriteTool 是主进程直接写文件。主进程写文件不能只依赖 shell sandbox。

所以文件工具仍然要保留第 14 章和第 27 章的边界：

```ts
// src/tools/fileTools.ts
import { writeFile } from "node:fs/promises";
import { resolveWorkspacePath } from "../sandbox/path";

export async function writeFileTool(input: ToolInput, context: ToolExecutionContext) {
  const target = resolveWorkspacePath(context.cwd, String(input.file_path ?? ""));

  await assertPathAllowedByPermissions(target, context.permissions);
  await assertPathAllowedBySandboxSettings(target, context.sandbox);

  await writeFile(target, String(input.content ?? ""), "utf8");

  return {
    ok: true,
    data: { filePath: target },
  };
}
```

这里有一个容易混淆的点：

- Bash 里的写入，由 sandbox runtime 约束。
- Mini 主进程的写入，由应用层路径检查约束。

两者都需要。

## MCP 调用隔离

MCP 有两层隔离：

1. MCP server 进程生命周期隔离。
2. MCP tool 调用的 timeout、abort 和进度控制。

第二十六章已经能启动 stdio server。现在把它升级成 runtime：

```ts
// src/isolation/mcpProcessRuntime.ts
export type McpProcessHandle = {
  pid?: number;
  close(): Promise<void>;
};

export async function closeMcpProcess(handle: McpProcessHandle): Promise<void> {
  if (!handle.pid) {
    await handle.close();
    return;
  }

  await sendSignalAndWait(handle.pid, "SIGINT", 100);
  if (!(await isProcessAlive(handle.pid))) {
    await handle.close();
    return;
  }

  await sendSignalAndWait(handle.pid, "SIGTERM", 400);
  if (!(await isProcessAlive(handle.pid))) {
    await handle.close();
    return;
  }

  await sendSignalAndWait(handle.pid, "SIGKILL", 100);
  await handle.close();
}

async function sendSignalAndWait(pid: number, signal: NodeJS.Signals, waitMs: number): Promise<void> {
  try {
    process.kill(pid, signal);
  } catch {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

调用 MCP tool 时组合 timeout 和用户取消：

```ts
// src/mcp/mcpClient.ts
import { createCombinedSignal } from "../utils/createCombinedSignal";

export async function callMcpTool(params: {
  client: McpClient;
  name: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
  timeoutMs?: number;
}) {
  const { signal, cleanup } = createCombinedSignal(params.signal, {
    timeoutMs: params.timeoutMs ?? 120_000,
  });

  try {
    return await params.client.callTool(
      {
        name: params.name,
        arguments: params.args,
      },
      { signal },
    );
  } finally {
    cleanup();
  }
}
```

MCP tool 默认仍然走第 27 章权限。这里的 timeout 和 abort 只是执行隔离，不是授权。

## 组合 AbortSignal

不要直接到处写 `AbortSignal.timeout()`。真实工程里专门做了组合 signal，是因为 timeout signal 的生命周期不好统一清理。

Mini 可以这样写：

```ts
// src/utils/createCombinedSignal.ts
export function createCombinedSignal(
  parent: AbortSignal | undefined,
  options: { timeoutMs?: number } = {},
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();

  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(parent?.reason ?? "aborted");
    }
  };

  parent?.addEventListener("abort", abort);

  const timeout =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          if (!controller.signal.aborted) {
            controller.abort("timeout");
          }
        }, options.timeoutMs);

  return {
    signal: controller.signal,
    cleanup() {
      parent?.removeEventListener("abort", abort);
      if (timeout) clearTimeout(timeout);
    },
  };
}
```

所有长耗时执行都用这个工具：

- Bash。
- MCP tool call。
- hook。
- background task。
- 外部 HTTP 请求。

## Sandbox 审计

第 27 章已经记录权限决策。现在补执行隔离事件：

```ts
// src/isolation/sandboxAudit.ts
import { recordTranscriptEvent } from "../transcript/store";
import type { SandboxExecutionMeta } from "./sandboxTypes";

export async function recordSandboxExecution(input: {
  sessionId: string;
  toolUseId: string;
  toolName: string;
  command?: string;
  meta: SandboxExecutionMeta;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs: number;
}): Promise<void> {
  await recordTranscriptEvent({
    event: "sandbox_execution",
    data: {
      type: "sandbox_execution",
      sessionId: input.sessionId,
      toolUseId: input.toolUseId,
      toolName: input.toolName,
      command: input.command,
      sandbox: input.meta,
      exitCode: input.exitCode,
      timedOut: input.timedOut,
      durationMs: input.durationMs,
      createdAt: new Date().toISOString(),
    },
  });
}
```

同时扩展 transcript event 类型：

```ts
// src/transcript/types.ts
export type TranscriptEventName =
  | "permission_decision"
  | "sandbox_execution"
  | "mcp_process_closed"
  | "tool_result";
```

审计里至少要能看出：

- sandbox 是否开启。
- sandbox 是否实际使用。
- 没使用的原因。
- 是否超时。
- 是否有 violation。

## `/sandbox` 命令

加一个本地命令，方便查看状态：

```text
/sandbox
/sandbox on
/sandbox off
/sandbox auto-allow on
/sandbox auto-allow off
```

实现：

```ts
// src/commands/sandboxCommand.ts
import type { LocalCommand } from "./commandTypes";

export const sandboxCommand: LocalCommand = {
  type: "local",
  name: "sandbox",
  description: "View or update sandbox settings",
  source: "builtin",
  async run(args, context) {
    const [first, second] = args.trim().split(/\s+/);

    if (!first) {
      const status = context.sandbox.getStatus();
      return {
        type: "text",
        text: formatSandboxStatus(status),
      };
    }

    if (first === "on") {
      await context.settings.update({
        sandbox: { ...context.settings.current().sandbox, enabled: true },
      });
      await context.sandbox.initialize();
      return { type: "text", text: "Sandbox enabled." };
    }

    if (first === "off") {
      await context.settings.update({
        sandbox: { ...context.settings.current().sandbox, enabled: false },
      });
      return { type: "text", text: "Sandbox disabled." };
    }

    if (first === "auto-allow") {
      const enabled = second === "on";
      await context.settings.update({
        sandbox: {
          ...context.settings.current().sandbox,
          autoAllowBashIfSandboxed: enabled,
        },
      });
      context.sandbox.refresh(context.settings.current());
      return { type: "text", text: `Sandbox auto-allow: ${enabled ? "on" : "off"}` };
    }

    return {
      type: "text",
      text: "Usage: /sandbox [on|off|auto-allow on|auto-allow off]",
    };
  },
};
```

如果 sandbox 设置被企业策略锁定，`/sandbox off` 应该返回错误，不要修改本地配置。Mini 第一版可以先不做企业策略，但要保留这个扩展点。

## 启动时初始化

CLI 启动时初始化 sandbox：

```ts
// src/main.ts
const settings = await loadSettings();
const sandbox = new MiniSandboxManager(settings);
const sandboxStatus = await sandbox.initialize();

if (sandboxStatus.type === "unavailable") {
  console.error(sandboxStatus.reason);
}

const appContext = {
  settings,
  sandbox,
};
```

如果 `failIfUnavailable: true`，`initialize()` 会直接抛错，CLI 应该退出。

## 测试

建议新增：

```ts
// src/isolation/__tests__/sandboxConfig.test.ts
describe("buildSandboxRuntimeConfig", () => {
  test("adds default write denies", () => {});
  test("converts Edit allow rules into allowWrite", () => {});
  test("converts Read deny rules into denyRead", () => {});
  test("converts WebFetch domain rules into network config", () => {});
});

// src/isolation/__tests__/shouldUseSandbox.test.ts
describe("shouldUseSandbox", () => {
  test("returns false when sandbox is not ready", () => {});
  test("returns false when command disables sandbox and policy allows it", () => {});
  test("returns false for excluded commands", () => {});
  test("returns true for normal commands when sandbox is ready", () => {});
});

// src/isolation/__tests__/processRunner.test.ts
describe("runProcess", () => {
  test("captures output", async () => {});
  test("truncates large output", async () => {});
  test("aborts on timeout", async () => {});
});

// src/isolation/__tests__/mcpProcessRuntime.test.ts
describe("closeMcpProcess", () => {
  test("closes handle without pid", async () => {});
  test("sends escalating signals when process stays alive", async () => {});
});
```

对应命令：

```bash
bun test src/isolation/__tests__/sandboxConfig.test.ts
bun test src/isolation/__tests__/shouldUseSandbox.test.ts
bun test src/isolation/__tests__/processRunner.test.ts
bun test src/isolation/__tests__/mcpProcessRuntime.test.ts
bun run typecheck
```

## 常见问题

### 第 14 章已经有 Sandbox，为什么还要这一章？

第 14 章是应用层策略：先判断命令危险不危险，再决定 allow、ask、deny。

这一章是执行隔离：即使命令被允许，也要限制它的文件系统、网络、超时、输出和进程生命周期。

两层都需要。

### sandbox auto-allow 会不会削弱权限系统？

如果实现错了会。正确顺序是：显式 deny/ask 和工具安全检查先执行，确认命令会进入 sandbox 后，才允许 auto-allow。

auto-allow 的前提是“实际 sandboxed”，不是“用户配置里 enabled 为 true”。

### 为什么主进程文件写入不能依赖 sandbox runtime？

因为 sandbox runtime 包的是子进程。Mini 主进程自己调用 `writeFile()`（node:fs/promises）时没有进入那个子进程环境，所以仍然需要应用层路径检查。

### sandbox 不可用时要不要继续运行？

看配置。

- `failIfUnavailable: true`：直接失败，适合安全要求高的环境。
- `failIfUnavailable: false`：继续运行，但必须明确提示用户 sandbox 没有生效。

静默裸跑是最差选择。

### 为什么 MCP stdio server 要做信号升级？

很多 stdio server 会启动自己的子进程或容器。只调用 client close 不一定能让它们退出。先给 `SIGINT`，再给 `SIGTERM`，最后 `SIGKILL`，可以兼顾优雅关闭和资源回收。

### 为什么输出要写文件？

长命令输出可能非常大。全部留在内存里会拖垮 CLI，也会污染模型上下文。写文件后，工具结果只返回摘要，需要完整内容时再用 FileRead 读取。

## 本章完成标准

完成后应满足：

- Mini 有 `SandboxSettings` 和 `SandboxRuntimeStatus`。
- CLI 启动时会初始化 sandbox runtime。
- sandbox 不可用时有明确提示。
- `failIfUnavailable` 能让 CLI 直接失败。
- 权限规则能转换成 sandbox 文件系统和网络配置。
- Bash 执行前会判断是否进入 sandbox。
- Bash 执行前会调用 `wrapCommand()`。
- Bash 输出写入安全 output file，并返回截断摘要。
- Bash 支持 timeout 和外部 abort。
- Bash 执行后会调用 sandbox cleanup。
- sandbox violation 会进入工具结果和 transcript。
- sandbox auto-allow 只在实际 sandboxed 时生效。
- 显式 deny/ask 优先于 sandbox auto-allow。
- FileWrite/Edit 保留主进程路径边界检查。
- MCP tool call 支持 timeout 和 abort。
- MCP stdio server 关闭时有信号升级。
- `/sandbox` 能查看状态和开关本地 sandbox。
- `bun run typecheck` 通过。

第二十八章到这里，Mini 已经从“有权限确认”升级到“有执行边界”。下一章可以继续做后台任务和长运行命令：当 Bash 或 MCP 工具运行很久时，如何让它进入后台、持续收集输出，并让用户随时查看或中断。
