# 第 37 章：插件系统与能力分发

第三十六章把 Mini 接入了 hooks。

现在用户已经可以在 `.mini/settings.json` 里挂接自动化脚本：

- 工具执行前检查。
- 工具执行后记录。
- 验证失败时通知。
- 会话开始和结束时注入流程。

但如果一个团队要共享这些能力，只靠复制配置文件很快会失控。

例如团队希望提供一套“代码评审能力包”：

- `/review` 命令。
- `reviewer` 子 Agent。
- `review-quality` skill。
- `PostToolUse` hook 自动记录被改文件。
- 默认验证命令和提示词模板。

这些东西不应该散落在用户项目里。

它们应该被打包、安装、启用、禁用，并由 Mini 在启动时统一加载。

这就是插件系统。

本章给 Mini 增加一套最小可用的本地插件系统：

```text
插件目录 -> manifest 校验 -> 安装记录 -> 项目启用状态 -> 能力加载 -> 注册到 commands/hooks/agents/skills
```

第一版只做本地路径插件。

也就是：

```bash
bun run src/cli.ts plugin validate ./plugins/review-pack
bun run src/cli.ts plugin install ./plugins/review-pack --scope project
bun run src/cli.ts plugin list
bun run src/cli.ts plugin disable review-pack --scope project
bun run src/cli.ts plugin enable review-pack --scope project
```

远程插件市场、版本升级、签名校验可以放到下一章。

这一章先把最重要的边界做好：

- 插件本身是一个目录。
- 插件必须声明 manifest。
- 安装和启用是两件事。
- 插件能力必须命名空间化，避免污染主系统。
- 插件不能绕过权限、hooks 信任和配置校验。

## 真实工程怎么做

真实工程的插件系统主要分布在这些文件里：

- `src/utils/plugins/schemas.ts`：定义插件 manifest、命令、agents、skills、hooks、用户配置等 schema。
- `src/utils/plugins/pluginDirectories.ts`：集中管理插件目录、数据目录和环境变量覆盖。
- `src/utils/plugins/pluginLoader.ts`：加载已安装插件、会话级插件、内置插件，并把 manifest 能力解析成运行时对象。
- `src/utils/plugins/installedPluginsManager.ts`：维护全局安装记录。
- `src/types/plugin.ts`：定义 `LoadedPlugin`、插件组件、插件错误类型等。
- `src/utils/plugins/loadPluginCommands.ts`：把插件里的 markdown 命令加载成 slash command。
- `src/utils/plugins/loadPluginAgents.ts`：把插件里的 agent markdown 加载成命名空间化的 agent。
- `src/utils/plugins/loadPluginHooks.ts`：把插件 hooks 转成带插件上下文的 hook matcher。
- `src/utils/plugins/validatePlugin.ts`：校验 manifest、路径、组件文件和安全边界。
- `src/services/plugins/pluginCliCommands.ts`：提供 `install`、`uninstall`、`enable`、`disable`、`update` 等 CLI 包装。
- `src/cli/handlers/plugins.ts`：把 CLI 参数解析和具体插件操作接起来。
- `src/plugins/builtinPlugins.ts`：管理随 CLI 内置、但仍然可启用或禁用的插件。

真实工程里的插件 manifest 放在：

```text
plugin-root/
  .claude-plugin/
    plugin.json
```

常见能力目录是：

```text
plugin-root/
  commands/
  agents/
  skills/
  hooks/
    hooks.json
```

真实工程有几个关键设计：

```text
1. manifest 是插件入口，目录扫描只是补充能力发现。
2. 插件安装状态是全局记录，启用状态来自 user/project/local settings。
3. 会话级插件可以通过启动参数加载，但不持久化。
4. 插件命令必须带命名空间，例如 pluginName:commandName。
5. 插件 agent 也必须带命名空间，例如 pluginName:reviewer。
6. 插件 hooks 会带 pluginRoot、pluginName、pluginId 上下文。
7. manifest 里的相对路径必须是安全路径，不能使用路径穿越。
8. 用户敏感配置不能写进插件内容，应该由用户配置提供。
9. 启动路径尽量使用缓存，不能每次启动都做慢操作。
10. 内置插件和外部插件走同一套 LoadedPlugin 表达。
```

Mini 本章复刻这条主线，但先删掉复杂能力：

- 不做远程插件源。
- 不做插件市场。
- 不做自动更新。
- 不做内置插件 UI。
- 不做插件签名。
- 不做多渠道发布。

第一版只支持：

```text
本地目录插件 + manifest + 安装记录 + settings 启用状态 + 能力加载
```

这样已经足够把前面章节做出的 commands、hooks、agents、skills 串起来。

## 本章目标

完成后，Mini 支持一个插件目录：

```text
review-pack/
  .mini-plugin/
    plugin.json
  commands/
    review.md
  agents/
    reviewer.md
  skills/
    review-quality/
      SKILL.md
  hooks/
    hooks.json
```

其中 `.mini-plugin/plugin.json` 内容类似：

```json
{
  "name": "review-pack",
  "version": "0.1.0",
  "description": "Local review commands, agents, skills, and hooks",
  "commands": "./commands",
  "agents": "./agents",
  "skills": "./skills",
  "hooks": "./hooks/hooks.json"
}
```

安装后，项目 `.mini/settings.json` 里可以写：

```json
{
  "plugins": {
    "enabled": {
      "review-pack": true
    }
  }
}
```

启动时，Mini 加载插件能力：

```text
review-pack:review       -> slash command
review-pack:reviewer     -> agent type
review-quality           -> skill
PostToolUse hook         -> hooks registry
```

本章要实现：

- 插件 manifest 类型。
- manifest schema。
- 插件目录与安装记录路径。
- 本地插件校验。
- 本地插件安装。
- 项目启用和禁用。
- 已启用插件加载。
- 插件命令加载。
- 插件 Agent 加载。
- 插件 Skill 加载。
- 插件 Hooks 加载。
- 插件能力统一注册。
- `plugin validate/install/list/enable/disable/uninstall` CLI。
- 插件测试。

## 推荐目录

新增：

```text
src/plugins/
  pluginTypes.ts
  pluginSchema.ts
  pluginPaths.ts
  pluginManifest.ts
  pluginInstallStore.ts
  pluginInstaller.ts
  pluginLoader.ts
  pluginCommands.ts
  pluginAgents.ts
  pluginSkills.ts
  pluginHooks.ts
  pluginRegistry.ts
  pluginCommand.ts

src/plugins/__tests__/
  pluginSchema.test.ts
  pluginManifest.test.ts
  pluginInstaller.test.ts
  pluginLoader.test.ts
  pluginRegistry.test.ts
```

修改：

```text
src/config/configTypes.ts
src/config/configDefaults.ts
src/config/configSchema.ts
src/config/configMerge.ts
src/commands/commandRegistry.ts
src/agents/agentRegistry.ts
src/skills/skillRegistry.ts
src/hooks/hookRegistry.ts
src/cli.ts
```

如果你的 Mini 项目里这些文件名略有不同，按同样边界映射即可。

核心原则是：

```text
插件系统负责加载能力。
已有 registry 负责使用能力。
不要让插件 loader 直接调用模型、执行工具或改写权限决策。
```

## 插件目录约定

Mini 使用自己的 manifest 目录：

```text
.mini-plugin/plugin.json
```

这和真实工程的 `.claude-plugin/plugin.json` 对齐，但不会误读真实工具的插件。

一个插件目录可以长这样：

```text
review-pack/
  .mini-plugin/
    plugin.json

  commands/
    review.md
    fix-tests.md

  agents/
    reviewer.md
    test-runner.md

  skills/
    review-quality/
      SKILL.md
    test-debugging/
      SKILL.md

  hooks/
    hooks.json
```

manifest 负责声明入口：

```json
{
  "name": "review-pack",
  "version": "0.1.0",
  "description": "Review workflow for Mini",
  "commands": "./commands",
  "agents": "./agents",
  "skills": "./skills",
  "hooks": "./hooks/hooks.json"
}
```

Mini 第一版支持四类路径：

```text
commands: string
agents: string
skills: string
hooks: string
```

全部要求：

```text
1. 必须以 ./ 开头。
2. 不能包含 ..
3. 不能是绝对路径。
4. 解析后必须仍然位于插件根目录内。
```

这是插件系统最基础的安全边界。

插件作者不应该能通过 manifest 读取：

```text
../../.ssh/id_rsa
/etc/passwd
```

也不应该能通过符号路径绕出插件根目录。

第一版可以先做字符串级路径穿越拦截，后续再加入 `realpath` 校验。

## 插件类型

新增 `src/plugins/pluginTypes.ts`：

```ts
export type PluginScope = "user" | "project" | "local";

export type PluginComponentKind = "commands" | "agents" | "skills" | "hooks";

export type PluginManifest = {
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  commands?: string;
  agents?: string;
  skills?: string;
  hooks?: string;
};

export type InstalledPluginEntry = {
  name: string;
  version: string;
  installPath: string;
  sourcePath: string;
  installedAt: string;
};

export type InstalledPluginStore = {
  version: 1;
  plugins: Record<string, InstalledPluginEntry>;
};

export type LoadedPlugin = {
  name: string;
  id: string;
  version: string;
  description?: string;
  rootPath: string;
  manifestPath: string;
  manifest: PluginManifest;
  enabled: boolean;
  components: {
    commandsPath?: string;
    agentsPath?: string;
    skillsPath?: string;
    hooksPath?: string;
  };
};

export type PluginLoadError = {
  pluginName?: string;
  path?: string;
  message: string;
};

export type PluginLoadResult = {
  plugins: LoadedPlugin[];
  errors: PluginLoadError[];
};
```

这里特意保留 `id` 和 `name` 两个字段。

第一版可以让它们相同：

```text
id = name
```

但一旦后续支持多个来源，同名插件就需要区分：

```text
review-pack@team
review-pack@local
```

所以 runtime 结构里现在就保留 `id`。

## Manifest Schema

新增 `src/plugins/pluginSchema.ts`：

```ts
import { z } from "zod";

const pluginNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "Plugin name must use lowercase letters, digits, dash, or underscore");

const relativePluginPathSchema = z
  .string()
  .min(2)
  .refine(value => value.startsWith("./"), "Plugin component path must start with ./")
  .refine(value => !value.includes(".."), "Plugin component path cannot contain ..")
  .refine(value => !value.startsWith("/"), "Plugin component path cannot be absolute");

export const pluginManifestSchema = z.object({
  name: pluginNameSchema,
  version: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  author: z.string().max(160).optional(),
  homepage: z.string().url().optional(),
  repository: z.string().url().optional(),
  commands: relativePluginPathSchema.optional(),
  agents: relativePluginPathSchema.optional(),
  skills: relativePluginPathSchema.optional(),
  hooks: relativePluginPathSchema.optional(),
});

export type ParsedPluginManifest = z.infer<typeof pluginManifestSchema>;
```

这里没有使用宽松 schema。

原因是 Mini 的第一版插件系统应该宁愿拒绝坏 manifest，也不要把错别字吞掉。

例如插件作者写错：

```json
{
  "name": "review-pack",
  "version": "0.1.0",
  "commmands": "./commands"
}
```

如果 schema 静默忽略未知字段，插件作者会以为命令已经加载。

Mini 第一版可以先让校验严格一点：

```ts
export const strictPluginManifestSchema = pluginManifestSchema.strict();
```

最终代码可以使用：

```ts
export function parsePluginManifest(value: unknown): ParsedPluginManifest {
  return strictPluginManifestSchema.parse(value);
}
```

## 插件路径

新增 `src/plugins/pluginPaths.ts`：

```ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const MINI_PLUGIN_MANIFEST_DIR = ".mini-plugin";
export const MINI_PLUGIN_MANIFEST_FILE = "plugin.json";

export function getMiniHome(): string {
  return process.env.MINI_HOME ?? join(homedir(), ".claude-code-mini");
}

export function getPluginHome(): string {
  return join(getMiniHome(), "plugins");
}

export function getInstalledPluginsFile(): string {
  return join(getPluginHome(), "installed_plugins.json");
}

export function getPluginCacheDir(): string {
  return join(getPluginHome(), "cache");
}

export function getCachedPluginDir(pluginName: string): string {
  return join(getPluginCacheDir(), pluginName);
}

export function getPluginManifestPath(pluginRoot: string): string {
  return join(pluginRoot, MINI_PLUGIN_MANIFEST_DIR, MINI_PLUGIN_MANIFEST_FILE);
}

export function resolvePluginComponentPath(pluginRoot: string, relativePath: string): string {
  const resolved = resolve(pluginRoot, relativePath);
  const root = resolve(pluginRoot);

  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`Plugin component path escapes plugin root: ${relativePath}`);
  }

  return resolved;
}
```

这里要注意两件事。

第一，`MINI_HOME` 是测试友好的覆盖变量。

测试可以写：

```ts
process.env.MINI_HOME = tempDir;
```

第二，`resolvePluginComponentPath` 不能只拼字符串。

必须把路径解析到绝对路径后确认仍然在插件根目录内。

这一层校验和 schema 里的 `..` 校验是互补关系：

```text
schema 校验：拒绝明显坏的输入。
resolve 校验：确认解析结果没有逃出根目录。
```

## Manifest 读取

新增 `src/plugins/pluginManifest.ts`：

```ts
import { readFile } from "node:fs/promises";
import { getPluginManifestPath } from "./pluginPaths";
import { parsePluginManifest } from "./pluginSchema";
import type { PluginManifest } from "./pluginTypes";

export async function readPluginManifest(pluginRoot: string): Promise<PluginManifest> {
  const manifestPath = getPluginManifestPath(pluginRoot);
  const raw = await readFile(manifestPath, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid plugin manifest JSON at ${manifestPath}: ${message}`);
  }

  try {
    return parsePluginManifest(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid plugin manifest at ${manifestPath}: ${message}`);
  }
}
```

再加一个验证入口：

```ts
import { stat } from "node:fs/promises";
import { resolvePluginComponentPath } from "./pluginPaths";
import type { PluginComponentKind, PluginManifest } from "./pluginTypes";

type ComponentPath = {
  kind: PluginComponentKind;
  path: string;
};

export function getDeclaredComponentPaths(manifest: PluginManifest): ComponentPath[] {
  const paths: ComponentPath[] = [];

  if (manifest.commands) paths.push({ kind: "commands", path: manifest.commands });
  if (manifest.agents) paths.push({ kind: "agents", path: manifest.agents });
  if (manifest.skills) paths.push({ kind: "skills", path: manifest.skills });
  if (manifest.hooks) paths.push({ kind: "hooks", path: manifest.hooks });

  return paths;
}

export async function validatePluginOnDisk(pluginRoot: string): Promise<PluginManifest> {
  const manifest = await readPluginManifest(pluginRoot);
  const components = getDeclaredComponentPaths(manifest);

  for (const component of components) {
    const absolutePath = resolvePluginComponentPath(pluginRoot, component.path);
    try {
      await stat(absolutePath);
    } catch {
      throw new Error(`Plugin ${manifest.name} declares missing ${component.kind} path: ${component.path}`);
    }
  }

  return manifest;
}
```

这一步只确认：

```text
manifest 存在。
manifest JSON 合法。
manifest schema 合法。
声明的路径存在。
声明的路径没有逃出插件根目录。
```

更细的能力校验放到各 loader 里。

例如命令 loader 校验 `.md` frontmatter，hooks loader 校验 hooks JSON。

## 安装记录

真实工程把“安装状态”和“启用状态”分开。

Mini 也应该这么做。

全局安装记录放在：

```text
~/.claude-code-mini/plugins/installed_plugins.json
```

内容：

```json
{
  "version": 1,
  "plugins": {
    "review-pack": {
      "name": "review-pack",
      "version": "0.1.0",
      "installPath": "/Users/me/.claude-code-mini/plugins/cache/review-pack",
      "sourcePath": "/Users/me/project/plugins/review-pack",
      "installedAt": "2026-05-26T10:00:00.000Z"
    }
  }
}
```

项目启用状态仍然在 settings：

```json
{
  "plugins": {
    "enabled": {
      "review-pack": true
    }
  }
}
```

为什么要分开？

因为安装是机器行为：

```text
这个插件目录已经拷贝到本机缓存。
```

启用是配置行为：

```text
这个项目是否使用这个插件。
```

同一个插件可以安装一次，然后在多个项目里启用或禁用。

新增 `src/plugins/pluginInstallStore.ts`：

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getInstalledPluginsFile } from "./pluginPaths";
import type { InstalledPluginEntry, InstalledPluginStore } from "./pluginTypes";

const DEFAULT_STORE: InstalledPluginStore = {
  version: 1,
  plugins: {},
};

export async function readInstalledPluginStore(): Promise<InstalledPluginStore> {
  const file = getInstalledPluginsFile();

  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as InstalledPluginStore;

    if (parsed.version !== 1 || typeof parsed.plugins !== "object" || parsed.plugins === null) {
      throw new Error("Unsupported installed plugin store format");
    }

    return parsed;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return DEFAULT_STORE;
    }

    throw error;
  }
}

export async function writeInstalledPluginStore(store: InstalledPluginStore): Promise<void> {
  const file = getInstalledPluginsFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export async function upsertInstalledPlugin(entry: InstalledPluginEntry): Promise<void> {
  const store = await readInstalledPluginStore();
  store.plugins[entry.name] = entry;
  await writeInstalledPluginStore(store);
}

export async function removeInstalledPlugin(pluginName: string): Promise<boolean> {
  const store = await readInstalledPluginStore();

  if (!store.plugins[pluginName]) {
    return false;
  }

  delete store.plugins[pluginName];
  await writeInstalledPluginStore(store);
  return true;
}
```

这里有一个 TypeScript 细节。

`error.code` 不是 `Error` 的标准字段。

如果项目已有 `isNodeError` 之类的工具函数，优先复用。

否则可以补一个小 helper：

```ts
type NodeError = Error & {
  code?: string;
};

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && (error as NodeError).code === "ENOENT";
}
```

然后把上面的判断替换成：

```ts
if (isMissingFileError(error)) {
  return DEFAULT_STORE;
}
```

这样不需要使用不安全类型。

## 配置接入

第三十五章已经有 settings schema。

本章给 settings 增加 `plugins`：

```ts
export type PluginSettings = {
  enabled?: Record<string, boolean>;
};
```

在 `src/config/configTypes.ts`：

```ts
export type MiniSettings = {
  model?: ModelSettings;
  permissions?: PermissionSettings;
  verification?: VerificationSettings;
  hooks?: HooksSettings;
  plugins?: PluginSettings;
};
```

在 `src/config/configDefaults.ts`：

```ts
export const DEFAULT_PLUGIN_SETTINGS: PluginSettings = {
  enabled: {},
};
```

在默认 settings：

```ts
export const DEFAULT_SETTINGS: MiniSettings = {
  model: DEFAULT_MODEL_SETTINGS,
  permissions: DEFAULT_PERMISSION_SETTINGS,
  verification: DEFAULT_VERIFICATION_SETTINGS,
  hooks: DEFAULT_HOOKS_SETTINGS,
  plugins: DEFAULT_PLUGIN_SETTINGS,
};
```

在 `src/config/configSchema.ts`：

```ts
const pluginSettingsSchema = z.object({
  enabled: z.record(z.string(), z.boolean()).optional(),
});

export const miniSettingsSchema = z.object({
  model: modelSettingsSchema.optional(),
  permissions: permissionSettingsSchema.optional(),
  verification: verificationSettingsSchema.optional(),
  hooks: hooksSettingsSchema.optional(),
  plugins: pluginSettingsSchema.optional(),
});
```

配置合并时，`plugins.enabled` 不能简单替换整个对象。

例如 user settings：

```json
{
  "plugins": {
    "enabled": {
      "review-pack": true
    }
  }
}
```

project settings：

```json
{
  "plugins": {
    "enabled": {
      "deploy-pack": false
    }
  }
}
```

合并后应该是：

```json
{
  "plugins": {
    "enabled": {
      "review-pack": true,
      "deploy-pack": false
    }
  }
}
```

所以 `configMerge.ts` 里要给对象字段做深合并。

最小实现：

```ts
function mergePluginSettings(base: PluginSettings | undefined, override: PluginSettings | undefined): PluginSettings | undefined {
  if (!base && !override) return undefined;

  return {
    enabled: {
      ...(base?.enabled ?? {}),
      ...(override?.enabled ?? {}),
    },
  };
}
```

然后在总合并函数里：

```ts
export function mergeSettings(base: MiniSettings, override: MiniSettings): MiniSettings {
  return {
    ...base,
    ...override,
    model: mergeObject(base.model, override.model),
    permissions: mergePermissionSettings(base.permissions, override.permissions),
    verification: mergeObject(base.verification, override.verification),
    hooks: mergeHooksSettings(base.hooks, override.hooks),
    plugins: mergePluginSettings(base.plugins, override.plugins),
  };
}
```

## 安装本地插件

新增 `src/plugins/pluginInstaller.ts`：

```ts
import { mkdir, readdir, rm, stat, copyFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { upsertInstalledPlugin, removeInstalledPlugin } from "./pluginInstallStore";
import { getCachedPluginDir } from "./pluginPaths";
import { validatePluginOnDisk } from "./pluginManifest";
import type { InstalledPluginEntry } from "./pluginTypes";

async function copyDirectory(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });

  const entries = await readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile()) {
      await copyFile(sourcePath, targetPath);
    }
  }
}

export async function installLocalPlugin(sourcePath: string): Promise<InstalledPluginEntry> {
  const resolvedSource = resolve(sourcePath);
  const sourceStat = await stat(resolvedSource);

  if (!sourceStat.isDirectory()) {
    throw new Error(`Plugin source must be a directory: ${sourcePath}`);
  }

  const manifest = await validatePluginOnDisk(resolvedSource);
  const cachePath = getCachedPluginDir(manifest.name);

  await rm(cachePath, { recursive: true, force: true });
  await copyDirectory(resolvedSource, cachePath);

  const entry: InstalledPluginEntry = {
    name: manifest.name,
    version: manifest.version,
    installPath: cachePath,
    sourcePath: resolvedSource,
    installedAt: new Date().toISOString(),
  };

  await upsertInstalledPlugin(entry);
  return entry;
}

export async function uninstallLocalPlugin(pluginName: string): Promise<boolean> {
  const cachePath = getCachedPluginDir(pluginName);
  const removed = await removeInstalledPlugin(pluginName);

  if (removed) {
    await rm(cachePath, { recursive: true, force: true });
  }

  return removed;
}

export function inferPluginNameFromPath(sourcePath: string): string {
  return basename(resolve(sourcePath));
}
```

这里要注意一个产品语义。

`install` 只表示插件已经被 Mini 知道。

它不应该自动在所有项目启用。

但为了 CLI 体验，`install --scope project` 可以做两件事：

```text
1. 安装插件到本机缓存。
2. 在当前项目 settings 里启用它。
```

这个行为要在 CLI 层完成，而不是 installer 层完成。

原因是 installer 不应该知道项目配置路径。

## 启用和禁用

启用和禁用本质是写 settings。

假设第三十五章已经有 `updateSettings(source, updater)`。

可以新增一个 helper：

```ts
import type { EditableConfigSource } from "../config/configTypes";
import { updateSettings } from "../config/configWriter";

export async function setPluginEnabled(
  pluginName: string,
  enabled: boolean,
  source: EditableConfigSource,
): Promise<void> {
  await updateSettings(source, current => {
    return {
      ...current,
      plugins: {
        ...(current.plugins ?? {}),
        enabled: {
          ...(current.plugins?.enabled ?? {}),
          [pluginName]: enabled,
        },
      },
    };
  });
}
```

这里不删除 key，而是写布尔值。

这样可以表达三种状态：

```text
未配置：走默认行为。
true：明确启用。
false：明确禁用。
```

Mini 第一版可以让默认行为是禁用。

也就是只有明确 `true` 才加载。

后续如果做内置插件，可以让某些插件默认启用，再通过 `false` 覆盖。

## 加载已启用插件

新增 `src/plugins/pluginLoader.ts`：

```ts
import { getPluginManifestPath, resolvePluginComponentPath } from "./pluginPaths";
import { readPluginManifest } from "./pluginManifest";
import { readInstalledPluginStore } from "./pluginInstallStore";
import type { LoadedPlugin, PluginLoadError, PluginLoadResult } from "./pluginTypes";
import type { MiniSettings } from "../config/configTypes";

function isPluginEnabled(pluginName: string, settings: MiniSettings): boolean {
  return settings.plugins?.enabled?.[pluginName] === true;
}

async function createLoadedPlugin(pluginName: string, rootPath: string, enabled: boolean): Promise<LoadedPlugin> {
  const manifest = await readPluginManifest(rootPath);

  if (manifest.name !== pluginName) {
    throw new Error(`Installed plugin key ${pluginName} does not match manifest name ${manifest.name}`);
  }

  return {
    name: manifest.name,
    id: manifest.name,
    version: manifest.version,
    description: manifest.description,
    rootPath,
    manifestPath: getPluginManifestPath(rootPath),
    manifest,
    enabled,
    components: {
      commandsPath: manifest.commands ? resolvePluginComponentPath(rootPath, manifest.commands) : undefined,
      agentsPath: manifest.agents ? resolvePluginComponentPath(rootPath, manifest.agents) : undefined,
      skillsPath: manifest.skills ? resolvePluginComponentPath(rootPath, manifest.skills) : undefined,
      hooksPath: manifest.hooks ? resolvePluginComponentPath(rootPath, manifest.hooks) : undefined,
    },
  };
}

export async function loadInstalledPlugins(settings: MiniSettings): Promise<PluginLoadResult> {
  const store = await readInstalledPluginStore();
  const plugins: LoadedPlugin[] = [];
  const errors: PluginLoadError[] = [];

  for (const [pluginName, entry] of Object.entries(store.plugins)) {
    const enabled = isPluginEnabled(pluginName, settings);

    if (!enabled) {
      continue;
    }

    try {
      plugins.push(await createLoadedPlugin(pluginName, entry.installPath, enabled));
    } catch (error) {
      errors.push({
        pluginName,
        path: entry.installPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { plugins, errors };
}
```

这一版只返回启用插件。

如果 `plugin list` 需要展示禁用插件，可以额外做一个函数：

```ts
export async function loadAllInstalledPluginSummaries(settings: MiniSettings): Promise<LoadedPlugin[]> {
  const store = await readInstalledPluginStore();
  const plugins: LoadedPlugin[] = [];

  for (const [pluginName, entry] of Object.entries(store.plugins)) {
    const enabled = isPluginEnabled(pluginName, settings);
    plugins.push(await createLoadedPlugin(pluginName, entry.installPath, enabled));
  }

  return plugins;
}
```

注意不要让一个坏插件阻断整个 CLI 启动。

运行时加载应该收集错误：

```text
review-pack 加载失败 -> 展示 warning -> 其他插件继续加载
```

只有显式执行 `plugin validate` 时，才应该把错误作为命令失败返回。

## 插件命令

插件命令使用 markdown 文件。

例如 `commands/review.md`：

```markdown
---
description: Review current changes
argumentHint: "[scope]"
allowedTools:
  - read
  - grep
  - bash
---

Review the current working tree.

Focus on:

- correctness
- hidden regressions
- missing tests
- unclear error handling

User scope: $ARGUMENTS
```

加载后命令名必须带插件命名空间：

```text
review-pack:review
```

不要注册成：

```text
review
```

否则两个插件都提供 `review.md` 时就会冲突。

新增 `src/plugins/pluginCommands.ts`：

```ts
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { LoadedPlugin } from "./pluginTypes";
import type { CommandDefinition } from "../commands/commandTypes";

type MarkdownWithFrontmatter = {
  data: Record<string, unknown>;
  body: string;
};

function parseMarkdownWithFrontmatter(raw: string): MarkdownWithFrontmatter {
  if (!raw.startsWith("---\n")) {
    return { data: {}, body: raw };
  }

  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) {
    return { data: {}, body: raw };
  }

  const frontmatter = raw.slice(4, end);
  const body = raw.slice(end + "\n---\n".length);
  const data: Record<string, unknown> = {};

  for (const line of frontmatter.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    data[key] = value;
  }

  return { data, body };
}

function commandNameFromPath(plugin: LoadedPlugin, filePath: string): string {
  const commandsRoot = plugin.components.commandsPath;
  if (!commandsRoot) {
    throw new Error(`Plugin ${plugin.name} has no commands path`);
  }

  const name = relative(commandsRoot, filePath)
    .replace(/\\/g, "/")
    .replace(/\.md$/, "")
    .split("/")
    .filter(Boolean)
    .join(":");

  return `${plugin.name}:${name}`;
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(path)));
      continue;
    }

    if (entry.isFile() && extname(entry.name) === ".md") {
      files.push(path);
    }
  }

  return files;
}

export async function loadPluginCommands(plugin: LoadedPlugin): Promise<CommandDefinition[]> {
  const commandsPath = plugin.components.commandsPath;
  if (!commandsPath) return [];

  const files = await collectMarkdownFiles(commandsPath);
  const commands: CommandDefinition[] = [];

  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const parsed = parseMarkdownWithFrontmatter(raw);
    const name = commandNameFromPath(plugin, file);

    commands.push({
      name,
      description: typeof parsed.data.description === "string" ? parsed.data.description : undefined,
      argumentHint: typeof parsed.data.argumentHint === "string" ? parsed.data.argumentHint : undefined,
      allowedTools: Array.isArray(parsed.data.allowedTools) ? parsed.data.allowedTools.filter(value => typeof value === "string") : [],
      source: "plugin",
      pluginName: plugin.name,
      filePath: file,
      content: parsed.body.trim(),
    });
  }

  return commands;
}
```

上面 frontmatter parser 是最小实现。

如果项目里已经有 yaml 解析器，就应该直接复用。

最小实现的限制是：

```text
allowedTools:
  - read
```

这种数组不会被完整解析。

所以正式实现建议把已有命令系统的 markdown 解析工具抽出来复用。

本章重点不是重新写 markdown parser，而是把插件能力加载进 registry。

## 命令注册

假设第十六章或前面章节已经有 `commandRegistry`。

现在把插件命令追加进去：

```ts
import { loadPluginCommands } from "../plugins/pluginCommands";
import type { LoadedPlugin } from "../plugins/pluginTypes";
import type { CommandDefinition } from "./commandTypes";

export async function loadAllCommands(plugins: LoadedPlugin[]): Promise<CommandDefinition[]> {
  const builtInCommands = await loadBuiltInCommands();
  const projectCommands = await loadProjectCommands();
  const pluginCommands: CommandDefinition[] = [];

  for (const plugin of plugins) {
    pluginCommands.push(...(await loadPluginCommands(plugin)));
  }

  return [
    ...builtInCommands,
    ...projectCommands,
    ...pluginCommands,
  ];
}
```

冲突策略：

```text
built-in 命令：/help
project 命令：/review
plugin 命令：/review-pack:review
```

插件命令天然有命名空间，所以不需要覆盖 project 命令。

如果用户觉得 `/review-pack:review` 太长，可以在项目命令里写一个短别名：

```markdown
---
description: Run team review
---

Run /review-pack:review for the current changes.
```

短别名由项目自己维护，不由插件系统偷偷注入。

## 插件 Agent

插件 Agent 也用 markdown。

例如 `agents/reviewer.md`：

```markdown
---
name: reviewer
description: Reviews code changes and reports bugs first
tools: read,grep,bash
model: sonnet
---

You are a focused code reviewer.

Prioritize:

- correctness bugs
- hidden regressions
- missing tests
- unsafe file operations

Return findings first.
```

加载后 agent type 是：

```text
review-pack:reviewer
```

新增 `src/plugins/pluginAgents.ts`：

```ts
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { LoadedPlugin } from "./pluginTypes";
import type { AgentDefinition } from "../agents/agentTypes";

function parseSimpleFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  if (!raw.startsWith("---\n")) return { data: {}, body: raw };

  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return { data: {}, body: raw };

  const data: Record<string, string> = {};
  const frontmatter = raw.slice(4, end);
  const body = raw.slice(end + "\n---\n".length);

  for (const line of frontmatter.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;

    data[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }

  return { data, body };
}

async function collectAgentFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectAgentFiles(path)));
      continue;
    }

    if (entry.isFile() && extname(entry.name) === ".md") {
      files.push(path);
    }
  }

  return files;
}

export async function loadPluginAgents(plugin: LoadedPlugin): Promise<AgentDefinition[]> {
  const agentsPath = plugin.components.agentsPath;
  if (!agentsPath) return [];

  const files = await collectAgentFiles(agentsPath);
  const agents: AgentDefinition[] = [];

  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const parsed = parseSimpleFrontmatter(raw);
    const baseName = parsed.data.name;

    if (!baseName) {
      throw new Error(`Plugin agent is missing name frontmatter: ${file}`);
    }

    agents.push({
      type: `${plugin.name}:${baseName}`,
      displayName: baseName,
      description: parsed.data.description,
      tools: parsed.data.tools ? parsed.data.tools.split(",").map(value => value.trim()).filter(Boolean) : [],
      model: parsed.data.model,
      source: "plugin",
      pluginName: plugin.name,
      filePath: file,
      prompt: parsed.body.trim(),
    });
  }

  return agents;
}
```

插件 Agent 有一个重要限制：

```text
插件 Agent 不应该能声明权限模式。
```

例如不要支持：

```yaml
permissionMode: bypass
```

原因很简单：

```text
权限模式是用户或项目的策略，不是插件作者的策略。
```

插件可以声明它希望使用哪些工具。

但最终能不能用，仍然要走已有权限系统。

## 插件 Skill

Skill 的目录约定：

```text
skills/
  review-quality/
    SKILL.md
  test-debugging/
    SKILL.md
```

新增 `src/plugins/pluginSkills.ts`：

```ts
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { LoadedPlugin } from "./pluginTypes";
import type { SkillDefinition } from "../skills/skillTypes";

export async function loadPluginSkills(plugin: LoadedPlugin): Promise<SkillDefinition[]> {
  const skillsPath = plugin.components.skillsPath;
  if (!skillsPath) return [];

  const entries = await readdir(skillsPath, { withFileTypes: true });
  const skills: SkillDefinition[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = join(skillsPath, entry.name);
    const skillFile = join(skillDir, "SKILL.md");

    try {
      const fileStat = await stat(skillFile);
      if (!fileStat.isFile()) continue;
    } catch {
      continue;
    }

    const content = await readFile(skillFile, "utf8");

    skills.push({
      name: basename(skillDir),
      source: "plugin",
      pluginName: plugin.name,
      rootPath: skillDir,
      filePath: skillFile,
      content,
    });
  }

  return skills;
}
```

Skill 名称是否要带插件命名空间？

这里有两种策略。

策略一：skill 名不带命名空间。

```text
review-quality
```

优点：

```text
模型选择 skill 时更自然。
```

缺点：

```text
多个插件提供同名 skill 会冲突。
```

策略二：skill 名带命名空间。

```text
review-pack:review-quality
```

优点：

```text
不会冲突。
```

缺点：

```text
模型可读性差一点。
```

Mini 第一版建议：

```text
命令和 Agent 必须带命名空间。
Skill 可以在 registry 内部记录 pluginName，展示时用 name，冲突时报错。
```

因为 skill 更多是给模型读的上下文，不是用户直接输入的稳定命令。

如果出现冲突，直接告诉用户：

```text
Skill name conflict: review-quality from review-pack and qa-pack.
```

让用户禁用其中一个插件。

## 插件 Hooks

hooks 文件沿用第三十六章的格式。

`hooks/hooks.json`：

```json
{
  "events": {
    "PostToolUse": [
      {
        "matcher": "write",
        "hooks": [
          {
            "type": "command",
            "command": "bun hooks/record-write.ts",
            "timeoutMs": 3000
          }
        ]
      }
    ]
  }
}
```

这里有一个关键问题：

```text
hook command 的工作目录是什么？
```

Mini 第一版建议：

```text
hook command 仍然在项目 cwd 执行。
但 hook input 里额外提供 pluginRoot。
```

这样插件 hook 脚本可以通过 `pluginRoot` 找到自己的资源。

不要默认在插件根目录执行。

因为用户脚本经常需要访问当前项目文件。

新增 `src/plugins/pluginHooks.ts`：

```ts
import { readFile } from "node:fs/promises";
import type { LoadedPlugin } from "./pluginTypes";
import type { HooksSettings } from "../hooks/hookTypes";

type PluginHookLoadResult = {
  hooks?: HooksSettings;
  pluginContext: {
    pluginName: string;
    pluginRoot: string;
  };
};

export async function loadPluginHooks(plugin: LoadedPlugin): Promise<PluginHookLoadResult | undefined> {
  const hooksPath = plugin.components.hooksPath;
  if (!hooksPath) return undefined;

  const raw = await readFile(hooksPath, "utf8");
  const parsed = JSON.parse(raw) as HooksSettings;

  return {
    hooks: parsed,
    pluginContext: {
      pluginName: plugin.name,
      pluginRoot: plugin.rootPath,
    },
  };
}
```

然后在 hook registry 里扩展注册函数：

```ts
import type { LoadedPlugin } from "../plugins/pluginTypes";
import { loadPluginHooks } from "../plugins/pluginHooks";

export async function registerPluginHooks(plugins: LoadedPlugin[]): Promise<void> {
  for (const plugin of plugins) {
    const loaded = await loadPluginHooks(plugin);
    if (!loaded?.hooks) continue;

    registerHooks(loaded.hooks, {
      source: "plugin",
      pluginName: loaded.pluginContext.pluginName,
      pluginRoot: loaded.pluginContext.pluginRoot,
    });
  }
}
```

第三十六章的 hook input 可以增加两个可选字段：

```ts
export type HookInput = {
  hookEventName: string;
  sessionId: string;
  cwd: string;
  pluginName?: string;
  pluginRoot?: string;
};
```

执行插件 hook 时注入：

```ts
const input = {
  ...baseHookInput,
  pluginName: matcher.source === "plugin" ? matcher.pluginName : undefined,
  pluginRoot: matcher.source === "plugin" ? matcher.pluginRoot : undefined,
};
```

安全边界仍然不变：

```text
插件 hooks 和项目 hooks 一样，执行前必须经过工作区信任检查。
PreToolUse hook 的 allow 仍然不能绕过权限 deny。
```

## 统一能力注册

插件 loader 不应该到处散落在 command、agent、skill、hook 启动代码里。

新增 `src/plugins/pluginRegistry.ts`：

```ts
import type { MiniSettings } from "../config/configTypes";
import type { CommandDefinition } from "../commands/commandTypes";
import type { AgentDefinition } from "../agents/agentTypes";
import type { SkillDefinition } from "../skills/skillTypes";
import { loadInstalledPlugins } from "./pluginLoader";
import { loadPluginCommands } from "./pluginCommands";
import { loadPluginAgents } from "./pluginAgents";
import { loadPluginSkills } from "./pluginSkills";
import { registerPluginHooks } from "../hooks/hookRegistry";
import type { LoadedPlugin, PluginLoadError } from "./pluginTypes";

export type PluginCapabilities = {
  plugins: LoadedPlugin[];
  commands: CommandDefinition[];
  agents: AgentDefinition[];
  skills: SkillDefinition[];
  errors: PluginLoadError[];
};

export async function loadPluginCapabilities(settings: MiniSettings): Promise<PluginCapabilities> {
  const loaded = await loadInstalledPlugins(settings);
  const commands: CommandDefinition[] = [];
  const agents: AgentDefinition[] = [];
  const skills: SkillDefinition[] = [];
  const errors: PluginLoadError[] = [...loaded.errors];

  for (const plugin of loaded.plugins) {
    try {
      commands.push(...(await loadPluginCommands(plugin)));
      agents.push(...(await loadPluginAgents(plugin)));
      skills.push(...(await loadPluginSkills(plugin)));
    } catch (error) {
      errors.push({
        pluginName: plugin.name,
        path: plugin.rootPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await registerPluginHooks(loaded.plugins);

  return {
    plugins: loaded.plugins,
    commands,
    agents,
    skills,
    errors,
  };
}
```

启动时可以这样接：

```ts
const settings = await loadEffectiveSettings();
const pluginCapabilities = await loadPluginCapabilities(settings);

commandRegistry.addMany(pluginCapabilities.commands);
agentRegistry.addMany(pluginCapabilities.agents);
skillRegistry.addMany(pluginCapabilities.skills);

for (const error of pluginCapabilities.errors) {
  logger.warn(`Plugin load failed: ${error.pluginName ?? error.path}: ${error.message}`);
}
```

这里的顺序很重要：

```text
1. 先读 effective settings。
2. 再加载已启用插件。
3. 再把插件能力注册进各 registry。
4. 再启动主循环。
```

不要在模型已经开始处理请求后再动态追加插件能力。

否则同一轮会话里的工具列表、命令列表、Agent 列表可能不一致。

## CLI 命令

新增 `src/plugins/pluginCommand.ts`：

```ts
import { installLocalPlugin, uninstallLocalPlugin } from "./pluginInstaller";
import { readInstalledPluginStore } from "./pluginInstallStore";
import { loadAllInstalledPluginSummaries } from "./pluginLoader";
import { validatePluginOnDisk } from "./pluginManifest";
import { setPluginEnabled } from "./pluginSettings";
import { loadEffectiveSettings } from "../config/configLoader";
import type { PluginScope } from "./pluginTypes";

function parseScope(value: string | undefined): PluginScope {
  if (value === "user" || value === "project" || value === "local") {
    return value;
  }

  return "project";
}

export async function validatePluginCommand(pluginPath: string): Promise<void> {
  const manifest = await validatePluginOnDisk(pluginPath);
  console.log(`Plugin ${manifest.name}@${manifest.version} is valid`);
}

export async function installPluginCommand(pluginPath: string, options: { scope?: string }): Promise<void> {
  const scope = parseScope(options.scope);
  const entry = await installLocalPlugin(pluginPath);

  await setPluginEnabled(entry.name, true, scope);

  console.log(`Installed ${entry.name}@${entry.version}`);
  console.log(`Enabled at ${scope} scope`);
}

export async function listPluginsCommand(): Promise<void> {
  const settings = await loadEffectiveSettings();
  const plugins = await loadAllInstalledPluginSummaries(settings);

  if (plugins.length === 0) {
    console.log("No plugins installed");
    return;
  }

  for (const plugin of plugins) {
    const state = plugin.enabled ? "enabled" : "disabled";
    console.log(`${plugin.name}@${plugin.version} ${state}`);
  }
}

export async function enablePluginCommand(pluginName: string, options: { scope?: string }): Promise<void> {
  const scope = parseScope(options.scope);
  const store = await readInstalledPluginStore();

  if (!store.plugins[pluginName]) {
    throw new Error(`Plugin is not installed: ${pluginName}`);
  }

  await setPluginEnabled(pluginName, true, scope);
  console.log(`Enabled ${pluginName} at ${scope} scope`);
}

export async function disablePluginCommand(pluginName: string, options: { scope?: string }): Promise<void> {
  const scope = parseScope(options.scope);

  await setPluginEnabled(pluginName, false, scope);
  console.log(`Disabled ${pluginName} at ${scope} scope`);
}

export async function uninstallPluginCommand(pluginName: string): Promise<void> {
  const removed = await uninstallLocalPlugin(pluginName);

  if (!removed) {
    throw new Error(`Plugin is not installed: ${pluginName}`);
  }

  console.log(`Uninstalled ${pluginName}`);
}
```

这里把 `install` 默认 scope 设为 `project`。

原因是本章面向团队项目共享能力，用户最常见的动作是：

```bash
bun run src/cli.ts plugin install ./plugins/review-pack --scope project
```

如果用户想只在自己机器启用：

```bash
bun run src/cli.ts plugin install ./plugins/review-pack --scope local
```

如果想所有项目默认启用：

```bash
bun run src/cli.ts plugin install ./plugins/review-pack --scope user
```

## CLI 接线

在 `src/cli.ts` 增加：

```ts
program
  .command("plugin")
  .description("Manage Mini plugins")
  .command("validate <path>")
  .description("Validate a local plugin")
  .action(validatePluginCommand);
```

如果你用的是 Commander 的子命令对象，建议写成：

```ts
const plugin = program.command("plugin").description("Manage Mini plugins");

plugin
  .command("validate <path>")
  .description("Validate a local plugin")
  .action(validatePluginCommand);

plugin
  .command("install <path>")
  .option("--scope <scope>", "user, project, or local")
  .description("Install a local plugin")
  .action(installPluginCommand);

plugin
  .command("list")
  .description("List installed plugins")
  .action(listPluginsCommand);

plugin
  .command("enable <name>")
  .option("--scope <scope>", "user, project, or local")
  .description("Enable a plugin")
  .action(enablePluginCommand);

plugin
  .command("disable <name>")
  .option("--scope <scope>", "user, project, or local")
  .description("Disable a plugin")
  .action(disablePluginCommand);

plugin
  .command("uninstall <name>")
  .description("Uninstall a plugin")
  .action(uninstallPluginCommand);
```

第一版不做交互式 UI。

CLI 足够完成核心闭环。

## 示例插件

建议在仓库里加一个示例插件：

```text
examples/plugins/review-pack/
  .mini-plugin/
    plugin.json
  commands/
    review.md
  agents/
    reviewer.md
  skills/
    review-quality/
      SKILL.md
  hooks/
    hooks.json
    record-write.ts
```

`examples/plugins/review-pack/.mini-plugin/plugin.json`：

```json
{
  "name": "review-pack",
  "version": "0.1.0",
  "description": "Review workflow plugin for Mini",
  "commands": "./commands",
  "agents": "./agents",
  "skills": "./skills",
  "hooks": "./hooks/hooks.json"
}
```

`examples/plugins/review-pack/commands/review.md`：

```markdown
---
description: Review current changes
argumentHint: "[scope]"
allowedTools: read,grep,bash
---

Review the current working tree.

Use the review-pack:reviewer agent if a focused code review is needed.

Scope from user: $ARGUMENTS
```

`examples/plugins/review-pack/agents/reviewer.md`：

```markdown
---
name: reviewer
description: Focused code reviewer
tools: read,grep,bash
model: sonnet
---

You are a focused code reviewer.

Report findings first.

For each finding include:

- file and line
- risk
- minimal fix

Do not summarize before findings.
```

`examples/plugins/review-pack/skills/review-quality/SKILL.md`：

```markdown
# review-quality

Use this skill when reviewing code changes.

Checklist:

- Verify behavior changes have tests.
- Check permission and filesystem boundaries.
- Check whether errors are actionable.
- Check whether configuration changes are documented.
```

`examples/plugins/review-pack/hooks/hooks.json`：

```json
{
  "events": {
    "PostToolUse": [
      {
        "matcher": "write",
        "hooks": [
          {
            "type": "command",
            "command": "bun hooks/record-write.ts",
            "timeoutMs": 3000
          }
        ]
      }
    ]
  }
}
```

这里的 hook command 用相对命令：

```text
bun hooks/record-write.ts
```

如果 command 在项目 cwd 执行，这条路径会找不到插件里的文件。

所以更稳的做法是：

```json
{
  "type": "command",
  "command": "bun ${MINI_PLUGIN_ROOT}/hooks/record-write.ts",
  "timeoutMs": 3000
}
```

第三十六章的 hook executor 可以在执行前替换内置变量：

```ts
function expandHookCommand(command: string, context: { pluginRoot?: string }): string {
  return command.replaceAll("${MINI_PLUGIN_ROOT}", context.pluginRoot ?? "");
}
```

如果不是插件 hook，`MINI_PLUGIN_ROOT` 为空。

更严格的实现可以在非插件 hook 使用该变量时直接报错。

## 能力加载顺序

启动主流程建议变成：

```text
1. 读取配置。
2. 加载插件。
3. 注册插件 hooks。
4. 注册内置命令、项目命令、插件命令。
5. 注册内置 Agent、项目 Agent、插件 Agent。
6. 注册内置 Skill、项目 Skill、插件 Skill。
7. 构建系统上下文。
8. 启动 query loop。
```

为什么插件 hooks 要尽早注册？

因为它可能参与后续启动事件：

```text
SessionStart
```

如果先触发 `SessionStart`，再注册插件 hooks，那么插件就错过了事件。

但是也不要早到配置之前。

因为插件是否启用来自配置。

所以顺序必须是：

```text
settings -> plugins -> hooks -> session events
```

## 错误处理

插件错误分两类。

第一类是用户主动操作错误：

```bash
bun run src/cli.ts plugin validate ./bad-plugin
```

这类错误应该直接失败：

```text
Invalid plugin manifest at ./bad-plugin/.mini-plugin/plugin.json:
commands must start with ./
```

第二类是启动时加载错误：

```text
某个已启用插件目录坏了。
```

这类错误不应该让 Mini 完全不能启动。

建议行为：

```text
1. 记录 warning。
2. 跳过这个插件。
3. 继续加载其他插件。
4. 在首屏或 debug 日志提示用户运行 plugin validate。
```

示例：

```ts
for (const error of pluginCapabilities.errors) {
  logWarning(
    `Plugin skipped: ${error.pluginName ?? "unknown"}${error.path ? ` at ${error.path}` : ""}: ${error.message}`,
  );
}
```

不要在普通输出里刷一大段 stack trace。

插件作者需要细节时，可以用：

```bash
bun run src/cli.ts plugin validate ./plugins/review-pack
```

## 安全边界

插件系统容易变成权限后门。

Mini 第一版必须守住这几条：

```text
1. 插件安装不执行插件代码。
2. 插件启用不执行插件代码。
3. 插件 hooks 执行前必须经过工作区信任。
4. 插件 command 只是提示词，不直接执行 shell。
5. 插件 Agent 不能声明 bypass 权限。
6. 插件 manifest 不能引用插件根目录外的文件。
7. 插件内容不能自动读取用户密钥。
8. 插件能力必须可追踪来源。
9. 插件加载失败不能降级到不受控路径。
10. 卸载插件要删除缓存，但不要删除用户项目目录。
```

最容易犯的错误是：

```text
安装时为了校验 hook，直接执行 hook。
```

不要这样做。

校验只应该读文件、解析 JSON、检查 schema。

执行行为只发生在用户真正运行 Mini 且事件触发时。

第二个常见错误是：

```text
插件 Agent frontmatter 里允许 permissionMode。
```

这会把权限策略交给插件作者。

Mini 必须拒绝或忽略这个字段。

第三个常见错误是：

```text
插件命令不带命名空间。
```

短期看起来方便，长期一定会冲突。

命令和 Agent 都要命名空间化。

## 测试：Schema

`src/plugins/__tests__/pluginSchema.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { parsePluginManifest } from "../pluginSchema";

describe("plugin manifest schema", () => {
  test("accepts a valid manifest", () => {
    const manifest = parsePluginManifest({
      name: "review-pack",
      version: "0.1.0",
      commands: "./commands",
      agents: "./agents",
      skills: "./skills",
      hooks: "./hooks/hooks.json",
    });

    expect(manifest.name).toBe("review-pack");
  });

  test("rejects path traversal", () => {
    expect(() =>
      parsePluginManifest({
        name: "review-pack",
        version: "0.1.0",
        commands: "../commands",
      }),
    ).toThrow();
  });

  test("rejects invalid plugin name", () => {
    expect(() =>
      parsePluginManifest({
        name: "Review Pack",
        version: "0.1.0",
      }),
    ).toThrow();
  });
});
```

## 测试：Manifest

`src/plugins/__tests__/pluginManifest.test.ts`：

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { validatePluginOnDisk } from "../pluginManifest";

async function createPlugin(root: string): Promise<void> {
  await mkdir(join(root, ".mini-plugin"), { recursive: true });
  await mkdir(join(root, "commands"), { recursive: true });
  await writeFile(
    join(root, ".mini-plugin", "plugin.json"),
    JSON.stringify({
      name: "review-pack",
      version: "0.1.0",
      commands: "./commands",
    }),
  );
}

describe("validatePluginOnDisk", () => {
  test("validates manifest and component paths", async () => {
    const root = await Bun.fileURLToPath(new URL(`./tmp-${Date.now()}`, import.meta.url));
    await createPlugin(root);

    const manifest = await validatePluginOnDisk(root);

    expect(manifest.name).toBe("review-pack");
  });
});
```

上面测试路径只是示意。

实际项目建议使用统一的 temp dir helper，避免测试结束后留下临时文件。

如果项目已经有 `makeTempDir()`，直接复用。

## 测试：安装器

`src/plugins/__tests__/pluginInstaller.test.ts`：

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { installLocalPlugin } from "../pluginInstaller";
import { getInstalledPluginsFile } from "../pluginPaths";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = join(import.meta.dir, `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempRoots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

async function createReviewPlugin(root: string): Promise<void> {
  await mkdir(join(root, ".mini-plugin"), { recursive: true });
  await mkdir(join(root, "commands"), { recursive: true });
  await writeFile(
    join(root, ".mini-plugin", "plugin.json"),
    JSON.stringify({
      name: "review-pack",
      version: "0.1.0",
      commands: "./commands",
    }),
  );
  await writeFile(join(root, "commands", "review.md"), "Review changes");
}

describe("installLocalPlugin", () => {
  afterEach(() => {
    delete process.env.MINI_HOME;
  });

  test("copies plugin into cache and writes install store", async () => {
    const miniHome = await makeTempRoot();
    const source = await makeTempRoot();
    process.env.MINI_HOME = miniHome;

    await createReviewPlugin(source);

    const entry = await installLocalPlugin(source);
    const storeRaw = await readFile(getInstalledPluginsFile(), "utf8");

    expect(entry.name).toBe("review-pack");
    expect(storeRaw).toContain("review-pack");
  });
});
```

这个测试验证两件事：

```text
1. 插件被复制到缓存。
2. 安装记录被写入。
```

不要在这个测试里验证 settings 启用。

那是 CLI 或 settings helper 的职责。

## 测试：能力注册

`src/plugins/__tests__/pluginRegistry.test.ts`：

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { installLocalPlugin } from "../pluginInstaller";
import { loadPluginCapabilities } from "../pluginRegistry";

async function createPlugin(root: string): Promise<void> {
  await mkdir(join(root, ".mini-plugin"), { recursive: true });
  await mkdir(join(root, "commands"), { recursive: true });
  await mkdir(join(root, "agents"), { recursive: true });
  await mkdir(join(root, "skills", "review-quality"), { recursive: true });

  await writeFile(
    join(root, ".mini-plugin", "plugin.json"),
    JSON.stringify({
      name: "review-pack",
      version: "0.1.0",
      commands: "./commands",
      agents: "./agents",
      skills: "./skills",
    }),
  );

  await writeFile(join(root, "commands", "review.md"), "Review changes");
  await writeFile(join(root, "agents", "reviewer.md"), "---\nname: reviewer\n---\nReview code");
  await writeFile(join(root, "skills", "review-quality", "SKILL.md"), "# review-quality");
}

describe("loadPluginCapabilities", () => {
  test("loads enabled plugin capabilities", async () => {
    const miniHome = join(import.meta.dir, `.tmp-home-${Date.now()}`);
    const source = join(import.meta.dir, `.tmp-plugin-${Date.now()}`);
    process.env.MINI_HOME = miniHome;

    await createPlugin(source);
    await installLocalPlugin(source);

    const result = await loadPluginCapabilities({
      plugins: {
        enabled: {
          "review-pack": true,
        },
      },
    });

    expect(result.commands.map(command => command.name)).toContain("review-pack:review");
    expect(result.agents.map(agent => agent.type)).toContain("review-pack:reviewer");
    expect(result.skills.map(skill => skill.name)).toContain("review-quality");
  });
});
```

这个测试是本章最重要的验收测试。

它证明插件系统不是只会读 manifest，而是能把能力真正送到 runtime registry。

## 手动验收

写完后，用示例插件跑一遍：

```bash
bun run src/cli.ts plugin validate examples/plugins/review-pack
bun run src/cli.ts plugin install examples/plugins/review-pack --scope project
bun run src/cli.ts plugin list
```

然后启动 Mini：

```bash
bun run src/cli.ts
```

在交互里确认：

```text
/review-pack:review
```

可以被识别。

再确认 Agent 可用：

```text
Use review-pack:reviewer to review the current diff.
```

最后确认 hook 被注册。

可以让示例 hook 在 `PostToolUse` 写一条本地日志，然后触发一次写文件工具。

期望看到：

```text
.mini/plugin-events.log
```

里面出现对应事件。

## 本章完成后的能力

到这里，Mini 已经不再只是一个单体 CLI。

它有了能力分发边界：

```text
核心系统：
  query loop
  tools
  permissions
  config
  hooks
  agents
  skills

插件系统：
  manifest
  install store
  enable settings
  capability loader
  registry bridge
```

插件作者可以打包能力：

```text
命令 + Agent + Skill + Hook
```

项目可以选择启用：

```text
.mini/settings.json
```

用户可以随时禁用：

```bash
bun run src/cli.ts plugin disable review-pack --scope project
```

这个结构会让后续能力继续变得自然。

例如：

- 团队审查插件。
- 数据库迁移插件。
- 发布检查插件。
- 文档生成插件。
- 安全审计插件。

它们都不需要改 Mini 核心代码。

## 常见坑

第一，插件加载时不要执行插件代码。

安装、校验、启用都只是读文件和写配置。

第二，插件命令和 Agent 必须命名空间化。

不要为了输入短，把插件命令注册成全局命令。

第三，安装和启用必须分开。

否则用户无法表达“这个插件在机器上存在，但当前项目不用”。

第四，插件 hooks 必须复用第三十六章的信任和权限模型。

不要给插件 hooks 开绿色通道。

第五，插件路径必须限制在插件根目录内。

只检查字符串不够，解析绝对路径后也要确认。

第六，启动时加载插件要容错。

一个坏插件不应该让 Mini 完全打不开。

第七，卸载只删除 Mini 缓存。

不要删除用户传给 `install` 的原始插件目录。

## 小结

本章把 commands、agents、skills、hooks 统一放进了插件系统。

现在 Mini 支持：

- 本地插件 manifest。
- 本地插件安装。
- settings 级启用和禁用。
- 插件命令注册。
- 插件 Agent 注册。
- 插件 Skill 注册。
- 插件 Hooks 注册。
- 插件校验和基础测试。

这一步是从“单项目工具”走向“团队能力平台”的关键分界线。

下一章可以继续做 **插件市场与版本更新**：支持插件来源、版本锁定、更新检查、缓存优先启动和更严格的供应链校验。
