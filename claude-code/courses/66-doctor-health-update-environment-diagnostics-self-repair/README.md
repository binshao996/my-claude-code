# 第 66 章：Doctor、Health、更新检查、环境诊断、自检报告与故障修复建议

第 65 章补上了代码智能层：LSP、诊断、符号、Magic Docs 和语义上下文。

这解决的是“项目代码哪里错了”。

本章要补的是另一类问题：

> Claude Code 自己哪里错了？

一个接近官方 Claude Code 的 CLI，不能只会在正常路径里跑起来。它还要能在用户遇到问题时快速回答：

- 当前运行的是哪个安装形态？
- 当前版本是多少？
- 自动更新为什么失败？
- 搜索工具是否可用？
- 配置文件是否无效？
- 插件、Agent、MCP、LSP 是否加载失败？
- 沙箱依赖是否缺失？
- 上下文为什么变慢？
- 环境变量是否写错？
- 是否有多个安装互相覆盖？
- 能不能给出安全、具体、可执行的修复建议？

这就是 `doctor` / `status` / `env` / `health` 这一层的职责。

当前仓库里已经有不少相关实现：

- `src/commands/doctor/doctor.tsx`
- `src/screens/Doctor.tsx`
- `src/utils/doctorDiagnostic.ts`
- `src/utils/doctorContextWarnings.ts`
- `src/commands/status/status.tsx`
- `src/components/Settings/Status.tsx`
- `src/utils/status.tsx`
- `src/commands/env/index.ts`
- `src/components/AutoUpdaterWrapper.tsx`
- `src/components/AutoUpdater.tsx`
- `src/components/NativeAutoUpdater.tsx`
- `src/components/PackageManagerAutoUpdater.tsx`
- `src/utils/autoUpdater.ts`
- `src/components/sandbox/SandboxDoctorSection.tsx`
- `src/hooks/notifs/useSettingsErrors.tsx`
- `src/hooks/notifs/useLspInitializationNotification.tsx`

同时也有一个明显缺口：`package.json` 里有 `health` 脚本，但仓库里没有找到对应的 `scripts/health-check.ts`。这意味着本章应该把 `health runner` 作为一个明确的待补齐模块来设计。

---

## 66.1 Doctor 与 Health 的区别

不要把所有诊断都塞进一个命令。

建议分成四类入口：

```text
/status
  当前会话状态：版本、模型、账号、Provider、IDE、MCP、Sandbox、Setting sources

/doctor
  交互式健康诊断：安装方式、更新权限、配置警告、插件错误、Agent 解析错误、上下文膨胀、环境变量问题

/env
  环境快照：runtime、allowlisted env、feature flags、session id，所有敏感值脱敏

bun run health
  非交互式自检：适合本地脚本、CI、release gate，输出人类摘要或 JSON，使用退出码表达失败
```

换句话说：

- `/status` 回答“我现在连着什么、正在用什么”。
- `/doctor` 回答“这台机器上的 Claude Code 哪里不健康”。
- `/env` 回答“当前进程看到了哪些可公开环境信息”。
- `health` 回答“这个仓库和 CLI 构建是否能通过最小门槛”。

---

## 66.2 当前 `/doctor` 的源码结构

`/doctor` 是一个 local JSX command：

```text
src/commands/doctor/index.ts
  -> name: doctor
  -> load: ./doctor.js

src/commands/doctor/doctor.tsx
  -> render <Doctor />

src/screens/Doctor.tsx
  -> collect diagnostics
  -> render grouped sections
```

`Doctor` 屏幕当前会展示：

- Installation diagnostics
- Updates
- Sandbox
- MCP parsing warnings
- Keybinding warnings
- Environment Variables
- Version Locks
- Agent Parse Errors
- Plugin Errors
- Unreachable Permission Rules
- Context Usage Warnings

这已经很接近官方体验。

本章的重点不是重写它，而是把这些能力标准化成一套诊断模型，并补上非交互式 `health`。

---

## 66.3 诊断模型

所有健康检查都应该返回结构化结果，再由 UI 或 CLI formatter 决定怎么展示。

```ts
export type DiagnosticSeverity = "ok" | "info" | "warning" | "error";

export type DiagnosticCategory =
  | "installation"
  | "update"
  | "runtime"
  | "settings"
  | "environment"
  | "search"
  | "sandbox"
  | "mcp"
  | "lsp"
  | "plugins"
  | "agents"
  | "context"
  | "workspace"
  | "cache";

export type DiagnosticItem = {
  id: string;
  category: DiagnosticCategory;
  severity: DiagnosticSeverity;
  title: string;
  detail?: string;
  fix?: string;
  command?: string;
  docsUrl?: string;
  safeToAutoFix: boolean;
};
```

这里的关键字段是 `safeToAutoFix`。

健康诊断不应该默认修改用户机器。即使能给出修复命令，也要区分：

- 纯读检查。
- 安全清理。
- 需要确认的修复。
- 需要用户自己执行的修复。

---

## 66.4 Doctor Report

可以定义统一报告：

```ts
export type DoctorReport = {
  generatedAt: string;
  version: string;
  cwd: string;
  runtime: RuntimeSnapshot;
  items: DiagnosticItem[];
  summary: {
    ok: number;
    info: number;
    warning: number;
    error: number;
  };
};

export type RuntimeSnapshot = {
  platform: NodeJS.Platform;
  arch: string;
  bunVersion: string | null;
  nodeVersion: string;
  pid: number;
  sessionId?: string;
};
```

汇总函数：

```ts
export function summarizeDiagnostics(items: DiagnosticItem[]) {
  return items.reduce(
    (summary, item) => {
      summary[item.severity]++;
      return summary;
    },
    { ok: 0, info: 0, warning: 0, error: 0 },
  );
}
```

UI 不应该重新推导健康状态。所有判断应在 collector 层完成。

---

## 66.5 安装方式检测

当前仓库的 `getDoctorDiagnostic()` 会检测安装类型、版本、路径、调用入口、配置安装方式、更新权限、重复安装、搜索工具状态和警告。

抽象模型可以写成：

```ts
export type InstallationKind =
  | "native"
  | "package-managed"
  | "js-global"
  | "js-local"
  | "development"
  | "unknown";

export type InstallationSnapshot = {
  kind: InstallationKind;
  version: string;
  installationPath: string;
  invokedBinary: string;
  configuredInstallMethod: string;
  multipleInstallations: Array<{
    kind: string;
    path: string;
  }>;
};
```

检测顺序建议：

```text
NODE_ENV development
  -> development

bundled mode
  -> native or package-managed

local JS install marker
  -> js-local

global JS path marker
  -> js-global

otherwise
  -> unknown
```

要注意：安装检测是启发式，不要把它设计成安全边界。

它是诊断提示，不是权限决策。

---

## 66.6 多安装冲突

多安装是 CLI 工具最常见的问题之一。

症状：

- 用户以为已经更新，但命令行仍运行旧版本。
- shell alias 指向旧位置。
- PATH 顺序导致错误二进制先被命中。
- 原生安装和旧 JS 安装同时存在。

诊断项：

```ts
export function diagnoseMultipleInstallations(
  snapshot: InstallationSnapshot,
): DiagnosticItem[] {
  if (snapshot.multipleInstallations.length <= 1) {
    return [];
  }

  return [
    {
      id: "installation.multiple",
      category: "installation",
      severity: "warning",
      title: "Multiple Claude Code installations found",
      detail: snapshot.multipleInstallations
        .map(item => `${item.kind}: ${item.path}`)
        .join("\n"),
      fix: "Keep one installation method and remove stale launchers from PATH.",
      safeToAutoFix: false,
    },
  ];
}
```

不要自动删除旧安装。

最多可以提供“推荐保留哪个”的解释，真正删除必须由用户确认。

---

## 66.7 PATH 与 Launcher 检查

原生安装常见问题是二进制存在，但 `~/.local/bin` 不在 PATH。

诊断模型：

```ts
export function diagnosePathForNativeInstall(input: {
  kind: InstallationKind;
  pathEntries: string[];
  home: string;
  platform: NodeJS.Platform;
}): DiagnosticItem[] {
  if (input.kind !== "native") {
    return [];
  }

  const expected = `${input.home}/.local/bin`;
  const exists = input.pathEntries.some(entry =>
    normalizePath(entry) === normalizePath(expected),
  );

  if (exists) {
    return [];
  }

  return [
    {
      id: "installation.path.missing-local-bin",
      category: "installation",
      severity: "warning",
      title: "Native launcher directory is not in PATH",
      detail: expected,
      fix: "Add the launcher directory to your shell PATH, then restart the terminal.",
      safeToAutoFix: false,
    },
  ];
}
```

注意：不要在 `doctor` 输出中假设用户使用某个 shell。可以根据 shell 类型给出更具体的建议，但必须允许用户自己决定。

---

## 66.8 更新检查架构

自动更新应被拆成三层：

```text
Update detector
  -> 当前版本、最新版本、频道、最大版本上限、最小版本偏好

Update installer
  -> 原生二进制安装、JS 包安装、包管理器提示

Update reporter
  -> UI 消息、doctor 状态、失败分类、重启提示
```

当前仓库已经有：

- `AutoUpdaterWrapper`：根据安装方式选择 updater。
- `NativeAutoUpdater`：原生安装更新。
- `AutoUpdater`：JS 安装更新。
- `PackageManagerAutoUpdater`：只提示，不自动更新。
- `autoUpdater.ts`：版本比较、锁、权限检查、最高版本熔断。

标准类型：

```ts
export type UpdateChannel = "latest" | "stable";

export type UpdateSnapshot = {
  currentVersion: string;
  latestVersion: string | null;
  channel: UpdateChannel;
  autoUpdatesEnabled: boolean;
  disabledReason?: string;
  maxAllowedVersion?: string;
  minimumVersion?: string;
  updateAvailable: boolean;
  installStrategy: "native" | "js" | "package-manager" | "none";
};
```

---

## 66.9 自动更新门控

更新前至少检查：

```text
is test/development?
  -> skip

auto updater disabled?
  -> skip and report reason

max allowed version set?
  -> cap latest version

minimumVersion set?
  -> do not downgrade below preference

another update in progress?
  -> skip via lock

installation kind supports auto install?
  -> install or show manual instructions
```

代码：

```ts
export function shouldAttemptUpdate(snapshot: UpdateSnapshot): {
  ok: boolean;
  reason?: string;
} {
  if (!snapshot.autoUpdatesEnabled) {
    return { ok: false, reason: snapshot.disabledReason ?? "disabled" };
  }

  if (!snapshot.latestVersion) {
    return { ok: false, reason: "latest version unavailable" };
  }

  if (!snapshot.updateAvailable) {
    return { ok: false, reason: "already up to date" };
  }

  if (snapshot.installStrategy === "package-manager") {
    return { ok: false, reason: "managed externally" };
  }

  if (snapshot.installStrategy === "none") {
    return { ok: false, reason: "unsupported installation type" };
  }

  return { ok: true };
}
```

`doctor` 应展示原因，自动更新器则应静默跳过可预期场景。

---

## 66.10 更新锁

更新是高风险操作，必须防并发。

锁要求：

- 原子创建。
- 写入当前 PID。
- 有超时。
- 只释放自己持有的锁。
- stale lock 可以清理，但要二次确认。

模型：

```ts
export type UpdateLockStatus =
  | { state: "acquired"; path: string }
  | { state: "held"; path: string; pid?: number; ageMs?: number }
  | { state: "stale"; path: string; pid?: number; ageMs?: number }
  | { state: "error"; path: string; message: string };
```

诊断：

```ts
export function diagnoseUpdateLock(status: UpdateLockStatus): DiagnosticItem[] {
  if (status.state === "acquired") {
    return [];
  }

  if (status.state === "held") {
    return [
      {
        id: "update.lock.held",
        category: "update",
        severity: "info",
        title: "Another update appears to be running",
        detail: `Lock: ${status.path}`,
        fix: "Wait for the current update to finish.",
        safeToAutoFix: false,
      },
    ];
  }

  if (status.state === "stale") {
    return [
      {
        id: "update.lock.stale",
        category: "update",
        severity: "warning",
        title: "Stale update lock found",
        detail: `Lock: ${status.path}`,
        fix: "Remove the stale lock after confirming no update process is running.",
        safeToAutoFix: true,
      },
    ];
  }

  return [
    {
      id: "update.lock.error",
      category: "update",
      severity: "error",
      title: "Could not inspect update lock",
      detail: status.message,
      safeToAutoFix: false,
    },
  ];
}
```

安全自动修复只适合 stale lock，且最好在 `doctor --fix` 里二次确认。

---

## 66.11 Version Locks

当前 `/doctor` 已经会展示 PID-based version locks：

```text
Version Locks
└ No active version locks
```

或：

```text
Version Locks
└ 1.2.3: PID 12345 (running)
```

这类锁用于防止正在运行的版本被清理。

诊断策略：

- running lock：正常信息。
- stale lock：warning，可清理。
- lock dir 不可读：error。

类型：

```ts
export type VersionLockDiagnostic = {
  version: string;
  pid: number;
  isProcessRunning: boolean;
  path: string;
};
```

不要把 version lock 和 update lock 混为一谈。前者保护运行中版本，后者保护安装事务。

---

## 66.12 搜索工具检查

Claude Code 依赖快速搜索。

`doctorDiagnostic` 已经会读取 ripgrep 状态，并展示：

```text
Search: OK (bundled/vendor/system)
```

抽象成：

```ts
export type SearchToolStatus = {
  working: boolean;
  mode: "embedded" | "builtin" | "system";
  path: string | null;
};

export function diagnoseSearchTool(status: SearchToolStatus): DiagnosticItem[] {
  if (status.working) {
    return [];
  }

  return [
    {
      id: "search.unavailable",
      category: "search",
      severity: "error",
      title: "Search tool is not working",
      detail: status.path ?? "No search binary found",
      fix: "Use the bundled search binary or install a compatible system search tool.",
      safeToAutoFix: false,
    },
  ];
}
```

搜索工具失败不会让 CLI 完全不可用，但会明显影响 Agent 的代码定位能力。

---

## 66.13 设置文件诊断

设置诊断要覆盖：

- JSON 解析失败。
- schema 校验失败。
- 企业托管设置字段未知。
- 权限规则不可达。
- 环境变量类型错误。
- feature flag 值无效。
- 插件配置缺失。

当前仓库已有：

- `getSettingsWithAllErrors()`
- `useSettingsErrors()`
- `ValidationErrorsList`
- `detectUnreachableRules()`

结构：

```ts
export type SettingsDiagnosticInput = {
  validationErrors: Array<{
    file: string;
    message: string;
  }>;
  unreachablePermissionRules: Array<{
    rule: string;
    reason: string;
    fix: string;
  }>;
};
```

输出：

```ts
export function diagnoseSettings(
  input: SettingsDiagnosticInput,
): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];

  for (const error of input.validationErrors) {
    items.push({
      id: `settings.invalid.${error.file}`,
      category: "settings",
      severity: "error",
      title: "Invalid settings file",
      detail: `${error.file}: ${error.message}`,
      fix: "Fix the settings syntax or remove the invalid field.",
      safeToAutoFix: false,
    });
  }

  for (const rule of input.unreachablePermissionRules) {
    items.push({
      id: `settings.permission.unreachable.${rule.rule}`,
      category: "settings",
      severity: "warning",
      title: "Unreachable permission rule",
      detail: rule.reason,
      fix: rule.fix,
      safeToAutoFix: false,
    });
  }

  return items;
}
```

配置修复一般不应该自动执行。原因是设置文件可能来自用户、项目、企业策略，写错位置会制造更大问题。

---

## 66.14 环境变量诊断

当前 `/doctor` 会校验几个有上限的数值型环境变量：

- `BASH_MAX_OUTPUT_LENGTH`
- `TASK_MAX_OUTPUT_LENGTH`
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS`

通用校验器：

```ts
export type EnvVarValidationResult = {
  effective: number;
  status: "valid" | "capped" | "invalid";
  message?: string;
};

export function validateBoundedIntEnvVar(
  name: string,
  value: string | undefined,
  defaultValue: number,
  upperLimit: number,
): EnvVarValidationResult {
  if (!value) {
    return { effective: defaultValue, status: "valid" };
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return {
      effective: defaultValue,
      status: "invalid",
      message: `Invalid value for ${name}; using default ${defaultValue}`,
    };
  }

  if (parsed > upperLimit) {
    return {
      effective: upperLimit,
      status: "capped",
      message: `Value for ${name} capped to ${upperLimit}`,
    };
  }

  return { effective: parsed, status: "valid" };
}
```

诊断要区分：

- invalid：error。
- capped：warning。
- absent：ok。

---

## 66.15 `/env`：环境快照必须脱敏

`/env` 是纯本地命令，当前实现会：

- 展示 runtime：platform、cwd、pid、Bun version、Node version、session。
- 只展示 allowlisted 前缀的环境变量。
- 对 token、secret、password、key、auth、credential、jwt 等字段脱敏。

脱敏规则：

```ts
const SECRET_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /api[_-]?key/i,
  /auth/i,
  /private/i,
  /credential/i,
  /jwt/i,
  /session[_-]?id$/i,
];

export function maskValue(value: string): string {
  if (value.length <= 8) {
    return "***";
  }

  return `${value.slice(0, 4)}...${value.slice(-2)} (${value.length} chars)`;
}
```

环境快照绝不能输出完整密钥。

这条规则优先级高于“调试方便”。

---

## 66.16 Provider 诊断

`/status` 会展示当前 API Provider：

- first party
- Bedrock
- Vertex
- Foundry
- Gemini
- Grok
- OpenAI-compatible

Provider 诊断应该只显示配置来源和非敏感端点，不显示 token。

类型：

```ts
export type ProviderDiagnostic = {
  provider: string;
  baseUrl?: string;
  region?: string;
  project?: string;
  authSkipped?: boolean;
  proxy?: string;
  mtls?: {
    certPath?: string;
    keyPath?: string;
  };
};
```

注意：base URL 通常可以展示，但如果用户把 token 错放在 URL 里，要做 URL redaction。

```ts
export function redactUrl(input: string): string {
  try {
    const url = new URL(input);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "***";
    }
    return url.toString();
  } catch {
    return input.replace(/:\/\/[^/@]+@/, "://***@");
  }
}
```

---

## 66.17 Context Usage Warnings

很多“Claude Code 变慢”的根因不是网络，而是上下文太大。

当前 `doctorContextWarnings` 会检查：

- 大型 `CLAUDE.md` 文件。
- 自定义 Agent 描述过长。
- MCP tools 描述过大。
- 权限规则被遮蔽。

标准化：

```ts
export type ContextWarning = {
  type:
    | "memory_files"
    | "agent_descriptions"
    | "mcp_tools"
    | "unreachable_rules";
  severity: "warning" | "error";
  message: string;
  details: string[];
  currentValue: number;
  threshold: number;
};
```

修复建议：

- 大型 memory：拆分、删除过时内容、移动到项目文档。
- Agent 描述过长：只保留触发条件和能力边界。
- MCP tools 过大：禁用不需要的 server 或减少 tool schema。
- 不可达规则：删除被覆盖的规则或调整顺序。

不要自动修改 memory 或 Agent 文件。它们属于用户意图表达。

---

## 66.18 Agent 与 Plugin 错误

`/doctor` 当前会展示：

- Agent Parse Errors
- Plugin Errors

这两类错误很适合诊断报告。

类型：

```ts
export type ExtensionLoadError = {
  source: "agent" | "plugin";
  path?: string;
  pluginName?: string;
  message: string;
};
```

诊断：

```ts
export function diagnoseExtensionErrors(
  errors: ExtensionLoadError[],
): DiagnosticItem[] {
  return errors.map((error, index) => ({
    id: `${error.source}.load.${index}`,
    category: error.source === "agent" ? "agents" : "plugins",
    severity: "error",
    title: `${error.source} failed to load`,
    detail: [error.pluginName, error.path, error.message]
      .filter(Boolean)
      .join(" - "),
    fix: "Fix the file syntax or disable the broken extension.",
    safeToAutoFix: false,
  }));
}
```

这里不要“自动禁用插件”。插件可能是用户当前任务必需的，自动禁用会让问题更难理解。

---

## 66.19 LSP 初始化错误

第 65 章说过 LSP 是增强层。增强层失败时不能拖垮主 CLI，但要被 `/doctor` 看见。

当前 `useLspInitializationNotification` 会：

- 轮询 LSP manager 状态。
- 捕获 manager 初始化失败。
- 捕获单个 server error。
- 写入 `appState.plugins.errors`。
- 显示短通知。

诊断策略：

```ts
export type LspHealth = {
  manager:
    | { status: "not-started" }
    | { status: "pending" }
    | { status: "success" }
    | { status: "failed"; error: string };
  servers: Array<{
    name: string;
    state: "stopped" | "starting" | "running" | "stopping" | "error";
    lastError?: string;
  }>;
};
```

失败项：

```ts
export function diagnoseLspHealth(health: LspHealth): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];

  if (health.manager.status === "failed") {
    items.push({
      id: "lsp.manager.failed",
      category: "lsp",
      severity: "error",
      title: "LSP manager failed to initialize",
      detail: health.manager.error,
      fix: "Check LSP plugin configuration and reload plugins.",
      safeToAutoFix: false,
    });
  }

  for (const server of health.servers) {
    if (server.state === "error") {
      items.push({
        id: `lsp.server.${server.name}.failed`,
        category: "lsp",
        severity: "warning",
        title: `LSP server failed: ${server.name}`,
        detail: server.lastError,
        fix: "Check that the language server binary exists and the plugin config is valid.",
        safeToAutoFix: false,
      });
    }
  }

  return items;
}
```

---

## 66.20 MCP 诊断

`/status` 已经会摘要展示 MCP 状态：

```text
MCP servers: 3 connected, 1 need auth, 1 failed · /mcp
```

`/doctor` 还会显示 MCP parsing warnings。

标准健康项：

```ts
export type McpHealth = {
  connected: number;
  pending: number;
  needsAuth: number;
  failed: number;
  parsingWarnings: string[];
};
```

诊断：

```ts
export function diagnoseMcp(health: McpHealth): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];

  if (health.failed > 0) {
    items.push({
      id: "mcp.failed",
      category: "mcp",
      severity: "warning",
      title: `${health.failed} MCP server(s) failed`,
      fix: "Run /mcp to inspect server-specific errors.",
      safeToAutoFix: false,
    });
  }

  if (health.needsAuth > 0) {
    items.push({
      id: "mcp.needs-auth",
      category: "mcp",
      severity: "info",
      title: `${health.needsAuth} MCP server(s) need authentication`,
      fix: "Complete MCP authentication for the affected servers.",
      safeToAutoFix: false,
    });
  }

  for (const [index, warning] of health.parsingWarnings.entries()) {
    items.push({
      id: `mcp.parse.${index}`,
      category: "mcp",
      severity: "warning",
      title: "MCP configuration warning",
      detail: warning,
      safeToAutoFix: false,
    });
  }

  return items;
}
```

---

## 66.21 Sandbox 诊断

当前 `SandboxDoctorSection` 只在平台支持且设置开启时展示。

它会检查：

- dependencies errors
- dependencies warnings
- 是否需要打开 `/sandbox` 查看安装说明

诊断模型：

```ts
export type SandboxHealth = {
  supported: boolean;
  enabled: boolean;
  errors: string[];
  warnings: string[];
};
```

展示逻辑：

```ts
export function diagnoseSandbox(health: SandboxHealth): DiagnosticItem[] {
  if (!health.supported || !health.enabled) {
    return [];
  }

  return [
    ...health.errors.map((error, index) => ({
      id: `sandbox.error.${index}`,
      category: "sandbox" as const,
      severity: "error" as const,
      title: "Sandbox dependency missing",
      detail: error,
      fix: "Run /sandbox for setup instructions.",
      safeToAutoFix: false,
    })),
    ...health.warnings.map((warning, index) => ({
      id: `sandbox.warning.${index}`,
      category: "sandbox" as const,
      severity: "warning" as const,
      title: "Sandbox dependency warning",
      detail: warning,
      fix: "Review /sandbox before relying on automatic permission behavior.",
      safeToAutoFix: false,
    })),
  ];
}
```

沙箱问题要标得清楚，因为它会影响权限自动允许策略。

---

## 66.22 Health Runner 的定位

`bun run health` 应该是非交互式的。

它应该能在这些场景使用：

- 本地提交前快速检查。
- release 前检查构建健康。
- CI 里生成诊断 JSON。
- 用户把诊断输出贴给维护者。
- Agent 自己判断环境是否适合继续执行。

它不应该依赖 Ink UI。

入口建议：

```text
scripts/health-check.ts
  -> parse flags
  -> collect report
  -> print text or JSON
  -> exit with code
```

支持参数：

```text
bun run health
bun run health -- --json
bun run health -- --category settings
bun run health -- --strict
bun run health -- --no-network
```

注意：`--` 后的参数传给脚本。

---

## 66.23 Health Runner 退出码

退出码要简单：

```ts
export function getHealthExitCode(
  report: DoctorReport,
  strict: boolean,
): number {
  if (report.summary.error > 0) {
    return 2;
  }

  if (strict && report.summary.warning > 0) {
    return 1;
  }

  return 0;
}
```

建议约定：

```text
0: healthy or warnings allowed
1: strict mode failed because warnings exist
2: errors exist
3: health runner crashed
```

这样 CI 可以清晰区分“健康检查发现错误”和“健康检查自身崩了”。

---

## 66.24 Health Runner 输出

默认文本输出：

```text
Claude Code Health
Version: 2.1.888
CWD: /repo

Summary: 12 ok, 2 warning, 0 error

[warning] settings.invalid
Invalid settings file
Fix: Fix the settings syntax or remove the invalid field.

[warning] context.memory_files
Large CLAUDE.md file detected
Fix: Split long memory files into focused project docs.
```

JSON 输出：

```json
{
  "generatedAt": "2026-05-27T00:00:00.000Z",
  "version": "2.1.888",
  "cwd": "/repo",
  "summary": {
    "ok": 12,
    "info": 1,
    "warning": 2,
    "error": 0
  },
  "items": []
}
```

JSON 输出要稳定，字段名不要频繁变化。它可能被用户脚本消费。

---

## 66.25 Health Collector 编排

Collector 要并行运行互不依赖的检查。

```ts
export async function collectHealthReport(
  options: {
    includeNetwork: boolean;
    categories?: DiagnosticCategory[];
  },
): Promise<DoctorReport> {
  const runtime = collectRuntimeSnapshot();

  const groups = await Promise.all([
    collectInstallationDiagnostics(),
    collectUpdateDiagnostics({ includeNetwork: options.includeNetwork }),
    collectSettingsDiagnostics(),
    collectEnvironmentDiagnostics(),
    collectSearchDiagnostics(),
    collectSandboxDiagnostics(),
    collectExtensionDiagnostics(),
    collectContextDiagnostics(),
    collectWorkspaceDiagnostics(),
  ]);

  const items = groups.flat().filter(item =>
    options.categories ? options.categories.includes(item.category) : true,
  );

  return {
    generatedAt: new Date().toISOString(),
    version: getCliVersion(),
    cwd: process.cwd(),
    runtime,
    items,
    summary: summarizeDiagnostics(items),
  };
}
```

注意：不要让单个 collector 抛错终止全局检查。

应包装为诊断项：

```ts
export async function safeCollect(
  category: DiagnosticCategory,
  collect: () => Promise<DiagnosticItem[]>,
): Promise<DiagnosticItem[]> {
  try {
    return await collect();
  } catch (error) {
    return [
      {
        id: `${category}.collector.failed`,
        category,
        severity: "error",
        title: `Failed to collect ${category} diagnostics`,
        detail: error instanceof Error ? error.message : String(error),
        safeToAutoFix: false,
      },
    ];
  }
}
```

---

## 66.26 Workspace 健康检查

对当前仓库，`health` 最少应该检查：

- `bun` 是否可用。
- `package.json` 是否存在。
- lockfile 是否存在。
- `node_modules` 是否存在。
- `src/entrypoints/cli.tsx` 是否存在。
- `scripts/defines.ts` 是否存在。
- `bun run typecheck` 是否通过。

不要默认跑全部测试。完整测试可能太慢。

可以分层：

```text
health default
  -> file presence
  -> config parse
  -> typecheck

health --full
  -> build
  -> targeted smoke tests
  -> selected integration tests
```

默认命令：

```bash
bun run health
```

严格检查：

```bash
bun run health -- --strict
```

完整检查：

```bash
bun run health -- --full
```

---

## 66.27 Shell 命令检查封装

Health runner 需要执行子命令，但要可控。

```ts
export type CommandCheckResult = {
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export async function runCheckCommand(
  command: string[],
  timeoutMs: number,
): Promise<CommandCheckResult> {
  const started = Date.now();
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => {
    proc.kill();
  }, timeoutMs);

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return {
      command: command.join(" "),
      code,
      stdout,
      stderr,
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timeout);
  }
}
```

命令输出要截断，避免 health report 爆炸。

---

## 66.28 Typecheck 检查

```ts
export async function collectTypecheckDiagnostic(): Promise<DiagnosticItem[]> {
  const result = await runCheckCommand(["bun", "run", "typecheck"], 120_000);

  if (result.code === 0) {
    return [
      {
        id: "workspace.typecheck.ok",
        category: "workspace",
        severity: "ok",
        title: "Typecheck passed",
        safeToAutoFix: false,
      },
    ];
  }

  return [
    {
      id: "workspace.typecheck.failed",
      category: "workspace",
      severity: "error",
      title: "Typecheck failed",
      detail: truncateOutput(result.stderr || result.stdout, 4000),
      fix: "Fix TypeScript errors before release or commit.",
      command: "bun run typecheck",
      safeToAutoFix: false,
    },
  ];
}
```

`health` 可以调用 typecheck，但不要在 `/doctor` 交互 UI 里自动跑长命令。两者体验不同。

---

## 66.29 缺失脚本诊断

当前仓库的 `package.json` 有：

```json
{
  "scripts": {
    "health": "bun run scripts/health-check.ts"
  }
}
```

但没有找到 `scripts/health-check.ts`。

这应该被 health 自举检查捕获：

```ts
export async function collectHealthScriptPresence(): Promise<DiagnosticItem[]> {
  const exists = await fileExists("scripts/health-check.ts");

  if (exists) {
    return [];
  }

  return [
    {
      id: "workspace.health-script.missing",
      category: "workspace",
      severity: "error",
      title: "Health script is missing",
      detail: "package.json references scripts/health-check.ts, but the file does not exist.",
      fix: "Add scripts/health-check.ts or update the health script target.",
      safeToAutoFix: false,
    },
  ];
}
```

这类检查对“接近官方”很重要：一个官方级工具不应该保留指向不存在文件的健康脚本。

---

## 66.30 Release Gate

发布前的 gate 可以复用 health collector：

```text
release gate
  -> health --strict
  -> typecheck
  -> build
  -> targeted tests
  -> bundle integrity
  -> smoke cli --version
```

脚本示例：

```bash
bun run health -- --strict
bun run typecheck
bun run build
bun test src/utils/__tests__/envValidation.test.ts
```

不要把 release gate 全部塞进 `/doctor`。`/doctor` 面向用户，release gate 面向维护者和 CI。

---

## 66.31 自修复建议

自修复不是自动乱改。

建议分三类：

```ts
export type RepairSafety = "automatic" | "confirm" | "manual";

export type RepairAction = {
  id: string;
  title: string;
  safety: RepairSafety;
  explains: string;
  run?: () => Promise<void>;
  command?: string;
};
```

分类标准：

- `automatic`：只清理明显 stale 的缓存或锁，不影响用户配置。
- `confirm`：会修改安装、插件、缓存、settings，需要用户确认。
- `manual`：需要用户理解后执行，比如 PATH、企业策略、权限规则。

---

## 66.32 可自动修复的项目

可以考虑 automatic：

- 清理 stale update lock。
- 清理 stale version lock。
- 清理已损坏的临时下载目录。
- 清理过期缓存。
- 重置 LSP diagnostic registry。
- 重新读取插件缓存。

不应 automatic：

- 删除安装。
- 修改 PATH。
- 修改企业托管设置。
- 删除用户 memory。
- 禁用插件。
- 修改权限规则。
- 改 API Provider 配置。
- 改认证相关环境变量。

示例：

```ts
export function buildRepairActions(
  report: DoctorReport,
): RepairAction[] {
  const actions: RepairAction[] = [];

  for (const item of report.items) {
    if (item.id === "update.lock.stale") {
      actions.push({
        id: "repair.update-lock.remove-stale",
        title: "Remove stale update lock",
        safety: "automatic",
        explains: "The lock is stale and no update process appears to own it.",
        run: async () => {
          await removeStaleUpdateLock();
        },
      });
    }

    if (item.id.startsWith("plugins.")) {
      actions.push({
        id: "repair.plugins.reload",
        title: "Reload plugin cache",
        safety: "confirm",
        explains: "Reloading plugins may change available tools.",
        command: "/reload-plugins",
      });
    }
  }

  return actions;
}
```

---

## 66.33 `doctor --fix`

可以设计一个交互式修复模式：

```text
claude doctor --fix

Found 3 fixable issues:

1. Remove stale update lock
   Safety: automatic

2. Reload plugin cache
   Safety: confirm

3. Reinstall native launcher
   Safety: confirm

Apply automatic fixes? [y/N]
```

但默认 `claude doctor` 不应改任何东西。

如果做 slash command，也可以提供：

```text
/doctor fix
```

不过要小心：slash command 运行在当前会话里，修复动作可能改变会话状态。CLI subcommand 更适合做安装层修复。

---

## 66.34 诊断输出的排序

推荐排序：

```text
errors
  -> installation
  -> update
  -> settings
  -> environment
  -> sandbox
  -> plugins
  -> agents
  -> mcp
  -> lsp
  -> context
  -> info
  -> ok
```

排序函数：

```ts
const severityRank: Record<DiagnosticSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
  ok: 3,
};

const categoryRank: Record<DiagnosticCategory, number> = {
  installation: 0,
  update: 1,
  settings: 2,
  environment: 3,
  sandbox: 4,
  plugins: 5,
  agents: 6,
  mcp: 7,
  lsp: 8,
  search: 9,
  context: 10,
  runtime: 11,
  workspace: 12,
  cache: 13,
};

export function sortDiagnostics(items: DiagnosticItem[]): DiagnosticItem[] {
  return [...items].sort((a, b) => {
    const severity = severityRank[a.severity] - severityRank[b.severity];
    if (severity !== 0) {
      return severity;
    }

    return categoryRank[a.category] - categoryRank[b.category];
  });
}
```

用户先看到最可能阻塞的问题。

---

## 66.35 UI 展示原则

Doctor UI 应该是扫描型，不是日志型。

好的输出：

```text
Diagnostics
└ Currently running: native (2.1.888)
└ Path: /Users/me/.local/bin/claude
└ Search: OK (bundled)

Updates
└ Auto-updates: enabled
└ Auto-update channel: latest
└ Latest version: 2.1.889

Warnings
└ Large CLAUDE.md file detected
  Fix: Split long memory files into focused project docs.
```

坏的输出：

```text
Starting diagnostics...
Checking thing A...
Checking thing B...
Raw object: {"a": "..."}
Stack trace...
```

交互 UI 要隐藏内部噪音，只保留可行动信息。

---

## 66.36 日志与遥测

健康检查可以记录调试日志，但不要把日志当作用户输出。

事件可以记录：

- update check success/failure
- update install success/failure
- lock contention
- diagnostic category failed
- health runner exit code

但要遵守两点：

- 不记录路径中的敏感片段。
- 不记录环境变量值。

如果本项目的遥测是空实现，也应该保留接口边界，方便未来接入。

---

## 66.37 测试：环境变量校验

```ts
import { describe, expect, test } from "bun:test";
import { validateBoundedIntEnvVar } from "../envValidation";

describe("validateBoundedIntEnvVar", () => {
  test("uses default for missing value", () => {
    expect(validateBoundedIntEnvVar("X", undefined, 100, 1000)).toEqual({
      effective: 100,
      status: "valid",
    });
  });

  test("rejects non-positive values", () => {
    expect(validateBoundedIntEnvVar("X", "0", 100, 1000)).toMatchObject({
      effective: 100,
      status: "invalid",
    });
  });

  test("caps values above upper limit", () => {
    expect(validateBoundedIntEnvVar("X", "5000", 100, 1000)).toMatchObject({
      effective: 1000,
      status: "capped",
    });
  });
});
```

运行：

```bash
bun test src/utils/__tests__/envValidation.test.ts
```

---

## 66.38 测试：诊断排序

```ts
import { describe, expect, test } from "bun:test";
import { sortDiagnostics } from "../health/sort";

describe("sortDiagnostics", () => {
  test("orders errors before warnings and warnings before info", () => {
    const sorted = sortDiagnostics([
      item("info", "runtime"),
      item("error", "settings"),
      item("warning", "update"),
    ]);

    expect(sorted.map(i => i.severity)).toEqual([
      "error",
      "warning",
      "info",
    ]);
  });
});

function item(severity: "ok" | "info" | "warning" | "error", category: "runtime" | "settings" | "update") {
  return {
    id: `${category}.${severity}`,
    category,
    severity,
    title: "test",
    safeToAutoFix: false,
  };
}
```

运行：

```bash
bun test src/health/sort.test.ts
```

---

## 66.39 测试：JSON 输出稳定

Health JSON 输出最好有快照测试。

```ts
import { describe, expect, test } from "bun:test";
import { formatHealthJson } from "../health/format";

describe("formatHealthJson", () => {
  test("emits stable top-level fields", () => {
    const json = JSON.parse(formatHealthJson({
      generatedAt: "2026-05-27T00:00:00.000Z",
      version: "2.1.888",
      cwd: "/repo",
      runtime: {
        platform: "darwin",
        arch: "arm64",
        bunVersion: "1.2.0",
        nodeVersion: "v22.0.0",
        pid: 123,
      },
      items: [],
      summary: {
        ok: 1,
        info: 0,
        warning: 0,
        error: 0,
      },
    }));

    expect(Object.keys(json)).toEqual([
      "generatedAt",
      "version",
      "cwd",
      "runtime",
      "summary",
      "items",
    ]);
  });
});
```

运行：

```bash
bun test src/health/format.test.ts
```

---

## 66.40 推荐命令

本章落地后，推荐检查：

```bash
bun run health
bun run health -- --strict
bun run typecheck
```

如果修改了更新器：

```bash
bun test src/utils/__tests__/envValidation.test.ts
bun run typecheck
```

如果补了 health runner：

```bash
bun test src/health
bun run health -- --json
```

---

## 66.41 常见错误

### 把 `/doctor` 做成日志倾倒

用户不需要看所有内部步骤。用户需要知道问题、影响和修复方式。

### 默认执行修复

诊断命令默认必须只读。修复动作要有显式开关和确认。

### 输出完整环境变量

这是严重安全问题。只展示 allowlisted key，并对敏感 key 脱敏。

### 把 warning 当 error

warning 代表“应该处理”，不一定代表“不能继续”。CI strict mode 可以把 warning 升级为失败，但交互 CLI 不应该吓用户。

### 在交互 UI 中跑长检查

`/doctor` 应快速返回。长检查放进 `bun run health -- --full`。

### 健康检查依赖网络

默认 health 应能离线运行。网络检查要可选。

---

## 66.42 接近官方 Claude Code 的验收标准

做到这一章后，CLI 自诊断层应该满足：

- `/status` 能展示当前会话、版本、模型、账号、Provider、IDE、MCP、Sandbox 和 setting sources。
- `/doctor` 能展示安装方式、路径、调用入口、更新状态、搜索状态、配置问题、插件错误、Agent 解析错误、上下文膨胀和环境变量问题。
- `/env` 只展示 allowlisted 环境变量，并对敏感值脱敏。
- `bun run health` 有真实入口，不指向缺失文件。
- health runner 支持默认文本输出和 JSON 输出。
- health runner 有稳定退出码。
- health runner 默认离线，网络检查可选。
- 更新检查有锁和 server-side max version gate。
- update failure 能分类为权限、网络、校验、磁盘、超时等。
- stale lock 可以安全提示或修复。
- 多安装冲突能被发现。
- PATH 问题能被明确指出。
- settings schema 错误能被展示。
- LSP、MCP、plugin、agent 的加载错误能进入 doctor 报告。
- 修复建议具体，但默认不自动执行。

这一层完成后，用户不再需要猜“Claude Code 为什么坏了”。CLI 本身会给出可执行的诊断报告。

---

## 66.43 本章小结

本章把 Claude Code 的自诊断层系统化了。

关键点：

- `/status` 看当前连接与会话状态。
- `/doctor` 做交互式安装、更新、配置、插件、Agent、上下文和环境诊断。
- `/env` 输出脱敏环境快照。
- `health runner` 做非交互式自检，适合脚本和 CI。
- 更新系统要有频道、版本门控、锁、权限检查和失败分类。
- 自修复必须分级，默认只读，避免替用户做破坏性决定。

如果目标是接近官方 Claude Code，这一章补的是“可靠性外壳”。前面章节让 Agent 能做事；这一章让用户在 Agent 做不了事时知道为什么。

下面继续把第 66 章落到更具体的 `health runner` 实现层。

---

## 66.44 Health Core 与 CLI Script 分层

`bun run health` 不应该把所有逻辑都写在 `scripts/health-check.ts` 里。

更好的分层：

```text
src/health/
  types.ts
  collect.ts
  collectors/
    runtime.ts
    installation.ts
    updates.ts
    settings.ts
    environment.ts
    workspace.ts
    commands.ts
    extensions.ts
    context.ts
  format/
    text.ts
    json.ts
  repair/
    actions.ts
    planner.ts
  exitCode.ts

scripts/
  health-check.ts
```

职责：

- `src/health/*` 是可测试库。
- `scripts/health-check.ts` 只负责解析参数、调用 collector、打印输出、设置退出码。
- `/doctor` 可以复用 `src/health` 的部分 collector。
- `/status` 仍然保持轻量，不跑长任务。

这样后续要给 `claude doctor --json`、CI、release gate 复用时，不需要复制逻辑。

---

## 66.45 Health Runner 参数设计

建议支持这些参数：

```ts
export type HealthFormat = "text" | "json";
export type HealthProfile = "quick" | "default" | "full";

export type HealthCliOptions = {
  format: HealthFormat;
  profile: HealthProfile;
  strict: boolean;
  includeNetwork: boolean;
  includeCommands: boolean;
  categories: string[];
};
```

语义：

- `quick`：只做文件、配置、运行时检查，不跑外部命令。
- `default`：跑快速本地命令，比如 typecheck。
- `full`：跑 build、smoke test、bundle 检查。
- `strict`：warning 也导致非 0 退出码。
- `includeNetwork`：允许检查最新版本、release endpoint、远程可达性。
- `includeCommands`：允许执行子命令。

命令示例：

```bash
bun run health
bun run health -- --json
bun run health -- --strict
bun run health -- --profile quick
bun run health -- --profile full
bun run health -- --category settings
```

不要让默认 health 依赖网络。网络失败经常是环境问题，不应该阻断本地诊断。

---

## 66.46 参数解析器

不需要引入复杂依赖，脚本参数可以手写解析。

```ts
import type { HealthCliOptions, HealthProfile } from "../src/health/types";

const VALID_PROFILES = new Set(["quick", "default", "full"]);

export function parseHealthArgs(argv: string[]): HealthCliOptions {
  const options: HealthCliOptions = {
    format: "text",
    profile: "default",
    strict: false,
    includeNetwork: false,
    includeCommands: true,
    categories: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--json") {
      options.format = "json";
      continue;
    }

    if (arg === "--strict") {
      options.strict = true;
      continue;
    }

    if (arg === "--network") {
      options.includeNetwork = true;
      continue;
    }

    if (arg === "--no-commands") {
      options.includeCommands = false;
      continue;
    }

    if (arg === "--profile") {
      const value = argv[++i];
      if (!value || !VALID_PROFILES.has(value)) {
        throw new Error(`Invalid --profile value: ${value ?? "(missing)"}`);
      }
      options.profile = value as HealthProfile;
      continue;
    }

    if (arg === "--category") {
      const value = argv[++i];
      if (!value) {
        throw new Error("Missing --category value");
      }
      options.categories.push(value);
      continue;
    }

    throw new Error(`Unknown health option: ${arg}`);
  }

  if (options.profile === "quick") {
    options.includeCommands = false;
  }

  return options;
}
```

脚本报错时应该打印 usage，并返回 `3`：

```ts
export function formatHealthUsage(): string {
  return [
    "Usage: bun run health -- [options]",
    "",
    "Options:",
    "  --json                Print JSON report",
    "  --strict              Treat warnings as failure",
    "  --network             Include network checks",
    "  --no-commands         Do not run subprocess checks",
    "  --profile <name>      quick | default | full",
    "  --category <name>     Limit to a diagnostic category",
  ].join("\n");
}
```

---

## 66.47 `scripts/health-check.ts` 入口

入口文件要薄。

```ts
#!/usr/bin/env bun

import { collectHealthReport } from "../src/health/collect";
import { getHealthExitCode } from "../src/health/exitCode";
import { formatHealthJson } from "../src/health/format/json";
import { formatHealthText } from "../src/health/format/text";
import {
  formatHealthUsage,
  parseHealthArgs,
} from "../src/health/parseArgs";

async function main(): Promise<number> {
  let options;

  try {
    options = parseHealthArgs(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("");
    console.error(formatHealthUsage());
    return 3;
  }

  try {
    const report = await collectHealthReport(options);
    const output =
      options.format === "json"
        ? formatHealthJson(report)
        : formatHealthText(report);

    console.log(output);
    return getHealthExitCode(report, options.strict);
  } catch (error) {
    console.error("Health runner failed");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    return 3;
  }
}

process.exitCode = await main();
```

注意两点：

- 使用 `Bun.argv`，保持 Bun 运行时语义。
- 脚本自身崩溃返回 `3`，不要和诊断失败混在一起。

---

## 66.48 Collector 注册表

用注册表管理 collector，便于按 category 过滤。

```ts
import type {
  DiagnosticCategory,
  DiagnosticItem,
  HealthCliOptions,
} from "./types";

export type HealthCollector = {
  category: DiagnosticCategory;
  name: string;
  collect(options: HealthCliOptions): Promise<DiagnosticItem[]>;
};

export const collectors: HealthCollector[] = [
  runtimeCollector,
  installationCollector,
  updateCollector,
  settingsCollector,
  environmentCollector,
  searchCollector,
  sandboxCollector,
  workspaceCollector,
  extensionCollector,
  contextCollector,
];
```

过滤：

```ts
export function selectCollectors(
  all: HealthCollector[],
  categories: string[],
): HealthCollector[] {
  if (categories.length === 0) {
    return all;
  }

  const wanted = new Set(categories);
  return all.filter(collector => wanted.has(collector.category));
}
```

collector 不应该互相调用。需要共享数据时，放到 `HealthCollectionContext`。

---

## 66.49 Collection Context

为了避免重复读取配置，可以建一个上下文对象。

```ts
export type HealthCollectionContext = {
  cwd: string;
  startedAt: number;
  runtime: RuntimeSnapshot;
  readText(path: string): Promise<string>;
  fileExists(path: string): Promise<boolean>;
  runCommand(command: string[], timeoutMs: number): Promise<CommandCheckResult>;
};
```

创建：

```ts
export function createHealthContext(): HealthCollectionContext {
  return {
    cwd: process.cwd(),
    startedAt: Date.now(),
    runtime: collectRuntimeSnapshot(),
    readText: path => Bun.file(path).text(),
    fileExists: async path => await Bun.file(path).exists(),
    runCommand,
  };
}
```

测试时可以注入假的 `readText`、`fileExists` 和 `runCommand`，不用真的碰文件系统。

---

## 66.50 Runtime Collector

Runtime collector 永远应该成功。

```ts
export function collectRuntimeSnapshot(): RuntimeSnapshot {
  return {
    platform: process.platform,
    arch: process.arch,
    bunVersion: typeof Bun !== "undefined" ? Bun.version : null,
    nodeVersion: process.version,
    pid: process.pid,
  };
}

export const runtimeCollector: HealthCollector = {
  category: "runtime",
  name: "runtime",
  async collect() {
    const snapshot = collectRuntimeSnapshot();

    return [
      {
        id: "runtime.snapshot",
        category: "runtime",
        severity: "ok",
        title: "Runtime snapshot collected",
        detail: [
          `platform=${snapshot.platform}`,
          `arch=${snapshot.arch}`,
          `bun=${snapshot.bunVersion ?? "n/a"}`,
          `node=${snapshot.nodeVersion}`,
        ].join("\n"),
        safeToAutoFix: false,
      },
    ];
  },
};
```

`runtime` 信息在 JSON 里也会作为顶层字段出现，所以这个 item 可以在文本模式展示，在 JSON 消费端可忽略。

---

## 66.51 Workspace File Collector

工作区检查应该先从存在性开始。

```ts
const REQUIRED_FILES = [
  "package.json",
  "tsconfig.json",
  "src/entrypoints/cli.tsx",
  "scripts/defines.ts",
];

export const workspaceFileCollector: HealthCollector = {
  category: "workspace",
  name: "workspace-files",
  async collect(_options, context) {
    const items: DiagnosticItem[] = [];

    for (const file of REQUIRED_FILES) {
      const exists = await context.fileExists(file);
      items.push({
        id: `workspace.file.${file}`,
        category: "workspace",
        severity: exists ? "ok" : "error",
        title: exists ? `Found ${file}` : `Missing ${file}`,
        detail: file,
        fix: exists ? undefined : "Restore the required project file.",
        safeToAutoFix: false,
      });
    }

    return items;
  },
};
```

这种检查非常快，适合 `quick` profile。

---

## 66.52 Script Target Collector

当前仓库最明显的 health 缺口是脚本指向不存在文件。可以做一个通用 collector 检查 script target。

```ts
export async function collectScriptTargets(
  context: HealthCollectionContext,
): Promise<DiagnosticItem[]> {
  const raw = await context.readText("package.json");
  const pkg = JSON.parse(raw) as {
    scripts?: Record<string, string>;
  };

  const items: DiagnosticItem[] = [];
  const healthScript = pkg.scripts?.health;

  if (!healthScript) {
    items.push({
      id: "workspace.script.health.missing",
      category: "workspace",
      severity: "error",
      title: "Missing health script",
      fix: "Add a health script to package.json.",
      safeToAutoFix: false,
    });
    return items;
  }

  const match = healthScript.match(/bun run ([^\s]+)/);
  const target = match?.[1];
  if (!target) {
    return items;
  }

  const exists = await context.fileExists(target);
  if (!exists) {
    items.push({
      id: "workspace.script.health.target-missing",
      category: "workspace",
      severity: "error",
      title: "Health script target is missing",
      detail: `package.json health script points to ${target}`,
      fix: "Create the target file or update the health script.",
      safeToAutoFix: false,
    });
  }

  return items;
}
```

这一类检查能发现很多“脚本看起来存在，但实际跑不了”的问题。

---

## 66.53 Command Collector Profile

不同 profile 跑不同命令。

```ts
export function getCommandChecksForProfile(profile: HealthProfile): Array<{
  id: string;
  title: string;
  command: string[];
  timeoutMs: number;
}> {
  if (profile === "quick") {
    return [];
  }

  const checks = [
    {
      id: "workspace.typecheck",
      title: "Typecheck",
      command: ["bun", "run", "typecheck"],
      timeoutMs: 120_000,
    },
  ];

  if (profile === "full") {
    checks.push(
      {
        id: "workspace.build",
        title: "Build",
        command: ["bun", "run", "build"],
        timeoutMs: 180_000,
      },
      {
        id: "workspace.version-smoke",
        title: "CLI version smoke",
        command: ["bun", "run", "src/entrypoints/cli.tsx", "--version"],
        timeoutMs: 30_000,
      },
    );
  }

  return checks;
}
```

`full` profile 可以比较慢，但必须可预测。

---

## 66.54 Command 输出截断与脱敏

命令输出也可能带敏感信息。要先脱敏再截断。

```ts
const SECRET_VALUE_PATTERNS = [
  /(api[_-]?key|token|secret|password|credential)=([^\s]+)/gi,
  /(Authorization:\s*Bearer\s+)([^\s]+)/gi,
];

export function redactSecretsFromOutput(output: string): string {
  let redacted = output;

  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, prefix) => {
      return `${prefix}=***`;
    });
  }

  return redacted;
}

export function truncateOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) {
    return output;
  }

  return `${output.slice(0, maxChars)}\n...[truncated]`;
}

export function sanitizeCommandOutput(output: string): string {
  return truncateOutput(redactSecretsFromOutput(output), 4000);
}
```

如果正则处理 Authorization 这类没有 `=` 的值，可以拆成两个 replacer，避免把前缀格式弄错。上面只是表达结构，真实实现要加测试。

---

## 66.55 Command Collector

```ts
export const commandCollector: HealthCollector = {
  category: "workspace",
  name: "commands",
  async collect(options, context) {
    if (!options.includeCommands) {
      return [
        {
          id: "workspace.commands.skipped",
          category: "workspace",
          severity: "info",
          title: "Command checks skipped",
          detail: "Command execution is disabled for this health run.",
          safeToAutoFix: false,
        },
      ];
    }

    const checks = getCommandChecksForProfile(options.profile);
    const items: DiagnosticItem[] = [];

    for (const check of checks) {
      const result = await context.runCommand(check.command, check.timeoutMs);
      const passed = result.code === 0;

      items.push({
        id: check.id,
        category: "workspace",
        severity: passed ? "ok" : "error",
        title: passed ? `${check.title} passed` : `${check.title} failed`,
        detail: passed
          ? `${result.durationMs}ms`
          : sanitizeCommandOutput(result.stderr || result.stdout),
        fix: passed ? undefined : `Run ${check.command.join(" ")} and fix the reported errors.`,
        command: check.command.join(" "),
        safeToAutoFix: false,
      });
    }

    return items;
  },
};
```

这里串行执行命令是合理的。typecheck 和 build 同时跑会争抢资源，也会让错误输出更难读。

---

## 66.56 Text Formatter

文本输出给人看，必须短。

```ts
export function formatHealthText(report: DoctorReport): string {
  const lines: string[] = [];

  lines.push("Claude Code Health");
  lines.push(`Version: ${report.version}`);
  lines.push(`CWD: ${report.cwd}`);
  lines.push(
    `Summary: ${report.summary.ok} ok, ${report.summary.info} info, ${report.summary.warning} warning, ${report.summary.error} error`,
  );
  lines.push("");

  for (const item of sortDiagnostics(report.items)) {
    if (item.severity === "ok") {
      continue;
    }

    lines.push(`[${item.severity}] ${item.id}`);
    lines.push(item.title);

    if (item.detail) {
      lines.push(indent(item.detail, "  "));
    }

    if (item.fix) {
      lines.push(`Fix: ${item.fix}`);
    }

    if (item.command) {
      lines.push(`Command: ${item.command}`);
    }

    lines.push("");
  }

  if (report.summary.error === 0 && report.summary.warning === 0) {
    lines.push("No health issues found.");
  }

  return lines.join("\n").trimEnd();
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map(line => `${prefix}${line}`)
    .join("\n");
}
```

默认不展示 ok 项，避免正常输出太长。JSON 可以保留所有项。

---

## 66.57 JSON Formatter

JSON 输出要稳定，且不要包含 React Node。

```ts
export type JsonDoctorReport = {
  generatedAt: string;
  version: string;
  cwd: string;
  runtime: RuntimeSnapshot;
  summary: DoctorReport["summary"];
  items: Array<{
    id: string;
    category: DiagnosticCategory;
    severity: DiagnosticSeverity;
    title: string;
    detail?: string;
    fix?: string;
    command?: string;
    docsUrl?: string;
    safeToAutoFix: boolean;
  }>;
};

export function toJsonDoctorReport(report: DoctorReport): JsonDoctorReport {
  return {
    generatedAt: report.generatedAt,
    version: report.version,
    cwd: report.cwd,
    runtime: report.runtime,
    summary: report.summary,
    items: report.items.map(item => ({
      id: item.id,
      category: item.category,
      severity: item.severity,
      title: item.title,
      detail: item.detail,
      fix: item.fix,
      command: item.command,
      docsUrl: item.docsUrl,
      safeToAutoFix: item.safeToAutoFix,
    })),
  };
}

export function formatHealthJson(report: DoctorReport): string {
  return JSON.stringify(toJsonDoctorReport(report), null, 2);
}
```

不要把 Error 对象、函数、React 元素塞进 JSON。

---

## 66.58 Doctor UI 复用 Health Core

`/doctor` 不应该直接输出 `DoctorReport` 的所有内容。它应该挑选适合交互展示的部分。

```ts
export function selectDoctorItems(report: DoctorReport): DiagnosticItem[] {
  return report.items.filter(item => {
    if (item.category === "workspace") {
      return false;
    }

    if (item.severity === "ok") {
      return false;
    }

    return true;
  });
}
```

原因：

- workspace typecheck/build 更适合 `health`。
- `/doctor` 应该快。
- `/doctor` 是用户当前 CLI 的健康状态，不是仓库 release gate。

可以把 `/doctor` 页面改成：

```text
Diagnostics
Updates
Environment
Settings
Extensions
Context
Press Enter to continue
```

内部数据来自 shared collector，但展示仍然手工排版。

---

## 66.59 `/status` 不应替代 `/doctor`

`/status` 是快照，不是排障报告。

它适合展示：

- Version
- Session ID
- cwd
- Model
- Account
- Provider
- IDE
- MCP summary
- Sandbox summary
- Setting sources

不适合展示：

- 长错误列表。
- 修复命令。
- build/typecheck 输出。
- 复杂上下文告警细节。
- 自动修复入口。

这样用户的心理模型更清晰：

```text
/status: 当前状态
/doctor: 为什么异常
health: 可自动化检查
```

---

## 66.60 Health 与 Release Gate 的边界

`health --full` 可以作为 release gate 的一部分，但不应该包含所有 release 逻辑。

推荐：

```text
health --full
  -> 本地健康
  -> typecheck
  -> build
  -> CLI smoke

release gate
  -> health --full
  -> bundle integrity
  -> signed artifact checks
  -> release notes
  -> cross-platform matrix
```

也就是说：health 是 release gate 的输入，不是 release gate 本身。

---

## 66.61 CLI Smoke Test

构建后的 CLI 至少要做 smoke：

```bash
bun run build
bun dist/cli.js --version
```

如果构建产物也支持 Node 运行，可以加：

```bash
node dist/cli.js --version
```

这条 smoke test 很有价值。很多 bundle 问题 typecheck 看不出来，只有运行入口时才会暴露。

Health full profile 可以先只跑 Bun 路径；跨运行时路径放到发布章节。

---

## 66.62 Health Collector 的单测策略

每个 collector 都应该只测自己的判断逻辑。

不要在单测里真的跑 `bun run build`。

示例：

```ts
import { describe, expect, test } from "bun:test";
import { collectScriptTargets } from "../collectors/workspace";

describe("collectScriptTargets", () => {
  test("reports missing health script target", async () => {
    const items = await collectScriptTargets({
      readText: async () =>
        JSON.stringify({
          scripts: {
            health: "bun run scripts/health-check.ts",
          },
        }),
      fileExists: async path => path !== "scripts/health-check.ts",
    } as never);

    expect(items).toContainEqual(
      expect.objectContaining({
        id: "workspace.script.health.target-missing",
        severity: "error",
      }),
    );
  });
});
```

运行：

```bash
bun test src/health/collectors/workspace.test.ts
```

---

## 66.63 Formatter 单测策略

formatter 的测试要固定输出。

```ts
import { describe, expect, test } from "bun:test";
import { formatHealthText } from "../format/text";

describe("formatHealthText", () => {
  test("prints warnings with fixes", () => {
    const output = formatHealthText({
      generatedAt: "2026-05-27T00:00:00.000Z",
      version: "2.1.888",
      cwd: "/repo",
      runtime: {
        platform: "darwin",
        arch: "arm64",
        bunVersion: "1.2.0",
        nodeVersion: "v22.0.0",
        pid: 1,
      },
      summary: { ok: 0, info: 0, warning: 1, error: 0 },
      items: [
        {
          id: "settings.invalid",
          category: "settings",
          severity: "warning",
          title: "Invalid settings file",
          fix: "Fix the settings syntax.",
          safeToAutoFix: false,
        },
      ],
    });

    expect(output).toContain("[warning] settings.invalid");
    expect(output).toContain("Fix: Fix the settings syntax.");
  });
});
```

运行：

```bash
bun test src/health/format/text.test.ts
```

---

## 66.64 Exit Code 单测

```ts
import { describe, expect, test } from "bun:test";
import { getHealthExitCode } from "../exitCode";

describe("getHealthExitCode", () => {
  test("returns 2 when errors exist", () => {
    expect(
      getHealthExitCode(
        report({ ok: 0, info: 0, warning: 0, error: 1 }),
        false,
      ),
    ).toBe(2);
  });

  test("returns 1 for warnings in strict mode", () => {
    expect(
      getHealthExitCode(
        report({ ok: 0, info: 0, warning: 1, error: 0 }),
        true,
      ),
    ).toBe(1);
  });

  test("returns 0 for warnings outside strict mode", () => {
    expect(
      getHealthExitCode(
        report({ ok: 0, info: 0, warning: 1, error: 0 }),
        false,
      ),
    ).toBe(0);
  });
});
```

运行：

```bash
bun test src/health/exitCode.test.ts
```

---

## 66.65 修复动作的审计记录

如果未来支持 `doctor --fix`，每个修复动作都应该留下本地审计记录。

类型：

```ts
export type RepairAuditRecord = {
  id: string;
  actionId: string;
  startedAt: string;
  completedAt?: string;
  status: "started" | "succeeded" | "failed";
  detail?: string;
};
```

写入位置可以是 Claude config/state 目录下的本地文件。内容不要包含 secret。

目的：

- 用户知道发生过什么。
- 维护者能排查修复动作是否执行过。
- 失败修复可以重新尝试。

---

## 66.66 Health Report 的隐私边界

用户经常会把 health JSON 发到 issue 或聊天里。

所以 JSON 也必须默认安全：

- 不输出完整环境变量值。
- 不输出完整 token。
- 不输出完整 Authorization header。
- 不输出私有 repo remote URL 中的凭据。
- 不输出 home 目录之外不必要的文件内容。
- 不输出配置文件原文。

可以输出：

- 文件路径。
- 版本号。
- 安装路径。
- 错误类型。
- 错误摘要。
- 已脱敏的 base URL。
- 数量统计。

这是诊断工具的底线。

---

## 66.67 第 66 章补充验收标准

追加本节后，第 66 章的落地验收再补几条：

- `src/health` 是可测试库，不依赖 Ink。
- `scripts/health-check.ts` 只做 CLI glue。
- `health --profile quick` 不执行外部命令。
- `health --profile default` 至少能跑 typecheck。
- `health --profile full` 能跑 build 和 CLI smoke。
- 文本输出默认隐藏 ok 项。
- JSON 输出字段稳定。
- 所有 command output 都经过脱敏和截断。
- 单个 collector 失败不会导致整份 report 丢失。
- 退出码区分 diagnostic failure 和 runner crash。
- `doctor --fix` 如果实现，默认必须二次确认。

---

## 66.68 本章扩展小结

这一轮继续把第 66 章从“功能设计”推进到了“可实现的 health runner 架构”。

最终结构应该是：

```text
/status
  -> 快速会话状态

/doctor
  -> 交互式本机诊断

/env
  -> 脱敏环境快照

bun run health
  -> 非交互式、自带退出码、可进 CI 的健康检查
```

这四个入口互相补位，而不是互相替代。

下一章建议继续补：发布与分发链路，包括 build 产物完整性、bundle 校验、版本元信息、release note、安装迁移、rollback safe pin 和跨平台 smoke test。
