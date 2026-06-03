# 第 35 章：项目级规则与配置系统

第三十四章做了验证 Agent 和交付门禁。

现在 Mini 已经有很多“可调参数”：

- 用哪个模型。
- 默认权限模式是什么。
- 哪些工具规则默认允许或拒绝。
- 验证时默认跑哪些命令。
- batch / worktree 是否需要特殊目录策略。
- 沙箱默认开不开。
- Agent 的默认轮数和后台策略。

如果这些都散落在代码里，Mini 很快会变成一个只能作者自己维护的 demo。

真正长期可用的本地 Agent 工具，必须有配置系统。

本章要做的不是简单读一个 JSON 文件，而是实现一条稳定的配置链路：

```text
配置文件 -> schema 校验 -> 多来源合并 -> Config 工具读写 -> 各模块消费
```

做到这一步以后，用户不需要改代码就能调整 Mini 的行为。

## 真实工程怎么做

真实工程的配置系统主要分成两层：

第一层是旧的全局配置：

- `src/utils/config.ts`：维护全局配置、项目配置、统计信息、历史状态、trust 状态等。
- 全局配置里有 `GlobalConfig`，项目配置里有 `ProjectConfig`。

第二层是新的 settings 系统：

- `src/utils/settings/types.ts`：用 `zod` 定义 `SettingsSchema`。这里包含 `permissions`、`model`、`modelType`、`hooks`、`worktree`、`sandbox`、MCP allowlist 等。
- `src/utils/settings/constants.ts`：定义 settings source。真实工程支持 `userSettings`、`projectSettings`、`localSettings`、`flagSettings`、`policySettings`。
- `src/utils/settings/settings.ts`：负责读取、校验、缓存、合并、更新 settings。
- `packages/builtin-tools/src/tools/ConfigTool/ConfigTool.ts`：提供模型可调用的 `Config` 工具，可以读取或修改支持的设置。
- `packages/builtin-tools/src/tools/ConfigTool/supportedSettings.ts`：配置哪些 key 可被 `Config` 工具读写，以及每个 key 的来源、类型、可选值、校验器和 AppState 同步字段。
- `src/utils/permissions/permissionsLoader.ts`：从 settings 中加载 `permissions.allow`、`permissions.deny`、`permissions.ask`。
- `src/utils/model/providers.ts`：根据 settings 里的 `modelType` 和环境变量选择 API provider。
- `src/utils/model/model.ts`：根据会话 override、环境变量和 settings 选择主循环模型。

真实工程有几个重要设计：

```text
1. 配置来源有优先级，后面的来源覆盖前面的来源。
2. settings 用 schema 校验，坏配置不会悄悄进入运行时。
3. 读配置和写配置不是一回事。
4. Config 工具只允许读写注册过的 key。
5. 权限、模型、worktree、验证等模块只消费合并后的 effective settings。
```

Mini 本章复刻这条主线，但简化掉企业托管策略和远程 settings。

## 本章目标

完成后，Mini 支持三个配置文件：

```text
~/.claude-code-mini/settings.json
.mini/settings.json
.mini/settings.local.json
```

含义是：

```text
全局 user settings：个人偏好，所有项目共享。
项目 project settings：项目共享规则，可以提交到仓库。
本地 local settings：只对当前机器生效，默认加入 gitignore。
```

合并优先级：

```text
built-in defaults
  < user settings
  < project settings
  < local settings
  < session overrides
```

完成后可以运行：

```bash
bun run src/cli.ts config list
bun run src/cli.ts config get model.name
bun run src/cli.ts config set model.name sonnet --source project
bun run src/cli.ts config set permissions.defaultMode acceptEdits --source local
bun run src/cli.ts config set verification.enabled true --source project
```

本章要实现：

- settings schema。
- settings source 和路径。
- JSON 解析与校验。
- 多来源合并。
- 写入指定 source。
- `config get/list/set` 命令。
- `Config` 工具。
- 模型、权限、验证、worktree、sandbox 从配置读取。
- 配置测试。

## 推荐目录

新增：

```text
src/config/
  configTypes.ts
  configDefaults.ts
  configPaths.ts
  configSchema.ts
  configMerge.ts
  configLoader.ts
  configWriter.ts
  configRegistry.ts
  configTool.ts
  configCommand.ts

src/model/
  modelConfig.ts
```

修改：

```text
src/cli.ts
src/tools/toolRegistry.ts
src/permissions/permissionEngine.ts
src/verification/recommendedCommands.ts
src/worktrees/agentWorktree.ts
src/sandbox/sandboxPolicy.ts
```

如果你的 Mini 目录结构和这里不同，保持职责一致即可。

## 配置不应该放什么

先明确边界。

配置文件里可以放：

- 模型名。
- provider 类型。
- 权限规则。
- 默认验证命令。
- worktree 策略。
- 沙箱策略。
- 非敏感环境变量。

配置文件里不要放：

- API key。
- token。
- 私钥。
- cookie。
- 账号密码。

需要密钥时，只写环境变量名。

例如：

```json
{
  "model": {
    "provider": "anthropic",
    "name": "sonnet",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  }
}
```

不要写：

```json
{
  "model": {
    "apiKey": "sk-..."
  }
}
```

Mini 的 schema 里也不要设计 `apiKey` 字段。

## Settings 类型

先定义完整类型。

```ts
// src/config/configTypes.ts
export type ConfigSource =
  | "defaults"
  | "user"
  | "project"
  | "local"
  | "session";

export type ModelProvider = "anthropic" | "openai" | "gemini" | "grok";

export type PermissionMode = "ask" | "plan" | "acceptEdits" | "dontAsk";

export type MiniSettings = {
  model?: {
    provider?: ModelProvider;
    name?: string;
    smallFast?: string;
    apiKeyEnv?: string;
    baseUrlEnv?: string;
  };
  permissions?: {
    defaultMode?: PermissionMode;
    allow?: string[];
    deny?: string[];
    ask?: string[];
    additionalDirectories?: string[];
  };
  verification?: {
    enabled?: boolean;
    requiredChangedFiles?: number;
    commands?: string[];
    alwaysVerify?: string[];
  };
  worktree?: {
    enabled?: boolean;
    symlinkDirectories?: string[];
    sparsePaths?: string[];
  };
  sandbox?: {
    enabled?: boolean;
    network?: "allow" | "deny";
    write?: "workspace" | "none";
  };
  agents?: {
    maxTurns?: number;
    allowBackground?: boolean;
    defaultModel?: string;
  };
  env?: Record<string, string>;
};

export type EffectiveSettings = Required<{
  model: Required<MiniSettings["model"]>;
  permissions: Required<MiniSettings["permissions"]>;
  verification: Required<MiniSettings["verification"]>;
  worktree: Required<MiniSettings["worktree"]>;
  sandbox: Required<MiniSettings["sandbox"]>;
  agents: Required<MiniSettings["agents"]>;
  env: Record<string, string>;
}>;
```

这里分成两个类型：

```text
MiniSettings：文件里允许只写一部分。
EffectiveSettings：合并 defaults 后，运行时拿到的是完整配置。
```

运行时模块不要到处判断 `undefined`。

它们应该消费 `EffectiveSettings`。

## 默认配置

写一份内置默认值。

```ts
// src/config/configDefaults.ts
import type { EffectiveSettings } from "./configTypes";

export const DEFAULT_SETTINGS: EffectiveSettings = {
  model: {
    provider: "anthropic",
    name: "sonnet",
    smallFast: "haiku",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
  },
  permissions: {
    defaultMode: "ask",
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
  },
  verification: {
    enabled: true,
    requiredChangedFiles: 3,
    commands: ["bun run typecheck"],
    alwaysVerify: ["src/api/**", "src/tools/**", "src/permissions/**"],
  },
  worktree: {
    enabled: true,
    symlinkDirectories: [],
    sparsePaths: [],
  },
  sandbox: {
    enabled: false,
    network: "deny",
    write: "workspace",
  },
  agents: {
    maxTurns: 12,
    allowBackground: true,
    defaultModel: "inherit",
  },
  env: {},
};
```

默认配置应该保守：

- 权限默认询问。
- 验证默认开启。
- 沙箱网络默认拒绝。
- worktree 默认允许。
- API key 只通过环境变量读取。

## Schema 校验

继续用前面章节已经引入的 `zod`。

```ts
// src/config/configSchema.ts
import { z } from "zod";

export const modelProviderSchema = z.enum([
  "anthropic",
  "openai",
  "gemini",
  "grok",
]);

export const permissionModeSchema = z.enum([
  "ask",
  "plan",
  "acceptEdits",
  "dontAsk",
]);

export const miniSettingsSchema = z
  .object({
    model: z
      .object({
        provider: modelProviderSchema.optional(),
        name: z.string().min(1).optional(),
        smallFast: z.string().min(1).optional(),
        apiKeyEnv: z.string().min(1).optional(),
        baseUrlEnv: z.string().min(1).optional(),
      })
      .optional(),
    permissions: z
      .object({
        defaultMode: permissionModeSchema.optional(),
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
        ask: z.array(z.string()).optional(),
        additionalDirectories: z.array(z.string()).optional(),
      })
      .optional(),
    verification: z
      .object({
        enabled: z.boolean().optional(),
        requiredChangedFiles: z.number().int().min(1).optional(),
        commands: z.array(z.string()).optional(),
        alwaysVerify: z.array(z.string()).optional(),
      })
      .optional(),
    worktree: z
      .object({
        enabled: z.boolean().optional(),
        symlinkDirectories: z.array(z.string()).optional(),
        sparsePaths: z.array(z.string()).optional(),
      })
      .optional(),
    sandbox: z
      .object({
        enabled: z.boolean().optional(),
        network: z.enum(["allow", "deny"]).optional(),
        write: z.enum(["workspace", "none"]).optional(),
      })
      .optional(),
    agents: z
      .object({
        maxTurns: z.number().int().min(1).max(100).optional(),
        allowBackground: z.boolean().optional(),
        defaultModel: z.string().min(1).optional(),
      })
      .optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();
```

真实工程的 settings schema 非常大，而且为了兼容会保留很多历史字段。

Mini 不需要一开始就这样。

这里用 `.strict()` 是为了早期尽快发现拼写错误。

例如用户写错：

```json
{
  "verfication": {
    "enabled": true
  }
}
```

应该报错，而不是悄悄忽略。

## 配置路径

写 source 到路径的映射。

```ts
// src/config/configPaths.ts
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigSource } from "./configTypes";

export function getConfigPathForSource(input: {
  cwd: string;
  source: Exclude<ConfigSource, "defaults" | "session">;
}): string {
  switch (input.source) {
    case "user":
      return join(homedir(), ".claude-code-mini", "settings.json");
    case "project":
      return join(input.cwd, ".mini", "settings.json");
    case "local":
      return join(input.cwd, ".mini", "settings.local.json");
  }
}
```

为什么不用一个 `.mini/config.json`？

因为用户偏好和项目规则不是一回事：

```text
user：我个人喜欢的模型、主题、默认响应语言。
project：这个项目要求的验证命令、权限边界、worktree 策略。
local：我这台机器上的端口、临时目录、本地覆盖。
```

分开后，配置冲突少很多。

## JSON 读取

实现读取和报错结构。

```ts
// src/config/configLoader.ts
import { readFile } from "node:fs/promises";
import type { ConfigSource, MiniSettings } from "./configTypes";
import { getConfigPathForSource } from "./configPaths";
import { miniSettingsSchema } from "./configSchema";

export type ConfigLoadError = {
  source: ConfigSource;
  filePath: string;
  message: string;
};

export type LoadedSettings = {
  source: ConfigSource;
  filePath?: string;
  settings: MiniSettings;
};

export async function loadSettingsForSource(input: {
  cwd: string;
  source: Exclude<ConfigSource, "defaults" | "session">;
}): Promise<{ loaded?: LoadedSettings; error?: ConfigLoadError }> {
  const filePath = getConfigPathForSource(input);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefinedResult();
    }

    return {
      error: {
        source: input.source,
        filePath,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  if (raw.trim() === "") {
    return {
      loaded: {
        source: input.source,
        filePath,
        settings: {},
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      error: {
        source: input.source,
        filePath,
        message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  const result = miniSettingsSchema.safeParse(parsed);

  if (!result.success) {
    return {
      error: {
        source: input.source,
        filePath,
        message: result.error.issues
          .map(issue => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("\n"),
      },
    };
  }

  return {
    loaded: {
      source: input.source,
      filePath,
      settings: result.data,
    },
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function undefinedResult(): { loaded?: LoadedSettings; error?: ConfigLoadError } {
  return {};
}
```

坏配置不要直接吞掉。

但也不要用坏配置继续运行。

Mini 可以在启动时显示错误，然后继续使用其它来源的配置。

## 合并规则

真实工程里有一个细节：

```text
读取时数组合并去重。
写入时数组替换。
```

Mini 也采用这个规则。

原因是：

```text
读取时：user allow + project allow + local allow 都应该生效。
写入时：用户 set verification.commands 应该得到自己指定的完整数组。
```

先写 merge。

```ts
// src/config/configMerge.ts
import { DEFAULT_SETTINGS } from "./configDefaults";
import type { EffectiveSettings, MiniSettings } from "./configTypes";

export function mergeSettings(
  sources: MiniSettings[],
): EffectiveSettings {
  let result: EffectiveSettings = structuredClone(DEFAULT_SETTINGS);

  for (const source of sources) {
    result = mergeOne(result, source);
  }

  return result;
}

function mergeOne(
  base: EffectiveSettings,
  patch: MiniSettings,
): EffectiveSettings {
  return {
    ...base,
    ...patch,
    model: {
      ...base.model,
      ...patch.model,
    },
    permissions: {
      ...base.permissions,
      ...patch.permissions,
      allow: mergeArray(base.permissions.allow, patch.permissions?.allow),
      deny: mergeArray(base.permissions.deny, patch.permissions?.deny),
      ask: mergeArray(base.permissions.ask, patch.permissions?.ask),
      additionalDirectories: mergeArray(
        base.permissions.additionalDirectories,
        patch.permissions?.additionalDirectories,
      ),
    },
    verification: {
      ...base.verification,
      ...patch.verification,
      commands: mergeArray(base.verification.commands, patch.verification?.commands),
      alwaysVerify: mergeArray(
        base.verification.alwaysVerify,
        patch.verification?.alwaysVerify,
      ),
    },
    worktree: {
      ...base.worktree,
      ...patch.worktree,
      symlinkDirectories: mergeArray(
        base.worktree.symlinkDirectories,
        patch.worktree?.symlinkDirectories,
      ),
      sparsePaths: mergeArray(base.worktree.sparsePaths, patch.worktree?.sparsePaths),
    },
    sandbox: {
      ...base.sandbox,
      ...patch.sandbox,
    },
    agents: {
      ...base.agents,
      ...patch.agents,
    },
    env: {
      ...base.env,
      ...patch.env,
    },
  };
}

function mergeArray<T>(base: T[], patch: T[] | undefined): T[] {
  if (!patch) {
    return base;
  }

  return [...new Set([...base, ...patch])];
}
```

这里选择数组合并而不是覆盖。

例如：

```json
{
  "permissions": {
    "deny": ["bash:rm -rf *"]
  }
}
```

如果 user 和 project 都写了 deny，它们应该都生效。

## 加载 Effective Settings

把 user、project、local 串起来。

```ts
// src/config/configLoader.ts
import type { EffectiveSettings, MiniSettings } from "./configTypes";
import { mergeSettings } from "./configMerge";

export type SettingsSnapshot = {
  effective: EffectiveSettings;
  sources: LoadedSettings[];
  errors: ConfigLoadError[];
};

export async function loadEffectiveSettings(input: {
  cwd: string;
  session?: MiniSettings;
}): Promise<SettingsSnapshot> {
  const sources: LoadedSettings[] = [];
  const errors: ConfigLoadError[] = [];

  for (const source of ["user", "project", "local"] as const) {
    const result = await loadSettingsForSource({
      cwd: input.cwd,
      source,
    });

    if (result.loaded) {
      sources.push(result.loaded);
    }

    if (result.error) {
      errors.push(result.error);
    }
  }

  if (input.session) {
    sources.push({
      source: "session",
      settings: input.session,
    });
  }

  return {
    effective: mergeSettings(sources.map(source => source.settings)),
    sources,
    errors,
  };
}
```

启动时可以这样用：

```ts
const settings = await loadEffectiveSettings({
  cwd: process.cwd(),
});

if (settings.errors.length > 0) {
  for (const error of settings.errors) {
    console.error(`[config:${error.source}] ${error.filePath}`);
    console.error(error.message);
  }
}
```

坏配置要让用户看见。

否则模型行为变化时很难排查。

## 写配置

写配置只允许写 user、project、local。

```ts
// src/config/configWriter.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MiniSettings } from "./configTypes";
import { getConfigPathForSource } from "./configPaths";
import { miniSettingsSchema } from "./configSchema";

export type EditableConfigSource = "user" | "project" | "local";

export async function updateSettingsForSource(input: {
  cwd: string;
  source: EditableConfigSource;
  update: MiniSettings;
}): Promise<void> {
  const filePath = getConfigPathForSource({
    cwd: input.cwd,
    source: input.source,
  });

  const existing = await readRawSettings(filePath);
  const next = mergeForWrite(existing, input.update);

  const result = miniSettingsSchema.safeParse(next);

  if (!result.success) {
    throw new Error(
      result.error.issues
        .map(issue => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("\n"),
    );
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(result.data, null, 2)}\n`, "utf8");
}

async function readRawSettings(filePath: string): Promise<MiniSettings> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) {
      return {};
    }

    const parsed = JSON.parse(raw) as unknown;
    const result = miniSettingsSchema.safeParse(parsed);

    if (!result.success) {
      throw new Error(`Existing config is invalid: ${result.error.message}`);
    }

    return result.data;
  } catch (error) {
    if (isNotFound(error)) {
      return {};
    }

    throw error;
  }
}

function mergeForWrite(base: MiniSettings, patch: MiniSettings): MiniSettings {
  return {
    ...base,
    ...patch,
    model: patch.model ? { ...base.model, ...patch.model } : base.model,
    permissions: patch.permissions
      ? { ...base.permissions, ...patch.permissions }
      : base.permissions,
    verification: patch.verification
      ? { ...base.verification, ...patch.verification }
      : base.verification,
    worktree: patch.worktree ? { ...base.worktree, ...patch.worktree } : base.worktree,
    sandbox: patch.sandbox ? { ...base.sandbox, ...patch.sandbox } : base.sandbox,
    agents: patch.agents ? { ...base.agents, ...patch.agents } : base.agents,
    env: patch.env ? { ...base.env, ...patch.env } : base.env,
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
```

注意这里没有对数组做追加。

因为这是写配置。

如果用户运行：

```bash
bun run src/cli.ts config set verification.commands '["bun run typecheck"]'
```

那 `verification.commands` 就应该变成这一组命令，而不是和旧数组无限叠加。

## 本地配置加入 gitignore

`.mini/settings.local.json` 不应该提交。

写 local source 时顺手确保 `.gitignore` 里有它。

```ts
// src/config/configWriter.ts
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function ensureLocalSettingsIgnored(cwd: string): Promise<void> {
  const gitignorePath = join(cwd, ".gitignore");
  const rule = ".mini/settings.local.json";

  let existing = "";
  try {
    existing = await readFile(gitignorePath, "utf8");
  } catch {
    existing = "";
  }

  const lines = existing.split("\n").map(line => line.trim());
  if (lines.includes(rule)) {
    return;
  }

  const prefix = existing.endsWith("\n") || existing.length === 0 ? "" : "\n";
  await appendFile(gitignorePath, `${prefix}${rule}\n`, "utf8");
}
```

然后在 `updateSettingsForSource` 末尾加：

```ts
if (input.source === "local") {
  await ensureLocalSettingsIgnored(input.cwd);
}
```

真实工程也会把 local settings 加入 gitignore。

这是一个很小但很重要的安全细节。

## Config Registry

不要让模型随便写任意 key。

定义一个可读写 key registry。

```ts
// src/config/configRegistry.ts
import type { EditableConfigSource } from "./configWriter";

export type ConfigValueType = "string" | "boolean" | "number" | "stringArray";

export type ConfigRegistryItem = {
  key: string;
  type: ConfigValueType;
  description: string;
  defaultSource: EditableConfigSource;
  options?: string[];
};

export const CONFIG_REGISTRY: ConfigRegistryItem[] = [
  {
    key: "model.provider",
    type: "string",
    description: "API provider",
    defaultSource: "user",
    options: ["anthropic", "openai", "gemini", "grok"],
  },
  {
    key: "model.name",
    type: "string",
    description: "Main loop model name or alias",
    defaultSource: "user",
  },
  {
    key: "permissions.defaultMode",
    type: "string",
    description: "Default tool permission mode",
    defaultSource: "local",
    options: ["ask", "plan", "acceptEdits", "dontAsk"],
  },
  {
    key: "verification.enabled",
    type: "boolean",
    description: "Enable verification gate",
    defaultSource: "project",
  },
  {
    key: "verification.requiredChangedFiles",
    type: "number",
    description: "Changed file threshold that requires verification",
    defaultSource: "project",
  },
  {
    key: "verification.commands",
    type: "stringArray",
    description: "Default verification commands",
    defaultSource: "project",
  },
  {
    key: "worktree.symlinkDirectories",
    type: "stringArray",
    description: "Directories symlinked into agent worktrees",
    defaultSource: "project",
  },
  {
    key: "sandbox.enabled",
    type: "boolean",
    description: "Enable sandbox execution by default",
    defaultSource: "project",
  },
];

export function getConfigRegistryItem(key: string): ConfigRegistryItem | undefined {
  return CONFIG_REGISTRY.find(item => item.key === key);
}
```

registry 的作用：

```text
1. 控制哪些 key 可以通过命令或工具修改。
2. 给模型生成工具说明。
3. 给 CLI list 展示说明。
4. 给 set 操作做类型转换和 options 校验。
```

## Path 读写工具

配置 key 使用点路径。

例如：

```text
verification.commands
permissions.defaultMode
```

写两个小工具。

```ts
// src/config/configPathValue.ts
export function getValueByPath(input: {
  object: unknown;
  path: string;
}): unknown {
  const parts = input.path.split(".");
  let current = input.object;

  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

export function buildObjectByPath(input: {
  path: string;
  value: unknown;
}): Record<string, unknown> {
  const parts = input.path.split(".");

  if (parts.length === 0) {
    return {};
  }

  const [head, ...rest] = parts;

  if (!head) {
    return {};
  }

  if (rest.length === 0) {
    return { [head]: input.value };
  }

  return {
    [head]: buildObjectByPath({
      path: rest.join("."),
      value: input.value,
    }),
  };
}
```

## 值解析

CLI 输入全是字符串，需要转成对应类型。

```ts
// src/config/configCommand.ts
import type { ConfigRegistryItem } from "./configRegistry";

export function parseConfigValue(
  item: ConfigRegistryItem,
  raw: string,
): string | boolean | number | string[] {
  if (item.type === "boolean") {
    if (raw === "true") {
      return true;
    }
    if (raw === "false") {
      return false;
    }
    throw new Error(`${item.key} requires true or false`);
  }

  if (item.type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new Error(`${item.key} requires a number`);
    }
    return value;
  }

  if (item.type === "stringArray") {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every(item => typeof item === "string")) {
      throw new Error(`${item.key} requires a JSON string array`);
    }
    return parsed;
  }

  if (item.options && !item.options.includes(raw)) {
    throw new Error(`Invalid value for ${item.key}. Options: ${item.options.join(", ")}`);
  }

  return raw;
}
```

数组用 JSON 字符串传：

```bash
bun run src/cli.ts config set verification.commands '["bun run typecheck","bun test"]'
```

这样比逗号分隔更稳定。

因为命令里本来就可能有逗号或空格。

## Config 命令

现在做 CLI 命令。

```ts
// src/config/configCommand.ts
import type { EditableConfigSource } from "./configWriter";
import { loadEffectiveSettings } from "./configLoader";
import { CONFIG_REGISTRY, getConfigRegistryItem } from "./configRegistry";
import { getValueByPath, buildObjectByPath } from "./configPathValue";
import { updateSettingsForSource } from "./configWriter";
import type { MiniSettings } from "./configTypes";

export async function handleConfigCommand(input: {
  cwd: string;
  argv: string[];
}): Promise<string> {
  const [action, key, rawValue, ...rest] = input.argv;

  if (!action || action === "list") {
    return renderConfigList(input.cwd);
  }

  if (action === "get") {
    if (!key) {
      return "Usage: config get <key>";
    }

    return renderConfigValue(input.cwd, key);
  }

  if (action === "set") {
    if (!key || rawValue === undefined) {
      return "Usage: config set <key> <value> [--source user|project|local]";
    }

    const source = readSource(rest);
    return setConfigValue({
      cwd: input.cwd,
      key,
      rawValue,
      source,
    });
  }

  return "Usage: config list | config get <key> | config set <key> <value>";
}

async function renderConfigList(cwd: string): Promise<string> {
  const snapshot = await loadEffectiveSettings({ cwd });
  const lines = ["Config:", ""];

  for (const item of CONFIG_REGISTRY) {
    const value = getValueByPath({
      object: snapshot.effective,
      path: item.key,
    });
    lines.push(`${item.key} = ${JSON.stringify(value)}  # ${item.description}`);
  }

  if (snapshot.errors.length > 0) {
    lines.push("", "Config errors:");
    for (const error of snapshot.errors) {
      lines.push(`- ${error.source}: ${error.message}`);
    }
  }

  return lines.join("\n");
}

async function renderConfigValue(cwd: string, key: string): Promise<string> {
  const item = getConfigRegistryItem(key);
  if (!item) {
    return `Unknown config key: ${key}`;
  }

  const snapshot = await loadEffectiveSettings({ cwd });
  const value = getValueByPath({
    object: snapshot.effective,
    path: key,
  });

  return `${key} = ${JSON.stringify(value)}`;
}

async function setConfigValue(input: {
  cwd: string;
  key: string;
  rawValue: string;
  source?: EditableConfigSource;
}): Promise<string> {
  const item = getConfigRegistryItem(input.key);
  if (!item) {
    return `Unknown config key: ${input.key}`;
  }

  const value = parseConfigValue(item, input.rawValue);
  const update = buildObjectByPath({
    path: input.key,
    value,
  }) as MiniSettings;

  const source = input.source ?? item.defaultSource;

  await updateSettingsForSource({
    cwd: input.cwd,
    source,
    update,
  });

  return `Set ${input.key} to ${JSON.stringify(value)} in ${source} settings`;
}

function readSource(argv: string[]): EditableConfigSource | undefined {
  const index = argv.indexOf("--source");
  if (index === -1) {
    return undefined;
  }

  const value = argv[index + 1];
  if (value === "user" || value === "project" || value === "local") {
    return value;
  }

  throw new Error("--source must be user, project, or local");
}
```

接到 `cli.ts`：

```ts
// src/cli.ts
import { handleConfigCommand } from "./config/configCommand";

if (process.argv[2] === "config") {
  const output = await handleConfigCommand({
    cwd: process.cwd(),
    argv: process.argv.slice(3),
  });

  console.log(output);
  process.exit(0);
}
```

测试一下：

```bash
bun run src/cli.ts config list
bun run src/cli.ts config get verification.enabled
bun run src/cli.ts config set verification.enabled true --source project
```

## Config 工具

CLI 是给用户用的。

模型也需要一个工具来读写配置。

```ts
// src/config/configTool.ts
import type { ToolDefinition } from "../tools/toolTypes";
import type { EditableConfigSource } from "./configWriter";
import { loadEffectiveSettings } from "./configLoader";
import { getConfigRegistryItem } from "./configRegistry";
import { getValueByPath, buildObjectByPath } from "./configPathValue";
import { parseConfigValue } from "./configCommand";
import { updateSettingsForSource } from "./configWriter";
import type { MiniSettings } from "./configTypes";

export type ConfigToolInput = {
  key: string;
  value?: string;
  source?: EditableConfigSource;
};

export function createConfigTool(input: {
  cwd: string;
}): ToolDefinition<ConfigToolInput, string> {
  return {
    name: "config",
    description: "Get or set Mini configuration settings",
    inputSchema: {
      type: "object",
      required: ["key"],
      properties: {
        key: { type: "string" },
        value: { type: "string" },
        source: {
          type: "string",
          enum: ["user", "project", "local"],
        },
      },
    },
    isReadOnly(args) {
      return args.value === undefined;
    },
    async call(args) {
      const item = getConfigRegistryItem(args.key);
      if (!item) {
        throw new Error(`Unknown config key: ${args.key}`);
      }

      if (args.value === undefined) {
        const snapshot = await loadEffectiveSettings({ cwd: input.cwd });
        const value = getValueByPath({
          object: snapshot.effective,
          path: args.key,
        });
        return `${args.key} = ${JSON.stringify(value)}`;
      }

      const value = parseConfigValue(item, args.value);
      const update = buildObjectByPath({
        path: args.key,
        value,
      }) as MiniSettings;

      await updateSettingsForSource({
        cwd: input.cwd,
        source: args.source ?? item.defaultSource,
        update,
      });

      return `Set ${args.key} to ${JSON.stringify(value)}`;
    },
  };
}
```

这里有个安全点：

```text
读配置是 read-only。
写配置需要走普通工具权限确认。
```

不要让模型在没有确认的情况下改默认权限或模型。

## 工具注册

把 `config` 工具加到 registry。

```ts
// src/tools/toolRegistry.ts
import { createConfigTool } from "../config/configTool";

export function createDefaultToolRegistry(input: {
  cwd: string;
}) {
  const registry = createToolRegistry();

  registry.register(createFileReadTool(input.cwd));
  registry.register(createFileWriteTool(input.cwd));
  registry.register(createBashTool(input.cwd));
  registry.register(createConfigTool({ cwd: input.cwd }));

  return registry;
}
```

如果你已经有 `verify`、`batch_launch`、`agent` 等工具，也一起注册即可。

## 模型配置消费

现在让模型选择读取 settings。

```ts
// src/model/modelConfig.ts
import type { EffectiveSettings, ModelProvider } from "../config/configTypes";

export type ModelRuntimeConfig = {
  provider: ModelProvider;
  model: string;
  smallFastModel: string;
  apiKeyEnv: string;
  baseUrlEnv: string;
};

export function getModelRuntimeConfig(
  settings: EffectiveSettings,
): ModelRuntimeConfig {
  return {
    provider: settings.model.provider,
    model: settings.model.name,
    smallFastModel: settings.model.smallFast,
    apiKeyEnv: settings.model.apiKeyEnv,
    baseUrlEnv: settings.model.baseUrlEnv,
  };
}

export function getConfiguredApiKey(config: ModelRuntimeConfig): string | undefined {
  return process.env[config.apiKeyEnv];
}

export function getConfiguredBaseUrl(config: ModelRuntimeConfig): string | undefined {
  return process.env[config.baseUrlEnv];
}
```

在 API client 初始化处：

```ts
const settings = await loadEffectiveSettings({
  cwd: process.cwd(),
});

const modelConfig = getModelRuntimeConfig(settings.effective);

const apiKey = getConfiguredApiKey(modelConfig);

if (!apiKey) {
  throw new Error(`Missing API key env: ${modelConfig.apiKeyEnv}`);
}
```

这样用户可以用配置指定“读哪个环境变量”，但密钥仍然只在环境变量里。

## Provider 选择

前面章节已经做过 Anthropic / OpenAI / Gemini 等 provider。

现在 provider 来源改为 settings：

```ts
// src/model/providerConfig.ts
import type { EffectiveSettings, ModelProvider } from "../config/configTypes";

export function getApiProvider(settings: EffectiveSettings): ModelProvider {
  return settings.model.provider;
}
```

如果你想保留环境变量兜底，可以做：

```ts
export function getApiProvider(settings: EffectiveSettings): ModelProvider {
  if (process.env.CLAUDE_CODE_MINI_PROVIDER) {
    return process.env.CLAUDE_CODE_MINI_PROVIDER as ModelProvider;
  }

  return settings.model.provider;
}
```

但注意：

```text
环境变量 override 应该清晰可见。
```

否则用户看 `config get model.provider` 以为是 Anthropic，实际运行却走了别的 provider，会很难排查。

可以在 `config list` 里标出来：

```text
model.provider = "openai"  # overridden by CLAUDE_CODE_MINI_PROVIDER
```

Mini 本章先不做这个展示。

## 权限配置消费

第 25、27 章已经做过权限系统。

现在把规则从 settings 读取。

```ts
// src/permissions/permissionConfig.ts
import type { EffectiveSettings } from "../config/configTypes";
import type { PermissionRule } from "./permissionTypes";

export function getPermissionMode(settings: EffectiveSettings) {
  return settings.permissions.defaultMode;
}

export function getPermissionRules(settings: EffectiveSettings): PermissionRule[] {
  return [
    ...settings.permissions.deny.map(rule => parseRule("deny", rule)),
    ...settings.permissions.ask.map(rule => parseRule("ask", rule)),
    ...settings.permissions.allow.map(rule => parseRule("allow", rule)),
  ];
}

function parseRule(
  behavior: "allow" | "deny" | "ask",
  raw: string,
): PermissionRule {
  const [toolName, ...patternParts] = raw.split(":");

  return {
    behavior,
    toolName,
    pattern: patternParts.join(":") || "*",
  };
}
```

规则顺序建议：

```text
deny > ask > allow
```

这样项目可以明确拒绝危险命令。

例如 `.mini/settings.json`：

```json
{
  "permissions": {
    "deny": ["bash:rm -rf *", "bash:git push *"],
    "ask": ["bash:bun add *"],
    "allow": ["read:*", "grep:*"]
  }
}
```

`bash:bun add *` 默认 ask 是合理的。

它会改变依赖树，应该让用户确认。

## 验证配置消费

第 34 章写了默认验证命令。

现在从 settings 读取：

```ts
// src/verification/recommendedCommands.ts
import type { EffectiveSettings } from "../config/configTypes";

export function getRecommendedCommands(input: {
  settings: EffectiveSettings;
  changedFiles: string[];
}): string[] {
  const commands = [...input.settings.verification.commands];

  if (input.changedFiles.some(file => file.endsWith(".test.ts"))) {
    commands.push("bun test");
  }

  if (input.changedFiles.some(file => file.startsWith("src/cli"))) {
    commands.push("bun run src/cli.ts --help");
  }

  return [...new Set(commands)];
}
```

门禁阈值也从配置读：

```ts
// src/verification/deliveryGate.ts
import type { EffectiveSettings } from "../config/configTypes";

export function requiresVerification(input: {
  settings: EffectiveSettings;
  changedFiles: string[];
  touchedBackend: boolean;
  touchedInfrastructure: boolean;
  touchedPublicApi: boolean;
  usedBatchOrWorktree: boolean;
}): boolean {
  if (!input.settings.verification.enabled) {
    return false;
  }

  if (input.changedFiles.length >= input.settings.verification.requiredChangedFiles) {
    return true;
  }

  if (input.touchedBackend || input.touchedInfrastructure || input.touchedPublicApi) {
    return true;
  }

  if (input.usedBatchOrWorktree) {
    return true;
  }

  return input.settings.verification.alwaysVerify.some(pattern =>
    input.changedFiles.some(file => matchesSimpleGlob(pattern, file)),
  );
}

function matchesSimpleGlob(pattern: string, file: string): boolean {
  if (pattern.endsWith("/**")) {
    return file.startsWith(pattern.slice(0, -3));
  }

  return file === pattern;
}
```

这让项目可以自己决定：

```json
{
  "verification": {
    "requiredChangedFiles": 2,
    "commands": ["bun run typecheck", "bun test"],
    "alwaysVerify": ["packages/**", "src/permissions/**"]
  }
}
```

## Worktree 配置消费

第 32 章做了 worktree。

真实工程里 worktree settings 支持 `symlinkDirectories` 和 `sparsePaths`。

Mini 也接上。

```ts
// src/worktrees/worktreeConfig.ts
import type { EffectiveSettings } from "../config/configTypes";

export function getWorktreeConfig(settings: EffectiveSettings) {
  return settings.worktree;
}
```

在创建 worktree 后：

```ts
const config = getWorktreeConfig(settings.effective);

for (const dir of config.symlinkDirectories) {
  await symlinkDirectoryFromMainRepo({
    repoRoot,
    worktreePath,
    directory: dir,
  });
}

if (config.sparsePaths.length > 0) {
  await configureSparseCheckout({
    worktreePath,
    paths: config.sparsePaths,
  });
}
```

这能解决大仓库里两个常见问题：

- worktree 复制太慢。
- 每个 worktree 都产生巨大依赖目录。

但默认不要自动 symlink `node_modules`。

这类策略应该由项目明确配置。

## Sandbox 配置消费

第 14 章做过 shell sandbox。

现在让它读取 settings：

```ts
// src/sandbox/sandboxPolicy.ts
import type { EffectiveSettings } from "../config/configTypes";

export type SandboxPolicy = {
  enabled: boolean;
  allowNetwork: boolean;
  allowWrite: boolean;
};

export function getSandboxPolicy(settings: EffectiveSettings): SandboxPolicy {
  return {
    enabled: settings.sandbox.enabled,
    allowNetwork: settings.sandbox.network === "allow",
    allowWrite: settings.sandbox.write === "workspace",
  };
}
```

在 `BashTool` 里：

```ts
const policy = getSandboxPolicy(settings.effective);

if (policy.enabled) {
  return runInSandbox({
    command,
    cwd,
    allowNetwork: policy.allowNetwork,
    allowWrite: policy.allowWrite,
  });
}

return runDirectly({
  command,
  cwd,
});
```

配置只决定默认策略。

权限系统仍然要继续工作。

也就是说：

```text
sandbox 不是权限系统的替代品。
sandbox 是命令真正执行时的隔离层。
```

## Session Override

有些配置只应该在当前会话生效。

例如用户输入：

```bash
bun run src/cli.ts --model opus
```

不一定要写入 settings 文件。

可以把它变成 session source：

```ts
// src/session/sessionConfig.ts
import type { MiniSettings } from "../config/configTypes";

export function buildSessionSettingsFromArgs(argv: string[]): MiniSettings {
  const modelIndex = argv.indexOf("--model");

  if (modelIndex === -1) {
    return {};
  }

  const modelName = argv[modelIndex + 1];

  if (!modelName) {
    return {};
  }

  return {
    model: {
      name: modelName,
    },
  };
}
```

启动时：

```ts
const session = buildSessionSettingsFromArgs(process.argv);

const settings = await loadEffectiveSettings({
  cwd: process.cwd(),
  session,
});
```

这样优先级就很清楚：

```text
命令行本次指定的模型最高。
但不会污染项目配置。
```

## 初始化项目配置

给用户一个初始化命令：

```bash
bun run src/cli.ts config init
```

写入 `.mini/settings.json`：

```ts
// src/config/configInit.ts
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function initProjectSettings(cwd: string): Promise<string> {
  const filePath = join(cwd, ".mini", "settings.json");

  const content = {
    verification: {
      enabled: true,
      requiredChangedFiles: 3,
      commands: ["bun run typecheck"],
      alwaysVerify: ["src/api/**", "src/tools/**"],
    },
    permissions: {
      defaultMode: "ask",
      deny: ["bash:rm -rf *", "bash:git push *"],
    },
    worktree: {
      enabled: true,
      symlinkDirectories: [],
      sparsePaths: [],
    },
  };

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, "utf8");

  return filePath;
}
```

接到命令：

```ts
if (process.argv[2] === "config" && process.argv[3] === "init") {
  const filePath = await initProjectSettings(process.cwd());
  console.log(`Created ${filePath}`);
  process.exit(0);
}
```

## 配置展示

`config list` 不要只展示 effective value。

最好也展示来源。

Mini 可以先做一个简单版：

```ts
// src/config/configInspect.ts
import type { SettingsSnapshot } from "./configLoader";
import { CONFIG_REGISTRY } from "./configRegistry";
import { getValueByPath } from "./configPathValue";

export function renderSettingsSnapshot(snapshot: SettingsSnapshot): string {
  const lines = ["Effective settings:", ""];

  for (const item of CONFIG_REGISTRY) {
    const value = getValueByPath({
      object: snapshot.effective,
      path: item.key,
    });

    lines.push(`${item.key}: ${JSON.stringify(value)}`);
  }

  lines.push("", "Sources:");

  if (snapshot.sources.length === 0) {
    lines.push("- defaults only");
  } else {
    for (const source of snapshot.sources) {
      lines.push(`- ${source.source}: ${source.filePath ?? "(session)"}`);
    }
  }

  if (snapshot.errors.length > 0) {
    lines.push("", "Errors:");
    for (const error of snapshot.errors) {
      lines.push(`- ${error.source}: ${error.message}`);
    }
  }

  return lines.join("\n");
}
```

后续可以做更细的“每个 key 来自哪里”。

但第一版只要能看出参与合并的来源，就已经很有用。

## 测试合并

先测最核心的 merge。

```ts
// src/config/__tests__/configMerge.test.ts
import { describe, expect, test } from "bun:test";
import { mergeSettings } from "../configMerge";

describe("mergeSettings", () => {
  test("merges scalar values by source order", () => {
    const settings = mergeSettings([
      { model: { name: "sonnet" } },
      { model: { name: "opus" } },
    ]);

    expect(settings.model.name).toBe("opus");
  });

  test("merges arrays with dedupe", () => {
    const settings = mergeSettings([
      { verification: { commands: ["bun run typecheck"] } },
      { verification: { commands: ["bun run typecheck", "bun test"] } },
    ]);

    expect(settings.verification.commands).toEqual([
      "bun run typecheck",
      "bun test",
    ]);
  });

  test("keeps defaults", () => {
    const settings = mergeSettings([]);

    expect(settings.permissions.defaultMode).toBe("ask");
    expect(settings.verification.enabled).toBe(true);
  });
});
```

运行：

```bash
bun test src/config/__tests__/configMerge.test.ts
```

## 测试 schema

```ts
// src/config/__tests__/configSchema.test.ts
import { describe, expect, test } from "bun:test";
import { miniSettingsSchema } from "../configSchema";

describe("miniSettingsSchema", () => {
  test("accepts valid settings", () => {
    const result = miniSettingsSchema.safeParse({
      model: {
        provider: "anthropic",
        name: "sonnet",
      },
      verification: {
        enabled: true,
        commands: ["bun run typecheck"],
      },
    });

    expect(result.success).toBe(true);
  });

  test("rejects unknown top-level key", () => {
    const result = miniSettingsSchema.safeParse({
      verfication: {
        enabled: true,
      },
    });

    expect(result.success).toBe(false);
  });

  test("rejects invalid permission mode", () => {
    const result = miniSettingsSchema.safeParse({
      permissions: {
        defaultMode: "always",
      },
    });

    expect(result.success).toBe(false);
  });
});
```

运行：

```bash
bun test src/config/__tests__/configSchema.test.ts
```

## 测试写入

```ts
// src/config/__tests__/configWriter.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { updateSettingsForSource } from "../configWriter";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("updateSettingsForSource", () => {
  test("writes project settings", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mini-config-"));

    await updateSettingsForSource({
      cwd: tempDir,
      source: "project",
      update: {
        verification: {
          enabled: true,
          commands: ["bun run typecheck"],
        },
      },
    });

    const raw = await readFile(join(tempDir, ".mini", "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      verification: {
        commands: string[];
      };
    };

    expect(parsed.verification.commands).toEqual(["bun run typecheck"]);
  });
});
```

运行：

```bash
bun test src/config/__tests__/configWriter.test.ts
```

## 手工验证

完成本章后，可以这样跑：

```bash
bun run src/cli.ts config init
bun run src/cli.ts config list
bun run src/cli.ts config set model.name sonnet --source user
bun run src/cli.ts config set permissions.defaultMode ask --source project
bun run src/cli.ts config set verification.commands '["bun run typecheck","bun test"]' --source project
bun run src/cli.ts config get verification.commands
```

再看生成的文件：

```bash
cat .mini/settings.json
```

预期能看到：

```json
{
  "verification": {
    "enabled": true,
    "requiredChangedFiles": 3,
    "commands": ["bun run typecheck", "bun test"],
    "alwaysVerify": ["src/api/**", "src/tools/**"]
  },
  "permissions": {
    "defaultMode": "ask",
    "deny": ["bash:rm -rf *", "bash:git push *"]
  },
  "worktree": {
    "enabled": true,
    "symlinkDirectories": [],
    "sparsePaths": []
  }
}
```

## 常见坑

### 1. 把配置读取散落到各模块

不要让每个模块自己读文件。

应该统一：

```text
loadEffectiveSettings -> 传给各模块
```

否则同一轮对话里，不同模块可能读到不同配置。

### 2. 写入时吞掉坏配置

如果原配置 JSON 坏了，写入函数不要覆盖它。

应该报错，让用户修文件。

覆盖坏文件看起来省事，但会丢用户配置。

### 3. 在配置里保存密钥

不要设计 `apiKey` 字段。

只设计 `apiKeyEnv`。

密钥从环境变量读取。

### 4. 允许模型写任意 key

`Config` 工具必须走 registry。

否则模型可能写出一个 schema 不支持的字段，或者改到不该改的策略。

### 5. 把 local settings 提交到仓库

`.mini/settings.local.json` 应该默认加入 `.gitignore`。

这里面通常会有个人路径、本机端口、本地偏好。

### 6. 数组合并和写入混在一起

读取时数组可以合并。

写入时数组应该替换。

否则用户无法把旧命令删掉。

### 7. 让项目配置默认放宽权限

项目配置是仓库内容。

不要让别人 clone 仓库后自动进入危险权限。

如果项目配置里写了 `permissions.defaultMode: "dontAsk"`，Mini 应该考虑启动时提醒用户确认。

本章先不做 trust dialog，但要记住这个风险。

## 本章小结

本章把 Mini 的可调行为收敛到了一个项目级配置系统：

- settings schema。
- user / project / local 三类配置来源。
- 多来源合并。
- schema 校验和错误展示。
- 写入指定 source。
- 本地配置 gitignore。
- `config list/get/set/init` 命令。
- 模型、权限、验证、worktree、sandbox 消费配置。
- Config 工具给模型读写配置。

到这里，Mini 已经从“代码里写死行为”变成“项目可以声明自己的 Agent 规则”。

下一章可以继续做 **Hooks 与事件系统**：让用户在工具调用前后、任务完成、验证失败、会话开始和会话结束时挂接脚本，把 Mini 接入真实团队工作流。
