# 第 38 章：插件市场与版本更新

第三十七章做了本地插件系统。

现在 Mini 已经可以从一个本地插件目录加载：

- commands。
- agents。
- skills。
- hooks。

但本地目录安装只能解决“我机器上有这个插件”的问题。

团队场景里还会遇到几个新问题：

- 插件从哪里发现。
- 插件当前最新版本是什么。
- 一个插件属于哪个团队插件源。
- 插件更新时旧版本如何保留。
- 已安装版本和市场版本如何比较。
- 启动时应该先用缓存，还是每次都联网。
- 市场源变更后如何同步。

所以本章继续补上插件市场与版本更新。

本章要做的不是复杂商店 UI，而是把三层状态分清楚：

```text
settings 声明意图
  -> known_marketplaces.json 物化市场
  -> installed_plugins.json 记录插件版本
  -> runtime registry 激活能力
```

第一版支持：

```bash
bun run src/cli.ts plugin marketplace add team ./examples/marketplaces/team --scope project
bun run src/cli.ts plugin marketplace update team
bun run src/cli.ts plugin marketplace list
bun run src/cli.ts plugin install review-pack@team --scope project
bun run src/cli.ts plugin update review-pack@team --scope project
bun run src/cli.ts plugin reload
```

这样 Mini 就可以从“单机本地插件”走向“团队可分发插件”。

## 真实工程怎么做

真实工程的插件市场与更新主要分布在这些文件里：

- `src/utils/plugins/schemas.ts`：定义 marketplace source、plugin source、marketplace manifest、known marketplaces、installed plugins 等 schema。
- `src/utils/plugins/marketplaceManager.ts`：管理 `known_marketplaces.json`、市场缓存、市场新增、刷新、读取、删除。
- `src/utils/plugins/marketplaceHelpers.ts`：处理市场加载失败、来源展示、allowlist/blocklist、插件 ID 等辅助逻辑。
- `src/utils/plugins/reconciler.ts`：把 settings 里声明的市场意图同步到本地物化状态。
- `src/services/plugins/pluginOperations.ts`：提供 install、uninstall、enable、disable、update 等核心操作。
- `src/utils/plugins/pluginInstallationHelpers.ts`：把 marketplace entry 缓存成版本化插件目录，并写入安装记录。
- `src/utils/plugins/pluginVersioning.ts`：计算插件版本，优先用 manifest version，其次用 marketplace version 或源码指纹。
- `src/utils/plugins/cacheUtils.ts`：清理插件缓存，标记孤儿版本，延迟删除旧版本。
- `src/services/plugins/PluginInstallationManager.ts`：后台同步市场，成功后刷新插件状态或提示用户 reload。
- `src/utils/plugins/refresh.ts`：清缓存并重新加载插件 commands、agents、hooks、MCP/LSP 等运行时能力。
- `src/cli/handlers/plugins.ts`：处理 `plugin marketplace add/list/remove/update` 和插件安装更新命令。

真实工程里的核心模型是三层：

```text
Layer 1: settings intent
  用户或项目声明“应该有哪些 marketplace”。

Layer 2: materialized cache
  本地磁盘上已经有 marketplace manifest 和插件版本缓存。

Layer 3: active runtime
  当前会话里已经注册到 AppState/registry 的插件能力。
```

这三层不能混在一起。

例如用户执行：

```text
plugin marketplace add team ./team-marketplace
```

真实工程不会只写一个缓存文件。

它会先记录用户意图，然后再把市场物化到本地缓存。

这样下一次启动时可以判断：

```text
settings 里声明了 team
known_marketplaces.json 里没有 team
=> 需要后台同步
```

真实工程还有几个关键设计：

```text
1. 插件 ID 使用 plugin@marketplace，避免不同市场里的同名插件冲突。
2. 市场 manifest 只描述可安装插件，不等同于已启用插件。
3. 安装插件时先写 settings，再缓存插件，实现 settings-first。
4. 插件缓存使用版本化路径：cache/marketplace/plugin/version。
5. 更新插件不是原地覆盖，而是复制到新版本路径，再更新安装记录。
6. 旧版本不立即删除，先标记为 orphan，延迟清理。
7. 启动时优先使用 cache-only，避免每次启动都阻塞在网络或仓库操作。
8. 市场同步失败不能让整个 CLI 启动失败。
9. 本地市场源是用户路径，删除市场不能误删用户目录。
10. URL 或仓库日志必须避免泄露凭据。
```

Mini 本章复刻这条主线，但第一版只支持三个市场来源：

```text
directory：本地目录，里面有 .mini-plugin/marketplace.json
file：本地 marketplace.json 文件
url：远程 marketplace.json 文件
```

仓库克隆可以作为可选扩展。

如果你的 Mini 已经有 `git` helper，可以加。

如果没有，先把 directory/file/url 跑通，市场架构就已经成立。

## 本章目标

完成后，Mini 支持一个市场目录：

```text
examples/marketplaces/team/
  .mini-plugin/
    marketplace.json
  plugins/
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

市场 manifest：

```json
{
  "name": "team",
  "owner": {
    "name": "Frontend Platform"
  },
  "metadata": {
    "version": "0.1.0",
    "description": "Team plugins for Mini"
  },
  "plugins": [
    {
      "name": "review-pack",
      "version": "0.1.0",
      "description": "Review workflow for Mini",
      "source": "./plugins/review-pack",
      "tags": ["review", "quality"]
    }
  ]
}
```

项目 settings 里声明市场源：

```json
{
  "marketplaces": {
    "known": {
      "team": {
        "source": {
          "type": "directory",
          "path": "./examples/marketplaces/team"
        },
        "autoUpdate": false
      }
    }
  }
}
```

本地物化状态写入：

```text
~/.claude-code-mini/plugins/known_marketplaces.json
```

安装状态写入：

```text
~/.claude-code-mini/plugins/installed_plugins.json
```

插件缓存写入：

```text
~/.claude-code-mini/plugins/cache/team/review-pack/0.1.0/
```

启用状态仍然写入 settings：

```json
{
  "plugins": {
    "enabled": {
      "review-pack@team": true
    }
  }
}
```

本章要实现：

- marketplace manifest 类型。
- marketplace manifest schema。
- marketplace source 解析。
- settings 中声明市场源。
- `known_marketplaces.json` 物化状态。
- 市场 add/list/update/remove。
- 市场 reconcile。
- 插件 ID 从 `name` 升级为 `name@marketplace`。
- 版本化插件缓存。
- installed plugins v2。
- 插件从市场安装。
- 插件非原地更新。
- orphan 旧版本清理。
- runtime reload。
- 市场和更新测试。

## 推荐目录

新增：

```text
src/plugins/marketplaceTypes.ts
src/plugins/marketplaceSchema.ts
src/plugins/marketplacePaths.ts
src/plugins/marketplaceStore.ts
src/plugins/marketplaceSource.ts
src/plugins/marketplaceLoader.ts
src/plugins/marketplaceManager.ts
src/plugins/marketplaceReconciler.ts
src/plugins/pluginVersion.ts
src/plugins/pluginCache.ts
src/plugins/pluginInstallStoreV2.ts
src/plugins/pluginMarketplaceInstall.ts
src/plugins/pluginUpdate.ts
src/plugins/pluginRefresh.ts
```

修改：

```text
src/plugins/pluginTypes.ts
src/plugins/pluginLoader.ts
src/plugins/pluginCommand.ts
src/plugins/pluginRegistry.ts
src/config/configTypes.ts
src/config/configDefaults.ts
src/config/configSchema.ts
src/config/configMerge.ts
src/cli.ts
```

新增测试：

```text
src/plugins/__tests__/marketplaceSchema.test.ts
src/plugins/__tests__/marketplaceSource.test.ts
src/plugins/__tests__/marketplaceReconciler.test.ts
src/plugins/__tests__/pluginMarketplaceInstall.test.ts
src/plugins/__tests__/pluginUpdate.test.ts
src/plugins/__tests__/pluginRefresh.test.ts
```

## 类型设计

新增 `src/plugins/marketplaceTypes.ts`：

```ts
export type MarketplaceSource =
  | {
      type: "directory";
      path: string;
    }
  | {
      type: "file";
      path: string;
    }
  | {
      type: "url";
      url: string;
      headers?: Record<string, string>;
    }
  | {
      type: "settings";
      name: string;
      plugins: MarketplacePluginEntry[];
    };

export type MarketplaceOwner = {
  name: string;
  email?: string;
  url?: string;
};

export type MarketplacePluginEntry = {
  name: string;
  version?: string;
  description?: string;
  source: string | RemotePluginSource;
  tags?: string[];
  strict?: boolean;
};

export type RemotePluginSource =
  | {
      type: "url";
      url: string;
      ref?: string;
      sha?: string;
    }
  | {
      type: "git";
      url: string;
      ref?: string;
      sha?: string;
    };

export type MarketplaceManifest = {
  name: string;
  owner: MarketplaceOwner;
  metadata?: {
    version?: string;
    description?: string;
  };
  plugins: MarketplacePluginEntry[];
};

export type KnownMarketplace = {
  source: MarketplaceSource;
  installLocation: string;
  lastUpdated: string;
  autoUpdate?: boolean;
};

export type KnownMarketplacesFile = {
  version: 1;
  marketplaces: Record<string, KnownMarketplace>;
};

export type MarketplaceDeclaration = {
  source: MarketplaceSource;
  autoUpdate?: boolean;
};
```

这里有两个 source。

不要混淆：

```text
MarketplaceSource：市场 manifest 从哪里来。
MarketplacePluginEntry.source：市场里的某个插件从哪里来。
```

例如：

```json
{
  "type": "directory",
  "path": "./examples/marketplaces/team"
}
```

表示市场来源。

而：

```json
{
  "name": "review-pack",
  "source": "./plugins/review-pack"
}
```

表示插件来源，且相对市场根目录。

## 插件 ID

第三十七章里 Mini 可以暂时用：

```text
review-pack
```

作为插件 ID。

引入市场后必须升级成：

```text
review-pack@team
```

新增 helper：

```ts
export type ParsedPluginId = {
  pluginName: string;
  marketplaceName?: string;
};

export function createPluginId(pluginName: string, marketplaceName: string): string {
  return `${pluginName}@${marketplaceName}`;
}

export function parsePluginId(pluginId: string): ParsedPluginId {
  const at = pluginId.indexOf("@");

  if (at === -1) {
    return { pluginName: pluginId };
  }

  return {
    pluginName: pluginId.slice(0, at),
    marketplaceName: pluginId.slice(at + 1),
  };
}

export function requireFullPluginId(pluginId: string): { pluginName: string; marketplaceName: string } {
  const parsed = parsePluginId(pluginId);

  if (!parsed.marketplaceName) {
    throw new Error(`Plugin ID must include marketplace: ${pluginId}`);
  }

  return {
    pluginName: parsed.pluginName,
    marketplaceName: parsed.marketplaceName,
  };
}
```

安装市场插件时，settings 里也要使用完整 ID：

```json
{
  "plugins": {
    "enabled": {
      "review-pack@team": true
    }
  }
}
```

这样两个市场都提供 `review-pack` 时不会冲突：

```text
review-pack@team
review-pack@security
```

## Marketplace Schema

新增 `src/plugins/marketplaceSchema.ts`：

```ts
import { z } from "zod";

const nameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "Use lowercase letters, digits, dash, or underscore");

const localPluginSourceSchema = z
  .string()
  .min(2)
  .refine(value => value.startsWith("./"), "Local plugin source must start with ./")
  .refine(value => !value.includes(".."), "Local plugin source cannot contain ..")
  .refine(value => !value.startsWith("/"), "Local plugin source cannot be absolute");

const remotePluginSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("url"),
    url: z.string().url(),
    ref: z.string().optional(),
    sha: z.string().optional(),
  }),
  z.object({
    type: z.literal("git"),
    url: z.string().min(1),
    ref: z.string().optional(),
    sha: z.string().optional(),
  }),
]);

export const marketplacePluginEntrySchema = z.object({
  name: nameSchema,
  version: z.string().min(1).optional(),
  description: z.string().max(400).optional(),
  source: z.union([localPluginSourceSchema, remotePluginSourceSchema]),
  tags: z.array(z.string()).optional(),
  strict: z.boolean().optional().default(true),
});

export const marketplaceManifestSchema = z.object({
  name: nameSchema,
  owner: z.object({
    name: z.string().min(1),
    email: z.string().optional(),
    url: z.string().optional(),
  }),
  metadata: z
    .object({
      version: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
  plugins: z.array(marketplacePluginEntrySchema),
});

export const marketplaceSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("directory"),
    path: z.string().min(1),
  }),
  z.object({
    type: z.literal("file"),
    path: z.string().min(1),
  }),
  z.object({
    type: z.literal("url"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal("settings"),
    name: nameSchema,
    plugins: z.array(marketplacePluginEntrySchema),
  }),
]);
```

注意第一版的 schema 不支持复杂来源。

这是故意的。

插件市场先把“声明、缓存、安装、更新”的链路跑通，比一开始支持所有来源更重要。

## 路径设计

新增 `src/plugins/marketplacePaths.ts`：

```ts
import { homedir } from "node:os";
import { join } from "node:path";

export function getMiniHome(): string {
  return process.env.MINI_HOME ?? join(homedir(), ".claude-code-mini");
}

export function getPluginHome(): string {
  return join(getMiniHome(), "plugins");
}

export function getKnownMarketplacesFile(): string {
  return join(getPluginHome(), "known_marketplaces.json");
}

export function getMarketplaceCacheDir(): string {
  return join(getPluginHome(), "marketplaces");
}

export function getMarketplaceCachePath(marketplaceName: string): string {
  return join(getMarketplaceCacheDir(), marketplaceName);
}

export function getPluginCacheDir(): string {
  return join(getPluginHome(), "cache");
}

export function getVersionedPluginCachePath(pluginId: string, version: string): string {
  const [pluginName, marketplaceName] = pluginId.split("@");

  if (!pluginName || !marketplaceName) {
    throw new Error(`Invalid plugin ID: ${pluginId}`);
  }

  return join(getPluginCacheDir(), marketplaceName, pluginName, version);
}
```

版本化缓存路径是本章重点：

```text
cache/team/review-pack/0.1.0/
cache/team/review-pack/0.2.0/
```

更新时不要覆盖旧目录。

先写新目录，再切换安装记录。

这样更新失败不会破坏当前可用版本。

## Settings 接入

在 `src/config/configTypes.ts` 增加：

```ts
import type { MarketplaceDeclaration } from "../plugins/marketplaceTypes";

export type MarketplaceSettings = {
  known?: Record<string, MarketplaceDeclaration>;
};

export type PluginSettings = {
  enabled?: Record<string, boolean>;
};

export type MiniSettings = {
  plugins?: PluginSettings;
  marketplaces?: MarketplaceSettings;
};
```

默认值：

```ts
export const DEFAULT_MARKETPLACE_SETTINGS: MarketplaceSettings = {
  known: {},
};

export const DEFAULT_SETTINGS: MiniSettings = {
  plugins: {
    enabled: {},
  },
  marketplaces: DEFAULT_MARKETPLACE_SETTINGS,
};
```

schema：

```ts
import { marketplaceSourceSchema } from "../plugins/marketplaceSchema";

const marketplaceSettingsSchema = z.object({
  known: z
    .record(
      z.string(),
      z.object({
        source: marketplaceSourceSchema,
        autoUpdate: z.boolean().optional(),
      }),
    )
    .optional(),
});

export const miniSettingsSchema = z.object({
  plugins: pluginSettingsSchema.optional(),
  marketplaces: marketplaceSettingsSchema.optional(),
});
```

合并时要深合并：

```ts
function mergeMarketplaceSettings(
  base: MarketplaceSettings | undefined,
  override: MarketplaceSettings | undefined,
): MarketplaceSettings | undefined {
  if (!base && !override) return undefined;

  return {
    known: {
      ...(base?.known ?? {}),
      ...(override?.known ?? {}),
    },
  };
}
```

市场源是声明意图。

它不等于市场已经可用。

例如：

```json
{
  "marketplaces": {
    "known": {
      "team": {
        "source": {
          "type": "directory",
          "path": "./examples/marketplaces/team"
        }
      }
    }
  }
}
```

只是说明：

```text
当前项目希望有一个 team 市场。
```

实际是否已经加载，要看：

```text
known_marketplaces.json
```

## Known Marketplaces Store

新增 `src/plugins/marketplaceStore.ts`：

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getKnownMarketplacesFile } from "./marketplacePaths";
import type { KnownMarketplace, KnownMarketplacesFile } from "./marketplaceTypes";

const EMPTY_STORE: KnownMarketplacesFile = {
  version: 1,
  marketplaces: {},
};

type NodeError = Error & {
  code?: string;
};

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeError).code === "ENOENT";
}

export async function readKnownMarketplaces(): Promise<KnownMarketplacesFile> {
  const file = getKnownMarketplacesFile();

  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as KnownMarketplacesFile;

    if (parsed.version !== 1 || typeof parsed.marketplaces !== "object" || parsed.marketplaces === null) {
      throw new Error("Invalid known marketplaces store");
    }

    return parsed;
  } catch (error) {
    if (isMissingFile(error)) {
      return EMPTY_STORE;
    }

    throw error;
  }
}

export async function writeKnownMarketplaces(store: KnownMarketplacesFile): Promise<void> {
  const file = getKnownMarketplacesFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export async function upsertKnownMarketplace(name: string, marketplace: KnownMarketplace): Promise<void> {
  const store = await readKnownMarketplaces();
  store.marketplaces[name] = marketplace;
  await writeKnownMarketplaces(store);
}

export async function removeKnownMarketplace(name: string): Promise<boolean> {
  const store = await readKnownMarketplaces();

  if (!store.marketplaces[name]) {
    return false;
  }

  delete store.marketplaces[name];
  await writeKnownMarketplaces(store);
  return true;
}
```

这里不要在读取失败时无脑返回空对象。

如果 JSON 文件损坏，应该报错。

否则下一次写入可能把用户已有市场记录全部覆盖掉。

可以额外提供一个安全读取函数：

```ts
export async function readKnownMarketplacesSafe(): Promise<KnownMarketplacesFile> {
  try {
    return await readKnownMarketplaces();
  } catch {
    return EMPTY_STORE;
  }
}
```

这个安全版本只能用于只读路径。

不要用于读后写。

## Source 解析

新增 `src/plugins/marketplaceSource.ts`：

```ts
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { MarketplaceSource } from "./marketplaceTypes";

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return input;
}

export async function parseMarketplaceInput(input: string): Promise<MarketplaceSource> {
  const value = input.trim();

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return {
      type: "url",
      url: value,
    };
  }

  const resolved = resolve(expandHome(value));
  const stats = await stat(resolved);

  if (stats.isDirectory()) {
    return {
      type: "directory",
      path: resolved,
    };
  }

  if (stats.isFile() && resolved.endsWith(".json")) {
    return {
      type: "file",
      path: resolved,
    };
  }

  throw new Error(`Marketplace input must be a directory, a JSON file, or a URL: ${input}`);
}
```

第一版不需要猜测太多格式。

如果用户给了一个路径，就必须存在。

如果用户给了 URL，就按 marketplace JSON 下载。

这样错误可控。

## 读取 Marketplace Manifest

新增 `src/plugins/marketplaceLoader.ts`：

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { marketplaceManifestSchema } from "./marketplaceSchema";
import { getMarketplaceCachePath } from "./marketplacePaths";
import type { MarketplaceManifest, MarketplaceSource } from "./marketplaceTypes";

export const MINI_MARKETPLACE_MANIFEST_PATH = ".mini-plugin/marketplace.json";

export async function readMarketplaceManifestFromFile(filePath: string): Promise<MarketplaceManifest> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return marketplaceManifestSchema.parse(parsed);
}

export async function readMarketplaceManifestFromDirectory(directoryPath: string): Promise<MarketplaceManifest> {
  return readMarketplaceManifestFromFile(join(directoryPath, MINI_MARKETPLACE_MANIFEST_PATH));
}

async function fetchMarketplaceManifest(url: string, headers?: Record<string, string>): Promise<MarketplaceManifest> {
  const response = await fetch(url, {
    headers,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch marketplace: ${response.status} ${response.statusText}`);
  }

  const parsed = (await response.json()) as unknown;
  return marketplaceManifestSchema.parse(parsed);
}

export async function materializeMarketplace(
  expectedName: string,
  source: MarketplaceSource,
): Promise<{ manifest: MarketplaceManifest; installLocation: string }> {
  if (source.type === "directory") {
    const manifest = await readMarketplaceManifestFromDirectory(source.path);
    assertMarketplaceName(expectedName, manifest.name);

    return {
      manifest,
      installLocation: resolve(source.path),
    };
  }

  if (source.type === "file") {
    const manifest = await readMarketplaceManifestFromFile(source.path);
    assertMarketplaceName(expectedName, manifest.name);

    return {
      manifest,
      installLocation: resolve(source.path),
    };
  }

  if (source.type === "settings") {
    const manifest: MarketplaceManifest = {
      name: source.name,
      owner: {
        name: "settings",
      },
      plugins: source.plugins,
    };
    assertMarketplaceName(expectedName, manifest.name);

    const cachePath = join(getMarketplaceCachePath(expectedName), "marketplace.json");
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    return {
      manifest,
      installLocation: cachePath,
    };
  }

  const manifest = await fetchMarketplaceManifest(source.url, source.headers);
  assertMarketplaceName(expectedName, manifest.name);

  const cachePath = join(getMarketplaceCachePath(expectedName), "marketplace.json");
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    manifest,
    installLocation: cachePath,
  };
}

function assertMarketplaceName(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new Error(`Marketplace name mismatch: settings key is ${expected}, manifest name is ${actual}`);
  }
}
```

这里强制 `settings key` 和 manifest 里的 `name` 一致。

否则用户可能写：

```json
{
  "marketplaces": {
    "team": {
      "source": {
        "type": "directory",
        "path": "./evil"
      }
    }
  }
}
```

但 `evil/.mini-plugin/marketplace.json` 里声明：

```json
{
  "name": "security"
}
```

如果不拦截，后续插件 ID 和缓存路径会混乱。

## Marketplace Manager

新增 `src/plugins/marketplaceManager.ts`：

```ts
import { upsertKnownMarketplace, readKnownMarketplaces } from "./marketplaceStore";
import { materializeMarketplace, readMarketplaceManifestFromDirectory, readMarketplaceManifestFromFile } from "./marketplaceLoader";
import type { MarketplaceManifest, MarketplacePluginEntry, MarketplaceSource } from "./marketplaceTypes";

export async function addMarketplaceSource(
  name: string,
  source: MarketplaceSource,
  options?: { autoUpdate?: boolean },
): Promise<MarketplaceManifest> {
  const { manifest, installLocation } = await materializeMarketplace(name, source);

  await upsertKnownMarketplace(name, {
    source,
    installLocation,
    lastUpdated: new Date().toISOString(),
    autoUpdate: options?.autoUpdate,
  });

  return manifest;
}

export async function getMarketplace(name: string): Promise<MarketplaceManifest | null> {
  const store = await readKnownMarketplaces();
  const known = store.marketplaces[name];

  if (!known) {
    return null;
  }

  if (known.source.type === "directory") {
    return readMarketplaceManifestFromDirectory(known.installLocation);
  }

  if (known.source.type === "file") {
    return readMarketplaceManifestFromFile(known.installLocation);
  }

  return readMarketplaceManifestFromFile(known.installLocation);
}

export async function findMarketplacePlugin(pluginId: string): Promise<{
  marketplaceName: string;
  marketplace: MarketplaceManifest;
  entry: MarketplacePluginEntry;
  installLocation: string;
} | null> {
  const [pluginName, marketplaceName] = pluginId.split("@");

  if (!pluginName || !marketplaceName) {
    throw new Error(`Plugin ID must include marketplace: ${pluginId}`);
  }

  const store = await readKnownMarketplaces();
  const known = store.marketplaces[marketplaceName];
  if (!known) return null;

  const marketplace = await getMarketplace(marketplaceName);
  if (!marketplace) return null;

  const entry = marketplace.plugins.find(plugin => plugin.name === pluginName);
  if (!entry) return null;

  return {
    marketplaceName,
    marketplace,
    entry,
    installLocation: known.installLocation,
  };
}
```

`findMarketplacePlugin` 是安装和更新的核心入口。

安装插件时不要扫描用户所有文件。

应该只从已知市场读取：

```text
known_marketplaces.json -> marketplace manifest -> plugin entry
```

如果市场还没物化，应该提示：

```text
Marketplace team is not materialized. Run plugin marketplace update team.
```

或者让启动后台 reconcile 自动补齐。

## Reconciler

reconciler 的职责是：

```text
让 settings 里声明的 marketplace 和 known_marketplaces.json 保持一致。
```

新增 `src/plugins/marketplaceReconciler.ts`：

```ts
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import type { MiniSettings } from "../config/configTypes";
import { addMarketplaceSource } from "./marketplaceManager";
import { readKnownMarketplaces } from "./marketplaceStore";
import type { MarketplaceDeclaration, MarketplaceSource } from "./marketplaceTypes";

export type MarketplaceDiff = {
  missing: string[];
  sourceChanged: Array<{
    name: string;
    declaredSource: MarketplaceSource;
    materializedSource: MarketplaceSource;
  }>;
  upToDate: string[];
};

export function diffMarketplaces(
  declared: Record<string, MarketplaceDeclaration>,
  materialized: Record<string, { source: MarketplaceSource }>,
  projectRoot: string,
): MarketplaceDiff {
  const missing: string[] = [];
  const sourceChanged: MarketplaceDiff["sourceChanged"] = [];
  const upToDate: string[] = [];

  for (const [name, declaration] of Object.entries(declared)) {
    const known = materialized[name];
    const normalizedDeclaredSource = normalizeMarketplaceSource(declaration.source, projectRoot);

    if (!known) {
      missing.push(name);
      continue;
    }

    if (!isDeepStrictEqual(normalizedDeclaredSource, known.source)) {
      sourceChanged.push({
        name,
        declaredSource: normalizedDeclaredSource,
        materializedSource: known.source,
      });
      continue;
    }

    upToDate.push(name);
  }

  return {
    missing,
    sourceChanged,
    upToDate,
  };
}

export async function reconcileMarketplaces(settings: MiniSettings, projectRoot: string): Promise<{
  installed: string[];
  updated: string[];
  failed: Array<{ name: string; error: string }>;
  upToDate: string[];
}> {
  const declared = settings.marketplaces?.known ?? {};
  const materialized = await readKnownMarketplaces();
  const diff = diffMarketplaces(declared, materialized.marketplaces, projectRoot);

  const installed: string[] = [];
  const updated: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const name of diff.missing) {
    try {
      const declaration = declared[name]!;
      await addMarketplaceSource(name, normalizeMarketplaceSource(declaration.source, projectRoot), {
        autoUpdate: declaration.autoUpdate,
      });
      installed.push(name);
    } catch (error) {
      failed.push({
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const item of diff.sourceChanged) {
    try {
      const declaration = declared[item.name]!;
      await addMarketplaceSource(item.name, item.declaredSource, {
        autoUpdate: declaration.autoUpdate,
      });
      updated.push(item.name);
    } catch (error) {
      failed.push({
        name: item.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    installed,
    updated,
    failed,
    upToDate: diff.upToDate,
  };
}

function normalizeMarketplaceSource(source: MarketplaceSource, projectRoot: string): MarketplaceSource {
  if ((source.type === "directory" || source.type === "file") && !source.path.startsWith("/")) {
    return {
      ...source,
      path: resolve(projectRoot, source.path),
    };
  }

  return source;
}
```

这个 reconciler 是幂等的。

重复运行不会重复安装：

```text
settings 和 known_marketplaces.json 一致 -> upToDate
```

只有两种情况会动磁盘：

```text
missing：settings 有，known 文件没有。
sourceChanged：settings 有，known 文件也有，但 source 不一样。
```

## 版本计算

新增 `src/plugins/pluginVersion.ts`：

```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MarketplacePluginEntry } from "./marketplaceTypes";
import { readPluginManifest } from "./pluginManifest";

export async function calculatePluginVersion(
  pluginId: string,
  pluginRoot: string,
  entry: MarketplacePluginEntry,
): Promise<string> {
  try {
    const manifest = await readPluginManifest(pluginRoot);
    if (manifest.version) return manifest.version;
  } catch {
    // Marketplace version or content hash will be used below.
  }

  if (entry.version) {
    return entry.version;
  }

  const manifestFile = join(pluginRoot, ".mini-plugin", "plugin.json");

  try {
    const content = await readFile(manifestFile);
    return createHash("sha256").update(content).digest("hex").slice(0, 12);
  } catch {
    return createHash("sha256").update(`${pluginId}:${Date.now()}`).digest("hex").slice(0, 12);
  }
}
```

优先级：

```text
plugin manifest version
  > marketplace entry version
  > plugin manifest content hash
  > fallback hash
```

如果以后支持仓库来源，可以把 commit SHA 插入到 entry version 后面。

不要只用当前时间。

时间只能作为最后兜底，因为它会导致每次安装都看起来是新版本。

## 版本化缓存

新增 `src/plugins/pluginCache.ts`：

```ts
import { mkdir, readdir, copyFile, rm, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getVersionedPluginCachePath } from "./marketplacePaths";
import { calculatePluginVersion } from "./pluginVersion";
import type { MarketplacePluginEntry } from "./marketplaceTypes";

const ORPHANED_AT = ".orphaned_at";

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

export async function cacheMarketplacePlugin(params: {
  pluginId: string;
  marketplaceInstallLocation: string;
  entry: MarketplacePluginEntry;
}): Promise<{ version: string; installPath: string }> {
  const sourcePath = resolveLocalPluginSource(params.marketplaceInstallLocation, params.entry.source);
  const sourceStat = await stat(sourcePath);

  if (!sourceStat.isDirectory()) {
    throw new Error(`Plugin source must be a directory: ${sourcePath}`);
  }

  const version = await calculatePluginVersion(params.pluginId, sourcePath, params.entry);
  const targetPath = getVersionedPluginCachePath(params.pluginId, version);

  await rm(targetPath, { recursive: true, force: true });
  await mkdir(dirname(targetPath), { recursive: true });
  await copyDirectory(sourcePath, targetPath);

  return {
    version,
    installPath: targetPath,
  };
}

export async function markPluginVersionOrphaned(installPath: string): Promise<void> {
  await writeFile(join(installPath, ORPHANED_AT), `${Date.now()}`, "utf8");
}

function resolveLocalPluginSource(marketplaceInstallLocation: string, source: MarketplacePluginEntry["source"]): string {
  if (typeof source !== "string") {
    throw new Error("Remote plugin source is not implemented in this chapter");
  }

  const base = marketplaceInstallLocation.endsWith(".json")
    ? dirname(marketplaceInstallLocation)
    : marketplaceInstallLocation;

  const resolved = resolve(base, source);
  const normalizedBase = resolve(base);

  if (resolved !== normalizedBase && !resolved.startsWith(`${normalizedBase}/`)) {
    throw new Error(`Plugin source escapes marketplace root: ${source}`);
  }

  return resolved;
}
```

本章第一版只实现本地相对插件源：

```json
{
  "source": "./plugins/review-pack"
}
```

远程插件源的入口类型已经预留，但可以先抛出明确错误。

不要偷偷尝试执行外部命令。

## Installed Plugins V2

第三十七章的安装记录是简单 map。

引入市场后，需要记录 scope 和 projectPath。

因为同一个插件可能被不同项目以不同 scope 安装。

新增 `src/plugins/pluginInstallStoreV2.ts`：

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getInstalledPluginsFile } from "./pluginPaths";
import type { PluginScope } from "./pluginTypes";

export type PluginInstallationEntry = {
  scope: PluginScope;
  projectPath?: string;
  version: string;
  installPath: string;
  installedAt: string;
  lastUpdated: string;
};

export type InstalledPluginsFileV2 = {
  version: 2;
  plugins: Record<string, PluginInstallationEntry[]>;
};

const EMPTY_STORE: InstalledPluginsFileV2 = {
  version: 2,
  plugins: {},
};

type NodeError = Error & {
  code?: string;
};

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeError).code === "ENOENT";
}

export async function readInstalledPluginsV2(): Promise<InstalledPluginsFileV2> {
  try {
    const raw = await readFile(getInstalledPluginsFile(), "utf8");
    const parsed = JSON.parse(raw) as InstalledPluginsFileV2;

    if (parsed.version !== 2 || typeof parsed.plugins !== "object" || parsed.plugins === null) {
      throw new Error("Invalid installed plugins file");
    }

    return parsed;
  } catch (error) {
    if (isMissingFile(error)) {
      return EMPTY_STORE;
    }

    throw error;
  }
}

export async function writeInstalledPluginsV2(store: InstalledPluginsFileV2): Promise<void> {
  const file = getInstalledPluginsFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export async function upsertPluginInstallation(
  pluginId: string,
  entry: PluginInstallationEntry,
): Promise<void> {
  const store = await readInstalledPluginsV2();
  const existing = store.plugins[pluginId] ?? [];
  const next = existing.filter(item => item.scope !== entry.scope || item.projectPath !== entry.projectPath);

  next.push(entry);
  store.plugins[pluginId] = next;

  await writeInstalledPluginsV2(store);
}

export async function updatePluginInstallationPath(params: {
  pluginId: string;
  scope: PluginScope;
  projectPath?: string;
  installPath: string;
  version: string;
}): Promise<PluginInstallationEntry | undefined> {
  const store = await readInstalledPluginsV2();
  const entries = store.plugins[params.pluginId] ?? [];
  const now = new Date().toISOString();
  let oldEntry: PluginInstallationEntry | undefined;

  store.plugins[params.pluginId] = entries.map(entry => {
    if (entry.scope !== params.scope || entry.projectPath !== params.projectPath) {
      return entry;
    }

    oldEntry = entry;

    return {
      ...entry,
      installPath: params.installPath,
      version: params.version,
      lastUpdated: now,
    };
  });

  await writeInstalledPluginsV2(store);
  return oldEntry;
}
```

这里的结构是：

```json
{
  "version": 2,
  "plugins": {
    "review-pack@team": [
      {
        "scope": "project",
        "projectPath": "/Users/me/app",
        "version": "0.1.0",
        "installPath": "/Users/me/.claude-code-mini/plugins/cache/team/review-pack/0.1.0",
        "installedAt": "2026-05-26T10:00:00.000Z",
        "lastUpdated": "2026-05-26T10:00:00.000Z"
      }
    ]
  }
}
```

## 从市场安装插件

新增 `src/plugins/pluginMarketplaceInstall.ts`：

```ts
import { getCwd } from "../runtime/cwd";
import { setPluginEnabled } from "./pluginSettings";
import { createPluginId, requireFullPluginId } from "./pluginId";
import { findMarketplacePlugin } from "./marketplaceManager";
import { cacheMarketplacePlugin } from "./pluginCache";
import { upsertPluginInstallation } from "./pluginInstallStoreV2";
import type { PluginScope } from "./pluginTypes";

export async function installPluginFromMarketplace(pluginId: string, scope: PluginScope): Promise<{
  pluginId: string;
  version: string;
  installPath: string;
}> {
  const parsed = requireFullPluginId(pluginId);
  const fullId = createPluginId(parsed.pluginName, parsed.marketplaceName);
  const info = await findMarketplacePlugin(fullId);

  if (!info) {
    throw new Error(`Plugin not found in marketplace: ${fullId}`);
  }

  const cached = await cacheMarketplacePlugin({
    pluginId: fullId,
    marketplaceInstallLocation: info.installLocation,
    entry: info.entry,
  });

  const now = new Date().toISOString();
  const projectPath = scope === "project" || scope === "local" ? getCwd() : undefined;

  await upsertPluginInstallation(fullId, {
    scope,
    projectPath,
    version: cached.version,
    installPath: cached.installPath,
    installedAt: now,
    lastUpdated: now,
  });

  await setPluginEnabled(fullId, true, scope);

  return {
    pluginId: fullId,
    version: cached.version,
    installPath: cached.installPath,
  };
}
```

注意这里的顺序和真实工程略有取舍。

真实工程强调 settings-first：

```text
先写 settings 意图，再缓存插件。
```

Mini 第一版为了减少半成功状态，可以先缓存成功，再写安装记录和 settings。

两种都可以。

但要明确语义：

```text
settings 是启用意图。
installed_plugins.json 是物化结果。
```

如果你希望严格对齐真实工程，可以改成：

```text
1. 先写 settings enabled true。
2. 再缓存插件。
3. 再写安装记录。
4. 缓存失败时给出“已声明但未物化”的提示。
```

对教学版 Mini，我建议先采用更容易理解的“缓存成功后启用”。

## 更新插件

更新必须是非原地更新。

不要这样做：

```text
cache/team/review-pack/current/
  直接覆盖里面的文件
```

正确流程：

```text
1. 找到 marketplace entry。
2. 重新读取插件源。
3. 计算新版本。
4. 复制到 cache/team/review-pack/newVersion。
5. 如果版本和当前一样，返回 already up to date。
6. 更新 installed_plugins.json 的 installPath/version。
7. 把旧 installPath 标记为 orphan。
8. 提示用户 reload。
```

新增 `src/plugins/pluginUpdate.ts`：

```ts
import { getCwd } from "../runtime/cwd";
import { requireFullPluginId } from "./pluginId";
import { findMarketplacePlugin } from "./marketplaceManager";
import { cacheMarketplacePlugin, markPluginVersionOrphaned } from "./pluginCache";
import { readInstalledPluginsV2, updatePluginInstallationPath } from "./pluginInstallStoreV2";
import type { PluginScope } from "./pluginTypes";

export async function updatePluginFromMarketplace(pluginId: string, scope: PluginScope): Promise<{
  pluginId: string;
  oldVersion?: string;
  newVersion: string;
  alreadyUpToDate: boolean;
}> {
  requireFullPluginId(pluginId);

  const store = await readInstalledPluginsV2();
  const projectPath = scope === "project" || scope === "local" ? getCwd() : undefined;
  const current = store.plugins[pluginId]?.find(
    entry => entry.scope === scope && entry.projectPath === projectPath,
  );

  if (!current) {
    throw new Error(`Plugin is not installed at ${scope} scope: ${pluginId}`);
  }

  const info = await findMarketplacePlugin(pluginId);
  if (!info) {
    throw new Error(`Plugin not found in marketplace: ${pluginId}`);
  }

  const cached = await cacheMarketplacePlugin({
    pluginId,
    marketplaceInstallLocation: info.installLocation,
    entry: info.entry,
  });

  if (cached.version === current.version || cached.installPath === current.installPath) {
    return {
      pluginId,
      oldVersion: current.version,
      newVersion: cached.version,
      alreadyUpToDate: true,
    };
  }

  const oldEntry = await updatePluginInstallationPath({
    pluginId,
    scope,
    projectPath,
    installPath: cached.installPath,
    version: cached.version,
  });

  if (oldEntry && oldEntry.installPath !== cached.installPath) {
    await markPluginVersionOrphaned(oldEntry.installPath);
  }

  return {
    pluginId,
    oldVersion: current.version,
    newVersion: cached.version,
    alreadyUpToDate: false,
  };
}
```

更新后不要假装当前会话已经使用新版本。

因为 commands、agents、skills、hooks 已经加载进内存。

所以返回信息要明确：

```text
Updated review-pack@team from 0.1.0 to 0.2.0. Run plugin reload to activate.
```

## Runtime Reload

新增 `src/plugins/pluginRefresh.ts`：

```ts
import { clearCommandRegistry, registerCommands } from "../commands/commandRegistry";
import { clearAgentRegistry, registerAgents } from "../agents/agentRegistry";
import { clearSkillRegistry, registerSkills } from "../skills/skillRegistry";
import { clearPluginHooks, registerPluginHooks } from "../hooks/hookRegistry";
import { loadEffectiveSettings } from "../config/configLoader";
import { loadPluginCapabilities } from "./pluginRegistry";

export async function reloadPlugins(): Promise<{
  commandCount: number;
  agentCount: number;
  skillCount: number;
  errorCount: number;
}> {
  const settings = await loadEffectiveSettings();
  const capabilities = await loadPluginCapabilities(settings);

  clearCommandRegistry("plugin");
  clearAgentRegistry("plugin");
  clearSkillRegistry("plugin");
  await clearPluginHooks();

  registerCommands(capabilities.commands);
  registerAgents(capabilities.agents);
  registerSkills(capabilities.skills);
  await registerPluginHooks(capabilities.plugins);

  return {
    commandCount: capabilities.commands.length,
    agentCount: capabilities.agents.length,
    skillCount: capabilities.skills.length,
    errorCount: capabilities.errors.length,
  };
}
```

真实工程的刷新还要处理 AppState、MCP、LSP 和连接重建。

Mini 第一版只需要刷新四类能力：

```text
commands
agents
skills
hooks
```

刷新要做到“完整替换”，而不是只追加。

否则禁用插件后，旧 hook 可能还会继续触发。

## Loader 改造

第三十七章的 loader 从简单安装记录读取：

```text
review-pack -> installPath
```

本章要改成：

```text
review-pack@team -> installations[] -> 当前 scope 最匹配的 installPath
```

优先级：

```text
local 当前项目
  > project 当前项目
  > user
```

示例：

```ts
import { getCwd } from "../runtime/cwd";
import { readInstalledPluginsV2 } from "./pluginInstallStoreV2";
import type { MiniSettings } from "../config/configTypes";

function isEnabled(pluginId: string, settings: MiniSettings): boolean {
  return settings.plugins?.enabled?.[pluginId] === true;
}

function pickInstallation(
  installations: Array<{ scope: string; projectPath?: string; installPath: string }>,
  cwd: string,
): { installPath: string } | undefined {
  return (
    installations.find(item => item.scope === "local" && item.projectPath === cwd) ??
    installations.find(item => item.scope === "project" && item.projectPath === cwd) ??
    installations.find(item => item.scope === "user")
  );
}

export async function loadInstalledPlugins(settings: MiniSettings): Promise<PluginLoadResult> {
  const store = await readInstalledPluginsV2();
  const cwd = getCwd();
  const plugins: LoadedPlugin[] = [];
  const errors: PluginLoadError[] = [];

  for (const [pluginId, installations] of Object.entries(store.plugins)) {
    if (!isEnabled(pluginId, settings)) continue;

    const installation = pickInstallation(installations, cwd);

    if (!installation) {
      errors.push({
        pluginName: pluginId,
        message: "Plugin is enabled but not installed for this scope",
      });
      continue;
    }

    try {
      plugins.push(await createLoadedPluginFromPath(pluginId, installation.installPath, true));
    } catch (error) {
      errors.push({
        pluginName: pluginId,
        path: installation.installPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    plugins,
    errors,
  };
}
```

这里要注意：

```text
enabled true 但没有安装记录
```

不是正常状态。

可能原因：

- 市场还没同步。
- 插件缓存被手动删除。
- 安装中断。
- settings 从别的机器同步过来，但本机还没安装插件。

Mini 应该给出可恢复提示：

```text
Run plugin install review-pack@team --scope project
```

或：

```text
Run plugin marketplace update team
```

## CLI：Marketplace

在 `src/plugins/pluginCommand.ts` 增加：

```ts
import { parseMarketplaceInput } from "./marketplaceSource";
import { addMarketplaceSource } from "./marketplaceManager";
import { readKnownMarketplaces } from "./marketplaceStore";
import { reconcileMarketplaces } from "./marketplaceReconciler";
import { loadEffectiveSettings } from "../config/configLoader";
import { updateSettings } from "../config/configWriter";
import type { PluginScope } from "./pluginTypes";

function parseScope(value: string | undefined): PluginScope {
  if (value === "user" || value === "project" || value === "local") return value;
  return "project";
}

export async function marketplaceAddCommand(
  name: string,
  input: string,
  options: { scope?: string; autoUpdate?: boolean },
): Promise<void> {
  const scope = parseScope(options.scope);
  const source = await parseMarketplaceInput(input);

  await updateSettings(scope, current => ({
    ...current,
    marketplaces: {
      ...(current.marketplaces ?? {}),
      known: {
        ...(current.marketplaces?.known ?? {}),
        [name]: {
          source,
          autoUpdate: options.autoUpdate,
        },
      },
    },
  }));

  const manifest = await addMarketplaceSource(name, source, {
    autoUpdate: options.autoUpdate,
  });

  console.log(`Added marketplace ${manifest.name} with ${manifest.plugins.length} plugin(s)`);
}

export async function marketplaceListCommand(): Promise<void> {
  const store = await readKnownMarketplaces();
  const entries = Object.entries(store.marketplaces);

  if (entries.length === 0) {
    console.log("No marketplaces configured");
    return;
  }

  for (const [name, marketplace] of entries) {
    console.log(`${name} ${marketplace.source.type} ${marketplace.installLocation}`);
  }
}

export async function marketplaceUpdateCommand(name?: string): Promise<void> {
  const settings = await loadEffectiveSettings();
  const result = await reconcileMarketplaces(settings, process.cwd());

  if (name) {
    const touched = result.installed.includes(name) || result.updated.includes(name) || result.upToDate.includes(name);
    if (!touched) {
      const failure = result.failed.find(item => item.name === name);
      if (failure) throw new Error(failure.error);
      throw new Error(`Marketplace is not declared in settings: ${name}`);
    }
  }

  console.log(`Marketplaces installed: ${result.installed.length}`);
  console.log(`Marketplaces updated: ${result.updated.length}`);
  console.log(`Marketplaces up to date: ${result.upToDate.length}`);

  if (result.failed.length > 0) {
    console.log(`Marketplaces failed: ${result.failed.length}`);
  }
}
```

接线：

```ts
const plugin = program.command("plugin").description("Manage Mini plugins");
const marketplace = plugin.command("marketplace").description("Manage plugin marketplaces");

marketplace
  .command("add <name> <source>")
  .option("--scope <scope>", "user, project, or local")
  .option("--auto-update", "refresh this marketplace automatically")
  .action(marketplaceAddCommand);

marketplace
  .command("list")
  .action(marketplaceListCommand);

marketplace
  .command("update [name]")
  .action(marketplaceUpdateCommand);
```

`marketplace add` 同时做两件事：

```text
1. 写 settings 声明。
2. 立即物化一次。
```

这样用户添加完就能安装插件。

如果立即物化失败，settings 是否保留要看你的产品取舍。

教学版建议：

```text
先写 settings，再尝试物化。
物化失败时保留 settings，并提示用户稍后运行 marketplace update。
```

因为 settings 是用户的意图。

网络或路径问题可以后续修复。

## CLI：Install / Update / Reload

改造插件安装命令：

```ts
import { installPluginFromMarketplace } from "./pluginMarketplaceInstall";
import { updatePluginFromMarketplace } from "./pluginUpdate";
import { reloadPlugins } from "./pluginRefresh";

export async function installPluginCommand(pluginId: string, options: { scope?: string }): Promise<void> {
  const scope = parseScope(options.scope);
  const result = await installPluginFromMarketplace(pluginId, scope);

  console.log(`Installed ${result.pluginId}@${result.version}`);
  console.log("Run plugin reload to activate in the current session");
}

export async function updatePluginCommand(pluginId: string, options: { scope?: string }): Promise<void> {
  const scope = parseScope(options.scope);
  const result = await updatePluginFromMarketplace(pluginId, scope);

  if (result.alreadyUpToDate) {
    console.log(`${pluginId} is already up to date (${result.newVersion})`);
    return;
  }

  console.log(`Updated ${pluginId} from ${result.oldVersion ?? "unknown"} to ${result.newVersion}`);
  console.log("Run plugin reload to activate in the current session");
}

export async function reloadPluginCommand(): Promise<void> {
  const result = await reloadPlugins();

  console.log(`Reloaded plugin commands: ${result.commandCount}`);
  console.log(`Reloaded plugin agents: ${result.agentCount}`);
  console.log(`Reloaded plugin skills: ${result.skillCount}`);
  console.log(`Plugin errors: ${result.errorCount}`);
}
```

接线：

```ts
plugin
  .command("install <pluginId>")
  .option("--scope <scope>", "user, project, or local")
  .action(installPluginCommand);

plugin
  .command("update <pluginId>")
  .option("--scope <scope>", "user, project, or local")
  .action(updatePluginCommand);

plugin
  .command("reload")
  .action(reloadPluginCommand);
```

安装和更新都要求完整插件 ID：

```text
review-pack@team
```

如果用户只写：

```text
review-pack
```

Mini 可以提示：

```text
Plugin ID must include marketplace. Try review-pack@team.
```

第一版不要自动猜。

因为不同市场可能有同名插件。

## 启动策略：Cache First

真实工程启动时不会每次都强制同步所有市场。

Mini 也应该这样。

推荐启动流程：

```text
1. 读取 settings。
2. 用 installed_plugins.json + 插件缓存加载已启用插件。
3. 如果有 marketplace 声明缺失，后台 reconcile。
4. reconcile 成功后提示用户 reload，或在首轮前自动 reload。
```

不要这样：

```text
启动 CLI -> 先下载所有市场 -> 再进入 REPL
```

这会让用户在网络差时无法使用已安装插件。

可以新增：

```ts
export async function maybeReconcileMarketplacesInBackground(settings: MiniSettings): Promise<void> {
  reconcileMarketplaces(settings, process.cwd()).catch(error => {
    logger.warn(`Marketplace reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}
```

然后启动时：

```ts
const settings = await loadEffectiveSettings();
const capabilities = await loadPluginCapabilities(settings);

registerPluginCapabilities(capabilities);

void maybeReconcileMarketplacesInBackground(settings);
```

如果是 headless 模式，用户更希望第一轮就可用。

可以提供一个显式同步命令：

```bash
bun run src/cli.ts plugin marketplace update
bun run src/cli.ts plugin reload
```

不要隐藏太多自动行为。

## Orphan 清理

更新插件后，旧版本目录可能没有任何安装记录引用。

不要立即删除。

原因：

```text
1. 当前会话可能仍在使用旧路径。
2. 更新刚完成但 reload 还没执行。
3. 用户可能需要回滚。
```

本章采用标记机制：

```text
cache/team/review-pack/0.1.0/.orphaned_at
```

后台清理规则：

```text
1. 读取 installed_plugins.json，收集仍被引用的 installPath。
2. 扫描 cache/marketplace/plugin/version。
3. 被引用的版本删除 .orphaned_at。
4. 未被引用且没有 .orphaned_at，写入 .orphaned_at。
5. 未被引用且 .orphaned_at 超过 7 天，删除目录。
```

示例：

```ts
export async function cleanupOrphanedPluginVersions(): Promise<void> {
  const installed = await readInstalledPluginsV2();
  const referenced = new Set<string>();

  for (const entries of Object.values(installed.plugins)) {
    for (const entry of entries) {
      referenced.add(entry.installPath);
    }
  }

  // 实现时遍历 getPluginCacheDir() 下的 marketplace/plugin/version。
  // 文档里省略目录遍历代码，按第三十七章 copyDirectory 的方式写即可。
}
```

清理可以在启动后后台跑。

不要阻塞主流程。

## 安全边界

市场系统比本地插件更敏感。

Mini 第一版必须守住这些规则：

```text
1. marketplace add 不执行插件代码。
2. marketplace update 不执行插件代码。
3. install 只复制插件目录和写配置，不执行 hooks。
4. 插件 source 是相对路径时，解析后必须仍在 marketplace 根目录内。
5. URL 下载只接受 JSON manifest，不自动执行返回内容。
6. headers 可能含敏感信息，日志里必须打码。
7. 删除 marketplace 不能删除用户原始目录。
8. 更新插件不能原地覆盖当前运行版本。
9. 启动时优先使用缓存，不能因为远程不可用导致本地插件全部不可用。
10. 不要自动信任新市场里的 hooks，仍然走工作区信任和权限链路。
```

还要注意市场名。

第一版可以禁止几个保留名：

```text
inline
builtin
official
```

避免后续引入内置插件或会话插件时冲突。

## 测试：Marketplace Schema

`src/plugins/__tests__/marketplaceSchema.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { marketplaceManifestSchema } from "../marketplaceSchema";

describe("marketplace manifest schema", () => {
  test("accepts a valid marketplace", () => {
    const manifest = marketplaceManifestSchema.parse({
      name: "team",
      owner: {
        name: "Frontend Platform",
      },
      plugins: [
        {
          name: "review-pack",
          version: "0.1.0",
          source: "./plugins/review-pack",
        },
      ],
    });

    expect(manifest.name).toBe("team");
  });

  test("rejects plugin source path traversal", () => {
    expect(() =>
      marketplaceManifestSchema.parse({
        name: "team",
        owner: {
          name: "Frontend Platform",
        },
        plugins: [
          {
            name: "review-pack",
            source: "../review-pack",
          },
        ],
      }),
    ).toThrow();
  });
});
```

## 测试：Reconciler

`src/plugins/__tests__/marketplaceReconciler.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { diffMarketplaces } from "../marketplaceReconciler";

describe("diffMarketplaces", () => {
  test("reports missing marketplaces", () => {
    const diff = diffMarketplaces(
      {
        team: {
          source: {
            type: "directory",
            path: "./examples/marketplaces/team",
          },
        },
      },
      {},
      "/repo",
    );

    expect(diff.missing).toEqual(["team"]);
  });

  test("reports up to date marketplace after path normalization", () => {
    const diff = diffMarketplaces(
      {
        team: {
          source: {
            type: "directory",
            path: "./examples/marketplaces/team",
          },
        },
      },
      {
        team: {
          source: {
            type: "directory",
            path: "/repo/examples/marketplaces/team",
          },
        },
      },
      "/repo",
    );

    expect(diff.upToDate).toEqual(["team"]);
  });
});
```

## 测试：安装市场插件

`src/plugins/__tests__/pluginMarketplaceInstall.test.ts`：

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { addMarketplaceSource } from "../marketplaceManager";
import { installPluginFromMarketplace } from "../pluginMarketplaceInstall";
import { getInstalledPluginsFile } from "../pluginPaths";

async function createMarketplace(root: string): Promise<void> {
  const pluginRoot = join(root, "plugins", "review-pack");

  await mkdir(join(root, ".mini-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, ".mini-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "commands"), { recursive: true });

  await writeFile(
    join(root, ".mini-plugin", "marketplace.json"),
    JSON.stringify({
      name: "team",
      owner: {
        name: "Frontend Platform",
      },
      plugins: [
        {
          name: "review-pack",
          version: "0.1.0",
          source: "./plugins/review-pack",
        },
      ],
    }),
  );

  await writeFile(
    join(pluginRoot, ".mini-plugin", "plugin.json"),
    JSON.stringify({
      name: "review-pack",
      version: "0.1.0",
      commands: "./commands",
    }),
  );

  await writeFile(join(pluginRoot, "commands", "review.md"), "Review changes");
}

describe("installPluginFromMarketplace", () => {
  test("caches a plugin and writes v2 install state", async () => {
    const home = join(import.meta.dir, `.tmp-home-${Date.now()}`);
    const marketplaceRoot = join(import.meta.dir, `.tmp-marketplace-${Date.now()}`);
    process.env.MINI_HOME = home;

    await createMarketplace(marketplaceRoot);
    await addMarketplaceSource("team", {
      type: "directory",
      path: marketplaceRoot,
    });

    const result = await installPluginFromMarketplace("review-pack@team", "project");
    const store = await readFile(getInstalledPluginsFile(), "utf8");

    expect(result.version).toBe("0.1.0");
    expect(store).toContain("review-pack@team");
    expect(store).toContain("0.1.0");
  });
});
```

## 测试：更新插件

`src/plugins/__tests__/pluginUpdate.test.ts`：

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { addMarketplaceSource } from "../marketplaceManager";
import { installPluginFromMarketplace } from "../pluginMarketplaceInstall";
import { updatePluginFromMarketplace } from "../pluginUpdate";

async function writePluginVersion(pluginRoot: string, version: string): Promise<void> {
  await mkdir(join(pluginRoot, ".mini-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "commands"), { recursive: true });

  await writeFile(
    join(pluginRoot, ".mini-plugin", "plugin.json"),
    JSON.stringify({
      name: "review-pack",
      version,
      commands: "./commands",
    }),
  );

  await writeFile(join(pluginRoot, "commands", "review.md"), `Review version ${version}`);
}

describe("updatePluginFromMarketplace", () => {
  test("updates to a new version without overwriting old path", async () => {
    const home = join(import.meta.dir, `.tmp-home-${Date.now()}`);
    const marketplaceRoot = join(import.meta.dir, `.tmp-marketplace-${Date.now()}`);
    const pluginRoot = join(marketplaceRoot, "plugins", "review-pack");
    process.env.MINI_HOME = home;

    await mkdir(join(marketplaceRoot, ".mini-plugin"), { recursive: true });
    await writeFile(
      join(marketplaceRoot, ".mini-plugin", "marketplace.json"),
      JSON.stringify({
        name: "team",
        owner: {
          name: "Frontend Platform",
        },
        plugins: [
          {
            name: "review-pack",
            source: "./plugins/review-pack",
          },
        ],
      }),
    );

    await writePluginVersion(pluginRoot, "0.1.0");
    await addMarketplaceSource("team", { type: "directory", path: marketplaceRoot });
    const installed = await installPluginFromMarketplace("review-pack@team", "project");

    await writePluginVersion(pluginRoot, "0.2.0");
    const updated = await updatePluginFromMarketplace("review-pack@team", "project");

    expect(updated.oldVersion).toBe("0.1.0");
    expect(updated.newVersion).toBe("0.2.0");
    expect(updated.alreadyUpToDate).toBe(false);

    const oldMarker = await readFile(join(installed.installPath, ".orphaned_at"), "utf8");
    expect(oldMarker.length).toBeGreaterThan(0);
  });
});
```

这个测试证明：

```text
新版本写到新路径。
旧版本被标记 orphan。
旧路径没有被直接删除。
```

## 手动验收

创建示例市场后运行：

```bash
bun run src/cli.ts plugin marketplace add team examples/marketplaces/team --scope project
bun run src/cli.ts plugin marketplace list
bun run src/cli.ts plugin marketplace update team
bun run src/cli.ts plugin install review-pack@team --scope project
bun run src/cli.ts plugin reload
```

确认命令可用：

```text
/review-pack:review
```

然后把示例插件的 version 改成 `0.2.0`：

```json
{
  "name": "review-pack",
  "version": "0.2.0"
}
```

再次运行：

```bash
bun run src/cli.ts plugin update review-pack@team --scope project
bun run src/cli.ts plugin reload
```

检查缓存目录：

```text
~/.claude-code-mini/plugins/cache/team/review-pack/0.1.0/
~/.claude-code-mini/plugins/cache/team/review-pack/0.2.0/
```

旧版本目录里应该有：

```text
.orphaned_at
```

## 常见坑

第一，把 marketplace 和 plugin 混成一个概念。

marketplace 是索引。

plugin 是可安装能力。

第二，安装时只写 settings，不写安装记录。

这样下次启动会看到插件启用，但找不到本地路径。

第三，更新时直接覆盖旧版本目录。

运行中的会话可能还在引用旧文件。

第四，插件 ID 不带 marketplace。

这会导致同名插件冲突。

第五，市场源相对路径不归一化。

项目 settings 里写 `./examples/marketplaces/team`，物化文件里写绝对路径。

diff 时必须先归一化再比较。

第六，启动时强制同步所有市场。

网络不可用时用户连已有插件都用不了。

第七，删除市场时误删用户目录。

本地 directory/file source 是用户资产，只能删除 Mini 自己的物化记录和缓存。

第八，日志打印完整 URL header 或凭据。

调试日志也不能泄露 secrets。

## 小结

本章给 Mini 增加了插件市场和版本更新能力。

现在 Mini 具备：

- marketplace manifest。
- marketplace source。
- settings 级市场声明。
- `known_marketplaces.json` 物化状态。
- `plugin@marketplace` ID。
- 版本化插件缓存。
- installed plugins v2。
- 从市场安装插件。
- 非原地更新插件。
- orphan 旧版本清理。
- runtime reload。

这一章完成后，插件已经具备团队分发的基本形态。

下一章可以继续做 **插件依赖与供应链策略**：支持依赖闭包、跨市场依赖限制、来源 allowlist/blocklist、保留市场名、防冒充和更严格的安装审计。
