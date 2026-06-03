# 第 39 章：插件依赖与供应链策略

第三十八章把 Mini 的插件分发链路补齐了。

现在 Mini 已经支持：

- marketplace manifest。
- `plugin@marketplace` ID。
- 版本化缓存。
- 从市场安装插件。
- 非原地更新插件。
- runtime reload。

但插件市场一旦存在，新的风险也会出现。

例如：

- 一个插件依赖另一个插件。
- 依赖插件可能在另一个市场里。
- 某个市场可能被组织策略禁止。
- 某个插件可能被管理员强制禁用。
- 插件从市场下架后，本机仍然缓存着旧版本。
- 插件安装成功，但运行时依赖被用户禁用了。
- 插件源可能伪装成官方来源。

这些问题不能靠“安装时复制目录”解决。

本章给 Mini 加上插件依赖与供应链策略。

目标是把四个判断分清楚：

```text
发现：这个插件是否存在于已知市场。
安装：这个插件及其依赖是否允许被物化到本机。
启用：这个插件是否允许写入 settings。
运行：当前会话里依赖是否仍然满足。
```

真实工程里这几个判断分布在不同模块。

Mini 第一版也应该保持这种分层。

## 真实工程怎么做

真实工程的依赖与供应链策略主要分布在这些文件里：

- `src/utils/plugins/dependencyResolver.ts`：纯函数依赖解析。负责依赖引用规范化、闭包解析、循环检测、跨市场限制、运行时依赖校验和反向依赖查询。
- `src/utils/plugins/pluginInstallationHelpers.ts`：安装时解析依赖闭包，写 settings，缓存闭包里的每个插件，并检查策略阻断。
- `src/services/plugins/pluginOperations.ts`：安装、启用、禁用、卸载、更新时统一接入策略和依赖提示。
- `src/utils/plugins/marketplaceHelpers.ts`：实现市场来源 allowlist/blocklist、host pattern、path pattern、blocklist 优先级和错误提示。
- `src/utils/plugins/pluginPolicy.ts`：从托管 settings 判断插件是否被组织策略强制禁用。
- `src/utils/plugins/managedPlugins.ts`：找出被组织策略锁定的插件名，避免会话级插件覆盖。
- `src/utils/plugins/pluginBlocklist.ts`：检测市场里已经下架的插件，按市场策略自动卸载并标记。
- `src/utils/plugins/pluginFlagging.ts`：记录被下架清理的插件，供 UI 展示和用户确认。
- `src/utils/plugins/schemas.ts`：定义 `dependencies`、`allowCrossMarketplaceDependenciesOn`、`strictKnownMarketplaces`、`blockedMarketplaces`、保留市场名和 marketplace/plugin source schema。
- `src/utils/plugins/pluginLoader.ts`：加载所有插件后执行 `verifyAndDemote`，把依赖不满足的插件在当前会话降级为 disabled。
- `src/commands/plugin/PluginTrustWarning.tsx`：在插件安装 UI 里展示信任提示，强调插件可能包含外部服务、文件和其他软件。

真实工程有几个关键设计：

```text
1. 依赖是 presence guarantee，不是模块加载图。
2. 依赖解析是纯函数，不直接读磁盘、不写 settings。
3. 安装时做闭包解析，避免只安装根插件。
4. 运行时再做一次依赖校验，避免用户禁用依赖后插件仍然运行。
5. 跨市场依赖默认禁止。
6. 只有根市场的 allowCrossMarketplaceDependenciesOn 生效，不做传递信任。
7. 用户已经手动启用的跨市场依赖不会被安装闭包重复写入。
8. 组织策略强制禁用的插件不能安装，也不能启用。
9. 市场来源策略在下载或读文件前检查。
10. 插件下架检测和安全标记是市场策略的一部分。
```

Mini 本章复刻这条主线。

但先做最小可用版本：

```text
dependencies 字段
  -> install-time closure
  -> cross-marketplace guard
  -> policy allow/block
  -> load-time demote
  -> audit log
```

## 本章目标

完成后，插件 manifest 可以写：

```json
{
  "name": "deploy-pack",
  "version": "0.1.0",
  "description": "Deployment workflow plugin",
  "dependencies": ["review-pack"],
  "commands": "./commands"
}
```

如果 `deploy-pack@team` 依赖 `review-pack`，Mini 会把依赖规范化成：

```text
review-pack@team
```

安装时：

```bash
bun run src/cli.ts plugin install deploy-pack@team --scope project
```

Mini 会计算闭包：

```text
review-pack@team
deploy-pack@team
```

然后一起缓存、一起写 settings。

如果插件依赖另一个市场：

```json
{
  "name": "deploy-pack",
  "dependencies": ["secret-scan@security"]
}
```

默认会失败：

```text
Cross-marketplace dependency is blocked: secret-scan@security
```

只有根市场 `team` 明确允许：

```json
{
  "name": "team",
  "owner": {
    "name": "Frontend Platform"
  },
  "allowCrossMarketplaceDependenciesOn": ["security"],
  "plugins": []
}
```

Mini 才可以自动安装 `secret-scan@security`。

本章要实现：

- 依赖字段 schema。
- 依赖引用规范化。
- install-time 依赖闭包解析。
- 循环依赖检测。
- 缺失依赖错误。
- 跨市场依赖限制。
- 根市场 allowlist。
- 组织级市场来源 allowlist/blocklist。
- 组织级插件 block。
- load-time 依赖校验和 demote。
- 禁用/卸载反向依赖提示。
- 下架插件检测。
- 供应链审计日志。
- 相关测试。

## 推荐目录

新增：

```text
src/plugins/dependencyTypes.ts
src/plugins/dependencyResolver.ts
src/plugins/pluginPolicy.ts
src/plugins/marketplacePolicy.ts
src/plugins/pluginAudit.ts
src/plugins/pluginDelisting.ts
src/plugins/pluginInstallWithDependencies.ts

src/plugins/__tests__/
  dependencyResolver.test.ts
  pluginPolicy.test.ts
  marketplacePolicy.test.ts
  pluginInstallWithDependencies.test.ts
  pluginDelisting.test.ts
```

修改：

```text
src/plugins/pluginTypes.ts
src/plugins/pluginSchema.ts
src/plugins/marketplaceTypes.ts
src/plugins/marketplaceSchema.ts
src/plugins/pluginMarketplaceInstall.ts
src/plugins/pluginLoader.ts
src/plugins/pluginCommand.ts
src/plugins/pluginRegistry.ts
src/config/configTypes.ts
src/config/configSchema.ts
src/config/configMerge.ts
```

本章新增的核心模块要保持一个原则：

```text
依赖解析只做纯计算。
策略模块只回答允许或禁止。
安装模块负责写磁盘和 settings。
loader 模块负责运行时降级。
```

不要让一个函数同时做所有事情。

## 类型补充

先给插件 manifest 增加依赖字段。

修改 `src/plugins/pluginTypes.ts`：

```ts
export type DependencyRef = string | {
  name: string;
  marketplace?: string;
};

export type PluginManifest = {
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  dependencies?: string[];
  commands?: string;
  agents?: string;
  skills?: string;
  hooks?: string;
};
```

这里 runtime 里只保留 `string[]`。

对象写法在 schema 里转换掉。

原因是依赖解析器应该只处理一种格式：

```text
plugin
plugin@marketplace
```

如果后续要做版本范围，可以继续在 schema 层接收更多形式，再转换成 runtime 结构。

## 依赖 Schema

修改 `src/plugins/pluginSchema.ts`：

```ts
const dependencyNameSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-_]*(?:@[a-z0-9][a-z0-9-_]*)?(?:@\\^[^@]+)?$/);

const dependencyRefSchema = z
  .union([
    dependencyNameSchema.transform(value => value.replace(/@\\^[^@]+$/, "")),
    z
      .object({
        name: pluginNameSchema,
        marketplace: pluginNameSchema.optional(),
      })
      .transform(value => value.marketplace ? `${value.name}@${value.marketplace}` : value.name),
  ]);

export const pluginManifestSchema = z.object({
  name: pluginNameSchema,
  version: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  author: z.string().max(160).optional(),
  homepage: z.string().url().optional(),
  repository: z.string().url().optional(),
  dependencies: z.array(dependencyRefSchema).optional(),
  commands: relativePluginPathSchema.optional(),
  agents: relativePluginPathSchema.optional(),
  skills: relativePluginPathSchema.optional(),
  hooks: relativePluginPathSchema.optional(),
});
```

为什么这里允许：

```text
plugin@marketplace@^1.2.0
```

但会把 `@^1.2.0` 去掉？

这是向前兼容。

第一版 Mini 不做版本范围。

但如果以后插件作者提前写了版本范围，旧客户端不应该直接拒绝整个插件。

旧客户端可以先理解为：

```text
需要这个插件存在。
```

版本范围校验留给后续章节。

## Marketplace Schema 补充

第三十八章的 marketplace manifest 增加两个字段：

```ts
export type MarketplaceManifest = {
  name: string;
  owner: MarketplaceOwner;
  metadata?: {
    version?: string;
    description?: string;
  };
  allowCrossMarketplaceDependenciesOn?: string[];
  forceRemoveDeletedPlugins?: boolean;
  plugins: MarketplacePluginEntry[];
};
```

schema：

```ts
export const marketplaceManifestSchema = z.object({
  name: marketplaceNameSchema,
  owner: ownerSchema,
  metadata: metadataSchema.optional(),
  allowCrossMarketplaceDependenciesOn: z.array(marketplaceNameSchema).optional(),
  forceRemoveDeletedPlugins: z.boolean().optional(),
  plugins: z.array(marketplacePluginEntrySchema),
});
```

含义：

```text
allowCrossMarketplaceDependenciesOn：
  根市场允许自动安装哪些其他市场的依赖。

forceRemoveDeletedPlugins：
  插件从该市场移除后，Mini 可以自动卸载本机用户可控 scope 的安装。
```

注意只使用根市场的 allowlist。

如果：

```text
A 允许 B
B 允许 C
```

安装 `root@A` 时，不应该因为 `B` 允许 `C` 就自动拉 `C`。

根市场才是用户选择信任的源。

## Settings 策略字段

在 `src/config/configTypes.ts` 增加：

```ts
import type { MarketplaceSource } from "../plugins/marketplaceTypes";

export type PluginPolicySettings = {
  blockedPlugins?: Record<string, boolean>;
  strictKnownMarketplaces?: MarketplaceSource[];
  blockedMarketplaces?: MarketplaceSource[];
  pluginTrustMessage?: string;
};

export type MiniSettings = {
  plugins?: PluginSettings;
  marketplaces?: MarketplaceSettings;
  pluginPolicy?: PluginPolicySettings;
};
```

这里的字段语义：

```text
blockedPlugins：
  强制禁止安装或启用的 plugin@marketplace。

strictKnownMarketplaces：
  如果存在，只有匹配这个 allowlist 的市场源可以被添加或同步。

blockedMarketplaces：
  blocklist，优先级高于 allowlist。

pluginTrustMessage：
  给插件安装提示追加团队自定义说明。
```

如果你的 Mini 不做企业托管 settings，也可以先把这些放在 user/project settings。

但语义上它们是策略。

后续引入 managed settings 时，可以把它们移动到更高优先级来源。

## 依赖解析器

新增 `src/plugins/dependencyResolver.ts`。

这个模块必须是纯函数。

它不读 settings。

它不读 marketplace。

它只通过 caller 传入的 `lookup` 查询依赖。

```ts
import { parsePluginId } from "./pluginId";

export type DependencyLookupResult = {
  dependencies?: string[];
};

export type ResolutionResult =
  | {
      ok: true;
      closure: string[];
    }
  | {
      ok: false;
      reason: "cycle";
      chain: string[];
    }
  | {
      ok: false;
      reason: "not-found";
      missing: string;
      requiredBy: string;
    }
  | {
      ok: false;
      reason: "cross-marketplace";
      dependency: string;
      requiredBy: string;
    };

export function qualifyDependency(dep: string, declaringPluginId: string): string {
  if (parsePluginId(dep).marketplaceName) {
    return dep;
  }

  const marketplaceName = parsePluginId(declaringPluginId).marketplaceName;

  if (!marketplaceName) {
    return dep;
  }

  return `${dep}@${marketplaceName}`;
}

export async function resolveDependencyClosure(params: {
  rootId: string;
  lookup: (pluginId: string) => Promise<DependencyLookupResult | null>;
  alreadyEnabled: ReadonlySet<string>;
  allowedCrossMarketplaces?: ReadonlySet<string>;
}): Promise<ResolutionResult> {
  const rootMarketplace = parsePluginId(params.rootId).marketplaceName;
  const allowedCrossMarketplaces = params.allowedCrossMarketplaces ?? new Set<string>();
  const closure: string[] = [];
  const visited = new Set<string>();
  const stack: string[] = [];

  async function walk(pluginId: string, requiredBy: string): Promise<ResolutionResult | null> {
    if (pluginId !== params.rootId && params.alreadyEnabled.has(pluginId)) {
      return null;
    }

    const marketplaceName = parsePluginId(pluginId).marketplaceName;

    if (
      marketplaceName !== rootMarketplace &&
      !(marketplaceName && allowedCrossMarketplaces.has(marketplaceName))
    ) {
      return {
        ok: false,
        reason: "cross-marketplace",
        dependency: pluginId,
        requiredBy,
      };
    }

    if (stack.includes(pluginId)) {
      return {
        ok: false,
        reason: "cycle",
        chain: [...stack, pluginId],
      };
    }

    if (visited.has(pluginId)) {
      return null;
    }

    visited.add(pluginId);

    const entry = await params.lookup(pluginId);
    if (!entry) {
      return {
        ok: false,
        reason: "not-found",
        missing: pluginId,
        requiredBy,
      };
    }

    stack.push(pluginId);

    for (const rawDep of entry.dependencies ?? []) {
      const dep = qualifyDependency(rawDep, pluginId);
      const error = await walk(dep, pluginId);
      if (error) return error;
    }

    stack.pop();
    closure.push(pluginId);
    return null;
  }

  const error = await walk(params.rootId, params.rootId);
  if (error) return error;

  return {
    ok: true,
    closure,
  };
}
```

闭包返回顺序是依赖优先：

```text
review-pack@team
deploy-pack@team
```

这样安装模块可以先缓存依赖，再缓存根插件。

## 为什么已经启用的依赖要跳过

`alreadyEnabled` 的作用很重要。

假设用户已经手动启用：

```text
secret-scan@security
```

然后安装：

```text
deploy-pack@team
```

如果 `deploy-pack@team` 依赖 `secret-scan@security`，依赖解析器会发现这个依赖已经启用，就不会把它加入闭包。

这样不会发生：

```text
用户原本在 local scope 启用了 security 插件
安装 team 插件时又把它写进 project scope
```

这就是“依赖是存在保证，而不是设置接管”。

## 安装时接入依赖闭包

第三十八章的 `installPluginFromMarketplace` 只安装一个插件。

本章改成安装闭包。

新增 `src/plugins/pluginInstallWithDependencies.ts`：

```ts
import { findMarketplacePlugin, getMarketplace } from "./marketplaceManager";
import { cacheMarketplacePlugin } from "./pluginCache";
import { upsertPluginInstallation } from "./pluginInstallStoreV2";
import { createPluginId, parsePluginId, requireFullPluginId } from "./pluginId";
import { resolveDependencyClosure } from "./dependencyResolver";
import { isPluginBlockedByPolicy } from "./pluginPolicy";
import { setPluginEnabled } from "./pluginSettings";
import { getEnabledPluginIdsForScope } from "./pluginSettings";
import { getCwd } from "../runtime/cwd";
import type { PluginScope } from "./pluginTypes";

export async function installPluginWithDependencies(pluginId: string, scope: PluginScope): Promise<{
  rootId: string;
  installed: Array<{ pluginId: string; version: string; installPath: string }>;
}> {
  const root = requireFullPluginId(pluginId);
  const rootId = createPluginId(root.pluginName, root.marketplaceName);

  if (await isPluginBlockedByPolicy(rootId)) {
    throw new Error(`Plugin is blocked by policy: ${rootId}`);
  }

  const rootMarketplace = await getMarketplace(root.marketplaceName);
  if (!rootMarketplace) {
    throw new Error(`Marketplace is not materialized: ${root.marketplaceName}`);
  }

  const allowedCrossMarketplaces = new Set(rootMarketplace.allowCrossMarketplaceDependenciesOn ?? []);
  const alreadyEnabled = await getEnabledPluginIdsForScope(scope);

  const resolution = await resolveDependencyClosure({
    rootId,
    alreadyEnabled,
    allowedCrossMarketplaces,
    lookup: async id => {
      const info = await findMarketplacePlugin(id);
      return info?.entry ?? null;
    },
  });

  if (!resolution.ok) {
    throw new Error(formatResolutionError(resolution));
  }

  for (const id of resolution.closure) {
    if (await isPluginBlockedByPolicy(id)) {
      throw new Error(`Dependency is blocked by policy: ${id}`);
    }
  }

  const installed: Array<{ pluginId: string; version: string; installPath: string }> = [];
  const now = new Date().toISOString();
  const projectPath = scope === "project" || scope === "local" ? getCwd() : undefined;

  for (const id of resolution.closure) {
    const parsed = parsePluginId(id);
    if (!parsed.marketplaceName) {
      throw new Error(`Dependency must include marketplace after qualification: ${id}`);
    }

    const info = await findMarketplacePlugin(id);
    if (!info) {
      throw new Error(`Plugin disappeared during install: ${id}`);
    }

    const cached = await cacheMarketplacePlugin({
      pluginId: id,
      marketplaceInstallLocation: info.installLocation,
      entry: info.entry,
    });

    await upsertPluginInstallation(id, {
      scope,
      projectPath,
      version: cached.version,
      installPath: cached.installPath,
      installedAt: now,
      lastUpdated: now,
    });

    await setPluginEnabled(id, true, scope);

    installed.push({
      pluginId: id,
      version: cached.version,
      installPath: cached.installPath,
    });
  }

  return {
    rootId,
    installed,
  };
}
```

`formatResolutionError`：

```ts
import type { ResolutionResult } from "./dependencyResolver";

export function formatResolutionError(result: Exclude<ResolutionResult, { ok: true }>): string {
  if (result.reason === "cycle") {
    return `Dependency cycle: ${result.chain.join(" -> ")}`;
  }

  if (result.reason === "not-found") {
    return `Dependency ${result.missing} required by ${result.requiredBy} was not found`;
  }

  return `Cross-marketplace dependency is blocked: ${result.dependency} required by ${result.requiredBy}`;
}
```

安装结果可以展示：

```text
Installed deploy-pack@team (+ 1 dependency)
```

不要把所有依赖路径打印出来。

路径可能包含用户本机目录。

## Load-time Demote

安装时满足依赖，不代表运行时永远满足。

用户可能后来执行：

```bash
bun run src/cli.ts plugin disable review-pack@team --scope project
```

这时 `deploy-pack@team` 的依赖已经不满足。

所以 loader 需要在每次加载后再校验。

新增到 `src/plugins/dependencyResolver.ts`：

```ts
import type { LoadedPlugin, PluginLoadError } from "./pluginTypes";

export function verifyAndDemote(plugins: LoadedPlugin[]): {
  demoted: Set<string>;
  errors: PluginLoadError[];
} {
  const known = new Set(plugins.map(plugin => plugin.id));
  const enabled = new Set(plugins.filter(plugin => plugin.enabled).map(plugin => plugin.id));
  const errors: PluginLoadError[] = [];

  let changed = true;

  while (changed) {
    changed = false;

    for (const plugin of plugins) {
      if (!enabled.has(plugin.id)) {
        continue;
      }

      for (const rawDep of plugin.manifest.dependencies ?? []) {
        const dep = qualifyDependency(rawDep, plugin.id);

        if (enabled.has(dep)) {
          continue;
        }

        enabled.delete(plugin.id);
        changed = true;

        errors.push({
          pluginName: plugin.name,
          path: plugin.rootPath,
          message: known.has(dep)
            ? `Dependency is disabled: ${dep}`
            : `Dependency is not installed: ${dep}`,
        });

        break;
      }
    }
  }

  return {
    demoted: new Set(plugins.filter(plugin => plugin.enabled && !enabled.has(plugin.id)).map(plugin => plugin.id)),
    errors,
  };
}
```

然后在 `pluginLoader.ts` 里：

```ts
const result = await loadInstalledPlugins(settings);
const dependencyCheck = verifyAndDemote(result.plugins);

for (const plugin of result.plugins) {
  if (dependencyCheck.demoted.has(plugin.id)) {
    plugin.enabled = false;
  }
}

result.errors.push(...dependencyCheck.errors);
```

这个 demote 是会话内的。

不要写回 settings。

原因是用户配置表达的是意图：

```text
deploy-pack@team = true
```

loader 发现当前本机依赖不满足，只能在当前会话禁用它，并告诉用户修复。

不要替用户删除配置。

## 反向依赖提示

禁用或卸载插件前，要提示它被哪些插件依赖。

新增：

```ts
export function findReverseDependents(pluginId: string, plugins: LoadedPlugin[]): string[] {
  const dependents: string[] = [];

  for (const plugin of plugins) {
    if (!plugin.enabled || plugin.id === pluginId) {
      continue;
    }

    const dependsOnTarget = (plugin.manifest.dependencies ?? []).some(rawDep => {
      return qualifyDependency(rawDep, plugin.id) === pluginId;
    });

    if (dependsOnTarget) {
      dependents.push(plugin.id);
    }
  }

  return dependents;
}
```

在 `disablePluginCommand` 中：

```ts
const capabilities = await loadPluginCapabilities(await loadEffectiveSettings());
const reverseDependents = findReverseDependents(pluginId, capabilities.plugins);

if (reverseDependents.length > 0) {
  console.log(`Warning: ${pluginId} is required by ${reverseDependents.join(", ")}`);
}
```

第一版只 warning，不阻止。

原因是阻止会让用户很难拆掉坏的依赖图。

真正的运行时保护由 `verifyAndDemote` 完成。

禁用依赖后，依赖它的插件会在 reload 后被降级。

## Marketplace Policy

供应链策略里，最早执行的是市场来源策略。

它必须发生在下载、读取、克隆之前。

新增 `src/plugins/marketplacePolicy.ts`：

```ts
import type { MarketplaceSource } from "./marketplaceTypes";

export type MarketplacePolicySettings = {
  strictKnownMarketplaces?: MarketplaceSource[];
  blockedMarketplaces?: MarketplaceSource[];
};

export function isMarketplaceSourceAllowed(
  source: MarketplaceSource,
  policy: MarketplacePolicySettings | undefined,
): boolean {
  if (policy?.blockedMarketplaces?.some(blocked => areSourcesEquivalent(source, blocked))) {
    return false;
  }

  if (!policy?.strictKnownMarketplaces || policy.strictKnownMarketplaces.length === 0) {
    return true;
  }

  return policy.strictKnownMarketplaces.some(allowed => areSourcesEquivalent(source, allowed));
}

export function areSourcesEquivalent(a: MarketplaceSource, b: MarketplaceSource): boolean {
  if (a.type !== b.type) return false;

  if (a.type === "directory" && b.type === "directory") {
    return a.path === b.path;
  }

  if (a.type === "file" && b.type === "file") {
    return a.path === b.path;
  }

  if (a.type === "url" && b.type === "url") {
    return a.url === b.url;
  }

  if (a.type === "settings" && b.type === "settings") {
    return a.name === b.name;
  }

  return false;
}
```

在 `addMarketplaceSource` 最开始接入：

```ts
const settings = await loadEffectiveSettings();

if (!isMarketplaceSourceAllowed(source, settings.pluginPolicy)) {
  throw new Error(`Marketplace source is blocked by policy: ${formatMarketplaceSource(source)}`);
}
```

注意顺序：

```text
policy check
  -> fetch/read marketplace
  -> validate manifest
  -> write known_marketplaces.json
```

不要先下载，再判断是否允许。

## Host / Path Pattern

真实工程支持 host pattern 和 path pattern。

Mini 第一版可以先不做，但文档里建议保留扩展点。

可以把 `MarketplaceSource` 增加两个策略专用类型：

```ts
export type MarketplacePolicySource =
  | MarketplaceSource
  | {
      type: "hostPattern";
      pattern: string;
    }
  | {
      type: "pathPattern";
      pattern: string;
    };
```

匹配规则：

```text
hostPattern：
  只匹配 url 类来源的 hostname。

pathPattern：
  只匹配 file/directory 的 path。
```

示例策略：

```json
{
  "pluginPolicy": {
    "strictKnownMarketplaces": [
      {
        "type": "hostPattern",
        "pattern": "^plugins\\.company\\.internal$"
      },
      {
        "type": "pathPattern",
        "pattern": "^/opt/company/mini-marketplaces/"
      }
    ]
  }
}
```

本章如果实现 pattern，要注意：

```text
正则语法错误不能默认放行。
```

错误正则应该视为不匹配，并记录 warning。

## Plugin Policy

市场源允许，不代表所有插件都允许。

新增 `src/plugins/pluginPolicy.ts`：

```ts
import type { MiniSettings } from "../config/configTypes";

export function isPluginBlockedByPolicy(pluginId: string, settings: MiniSettings): boolean {
  return settings.pluginPolicy?.blockedPlugins?.[pluginId] === true;
}

export function assertPluginAllowed(pluginId: string, settings: MiniSettings): void {
  if (isPluginBlockedByPolicy(pluginId, settings)) {
    throw new Error(`Plugin is blocked by policy: ${pluginId}`);
  }
}
```

在两个入口必须使用：

```text
installPluginWithDependencies
enablePluginCommand
```

也就是：

```ts
assertPluginAllowed(pluginId, settings);
```

安装根插件时要检查。

安装依赖闭包时也要检查。

否则非阻断插件可以把被阻断插件作为依赖拉进来。

## 保留市场名和防冒充

供应链策略还需要防止命名冒充。

Mini 第一版可以保留：

```text
official
mini-official
mini-plugins
builtin
inline
```

新增：

```ts
const RESERVED_MARKETPLACE_NAMES = new Set([
  "official",
  "mini-official",
  "mini-plugins",
  "builtin",
  "inline",
]);

export function validateMarketplaceName(name: string, source: MarketplaceSource): void {
  if (!RESERVED_MARKETPLACE_NAMES.has(name)) {
    return;
  }

  if (source.type === "url" && new URL(source.url).hostname === "plugins.company.internal") {
    return;
  }

  throw new Error(`Marketplace name is reserved: ${name}`);
}
```

真实工程里会校验官方 GitHub 组织。

Mini 不需要假装自己有官方源。

但要建立这个边界：

```text
保留名只能来自明确允许的源。
```

否则第三方市场可以命名成：

```text
mini-official
```

诱导用户信任。

## 下架插件检测

市场里删除一个插件后，本机缓存可能还在。

这不一定代表恶意。

可能只是团队弃用了插件。

但如果市场明确声明：

```json
{
  "name": "team",
  "forceRemoveDeletedPlugins": true,
  "plugins": []
}
```

Mini 可以自动处理从市场下架的插件。

新增 `src/plugins/pluginDelisting.ts`：

```ts
import type { InstalledPluginsFileV2 } from "./pluginInstallStoreV2";
import type { MarketplaceManifest } from "./marketplaceTypes";

export function detectDelistedPlugins(
  installed: InstalledPluginsFileV2,
  marketplace: MarketplaceManifest,
): string[] {
  const pluginNames = new Set(marketplace.plugins.map(plugin => plugin.name));
  const suffix = `@${marketplace.name}`;
  const delisted: string[] = [];

  for (const pluginId of Object.keys(installed.plugins)) {
    if (!pluginId.endsWith(suffix)) {
      continue;
    }

    const pluginName = pluginId.slice(0, -suffix.length);

    if (!pluginNames.has(pluginName)) {
      delisted.push(pluginId);
    }
  }

  return delisted;
}
```

自动卸载时只处理用户可控 scope：

```text
user
project
local
```

不要删除 managed scope。

managed scope 应该由管理员管理。

同时要写入 flagged 记录：

```json
{
  "plugins": {
    "old-pack@team": {
      "flaggedAt": "2026-05-26T10:00:00.000Z",
      "reason": "delisted"
    }
  }
}
```

这不是为了阻断运行。

这是为了可见性：

```text
这个插件不是用户手动卸载的，而是因为市场下架策略被清理。
```

## 审计日志

插件安装、更新、禁用、策略阻断都应该写入审计日志。

新增 `src/plugins/pluginAudit.ts`：

```ts
import { mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getPluginHome } from "./marketplacePaths";

export type PluginAuditEvent = {
  type:
    | "marketplace_added"
    | "marketplace_blocked"
    | "plugin_install_started"
    | "plugin_installed"
    | "plugin_install_blocked"
    | "plugin_updated"
    | "plugin_disabled"
    | "plugin_demoted"
    | "plugin_delisted";
  pluginId?: string;
  marketplace?: string;
  scope?: string;
  reason?: string;
  dependencyClosure?: string[];
  timestamp?: string;
};

export async function writePluginAuditEvent(event: PluginAuditEvent): Promise<void> {
  const file = join(getPluginHome(), "audit.log");
  await mkdir(dirname(file), { recursive: true });

  const safeEvent = {
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString(),
  };

  await appendFile(file, `${JSON.stringify(safeEvent)}\n`, "utf8");
}
```

审计日志里不要写：

```text
headers
tokens
完整环境变量
用户输入的 secret
```

可以写：

```text
pluginId
marketplace
scope
reason
dependencyClosure
```

因为这些是供应链决策所需的最小信息。

在安装闭包开始前：

```ts
await writePluginAuditEvent({
  type: "plugin_install_started",
  pluginId: rootId,
  scope,
});
```

策略阻断时：

```ts
await writePluginAuditEvent({
  type: "plugin_install_blocked",
  pluginId,
  scope,
  reason: "blocked_by_policy",
});
```

安装成功后：

```ts
await writePluginAuditEvent({
  type: "plugin_installed",
  pluginId: rootId,
  scope,
  dependencyClosure: resolution.closure,
});
```

## CLI 行为

安装命令现在要展示依赖数量：

```ts
export async function installPluginCommand(pluginId: string, options: { scope?: string }): Promise<void> {
  const scope = parseScope(options.scope);
  const result = await installPluginWithDependencies(pluginId, scope);
  const dependencyCount = result.installed.length - 1;

  if (dependencyCount > 0) {
    console.log(`Installed ${result.rootId} (+ ${dependencyCount} dependencies)`);
  } else {
    console.log(`Installed ${result.rootId}`);
  }

  console.log("Run plugin reload to activate in the current session");
}
```

策略命令可以提供一个最小 doctor：

```bash
bun run src/cli.ts plugin doctor
```

输出：

```text
Enabled plugins:
  deploy-pack@team
  review-pack@team

Dependency issues:
  none

Policy issues:
  none
```

第一版 `doctor` 可以只调用：

```ts
loadPluginCapabilities(settings)
```

然后打印其中的 dependency errors。

## 测试：依赖规范化

`src/plugins/__tests__/dependencyResolver.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { qualifyDependency } from "../dependencyResolver";

describe("qualifyDependency", () => {
  test("qualifies bare dependency with declaring marketplace", () => {
    expect(qualifyDependency("review-pack", "deploy-pack@team")).toBe("review-pack@team");
  });

  test("keeps qualified dependency unchanged", () => {
    expect(qualifyDependency("scan@security", "deploy-pack@team")).toBe("scan@security");
  });
});
```

## 测试：依赖闭包

```ts
import { describe, expect, test } from "bun:test";
import { resolveDependencyClosure } from "../dependencyResolver";

describe("resolveDependencyClosure", () => {
  test("returns dependencies before root", async () => {
    const result = await resolveDependencyClosure({
      rootId: "deploy-pack@team",
      alreadyEnabled: new Set(),
      lookup: async id => {
        if (id === "deploy-pack@team") return { dependencies: ["review-pack"] };
        if (id === "review-pack@team") return { dependencies: [] };
        return null;
      },
    });

    expect(result).toEqual({
      ok: true,
      closure: ["review-pack@team", "deploy-pack@team"],
    });
  });

  test("detects dependency cycles", async () => {
    const result = await resolveDependencyClosure({
      rootId: "a@team",
      alreadyEnabled: new Set(),
      lookup: async id => {
        if (id === "a@team") return { dependencies: ["b"] };
        if (id === "b@team") return { dependencies: ["a"] };
        return null;
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("cycle");
    }
  });
});
```

## 测试：跨市场依赖默认阻断

```ts
import { describe, expect, test } from "bun:test";
import { resolveDependencyClosure } from "../dependencyResolver";

describe("cross-marketplace dependencies", () => {
  test("blocks cross-marketplace dependency by default", async () => {
    const result = await resolveDependencyClosure({
      rootId: "deploy-pack@team",
      alreadyEnabled: new Set(),
      lookup: async id => {
        if (id === "deploy-pack@team") return { dependencies: ["scan@security"] };
        if (id === "scan@security") return { dependencies: [] };
        return null;
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("cross-marketplace");
    }
  });

  test("allows cross-marketplace dependency when root marketplace allows it", async () => {
    const result = await resolveDependencyClosure({
      rootId: "deploy-pack@team",
      alreadyEnabled: new Set(),
      allowedCrossMarketplaces: new Set(["security"]),
      lookup: async id => {
        if (id === "deploy-pack@team") return { dependencies: ["scan@security"] };
        if (id === "scan@security") return { dependencies: [] };
        return null;
      },
    });

    expect(result).toEqual({
      ok: true,
      closure: ["scan@security", "deploy-pack@team"],
    });
  });
});
```

## 测试：运行时 Demote

```ts
import { describe, expect, test } from "bun:test";
import { verifyAndDemote } from "../dependencyResolver";
import type { LoadedPlugin } from "../pluginTypes";

function plugin(id: string, enabled: boolean, dependencies: string[] = []): LoadedPlugin {
  const [name] = id.split("@");

  return {
    id,
    name: name!,
    version: "0.1.0",
    rootPath: "/tmp/plugin",
    manifestPath: "/tmp/plugin/.mini-plugin/plugin.json",
    enabled,
    manifest: {
      name: name!,
      version: "0.1.0",
      dependencies,
    },
    components: {},
  };
}

describe("verifyAndDemote", () => {
  test("demotes plugin when dependency is disabled", () => {
    const result = verifyAndDemote([
      plugin("review-pack@team", false),
      plugin("deploy-pack@team", true, ["review-pack"]),
    ]);

    expect(result.demoted.has("deploy-pack@team")).toBe(true);
  });
});
```

## 测试：策略阻断

```ts
import { describe, expect, test } from "bun:test";
import { isMarketplaceSourceAllowed } from "../marketplacePolicy";

describe("isMarketplaceSourceAllowed", () => {
  test("blocklist wins over allowlist", () => {
    const source = {
      type: "url" as const,
      url: "https://plugins.example.com/marketplace.json",
    };

    expect(
      isMarketplaceSourceAllowed(source, {
        strictKnownMarketplaces: [source],
        blockedMarketplaces: [source],
      }),
    ).toBe(false);
  });

  test("allows source when no policy exists", () => {
    expect(
      isMarketplaceSourceAllowed(
        {
          type: "directory",
          path: "/repo/marketplace",
        },
        undefined,
      ),
    ).toBe(true);
  });
});
```

## 测试：下架检测

```ts
import { describe, expect, test } from "bun:test";
import { detectDelistedPlugins } from "../pluginDelisting";

describe("detectDelistedPlugins", () => {
  test("detects installed plugin missing from marketplace", () => {
    const delisted = detectDelistedPlugins(
      {
        version: 2,
        plugins: {
          "old-pack@team": [
            {
              scope: "project",
              version: "0.1.0",
              installPath: "/tmp/old",
              installedAt: "2026-05-26T10:00:00.000Z",
              lastUpdated: "2026-05-26T10:00:00.000Z",
            },
          ],
        },
      },
      {
        name: "team",
        owner: {
          name: "Frontend Platform",
        },
        plugins: [],
      },
    );

    expect(delisted).toEqual(["old-pack@team"]);
  });
});
```

## 手动验收

准备两个插件：

```text
examples/marketplaces/team/plugins/review-pack
examples/marketplaces/team/plugins/deploy-pack
```

`deploy-pack` 的 manifest：

```json
{
  "name": "deploy-pack",
  "version": "0.1.0",
  "dependencies": ["review-pack"],
  "commands": "./commands"
}
```

运行：

```bash
bun run src/cli.ts plugin marketplace add team examples/marketplaces/team --scope project
bun run src/cli.ts plugin install deploy-pack@team --scope project
bun run src/cli.ts plugin list
```

期望看到：

```text
review-pack@team enabled
deploy-pack@team enabled
```

再禁用依赖：

```bash
bun run src/cli.ts plugin disable review-pack@team --scope project
bun run src/cli.ts plugin reload
bun run src/cli.ts plugin doctor
```

期望看到：

```text
deploy-pack@team demoted because dependency review-pack@team is disabled
```

测试跨市场阻断：

```json
{
  "name": "deploy-pack",
  "version": "0.1.0",
  "dependencies": ["scan@security"],
  "commands": "./commands"
}
```

运行安装：

```bash
bun run src/cli.ts plugin install deploy-pack@team --scope project
```

期望失败：

```text
Cross-marketplace dependency is blocked
```

然后在 `team` marketplace 增加：

```json
{
  "allowCrossMarketplaceDependenciesOn": ["security"]
}
```

重新运行：

```bash
bun run src/cli.ts plugin marketplace update team
bun run src/cli.ts plugin install deploy-pack@team --scope project
```

如果 `security` 市场已声明且已物化，安装应该成功。

## 常见坑

第一，把依赖解析写进安装函数里。

依赖解析应该是纯函数。

这样才能单测循环、缺失、跨市场阻断这些边界。

第二，跨市场依赖默认允许。

这是供应链风险。

安装一个可信市场的插件，不应该自动拉另一个未知市场的插件。

第三，使用依赖市场自己的 allowlist。

只看根市场。

用户安装的是根插件，信任边界也来自根市场。

第四，安装时检查策略，但启用时不检查。

用户可能先安装，再被策略阻断。

启用也必须检查。

第五，运行时不做 demote。

用户禁用依赖后，依赖它的插件不能继续运行。

第六，禁用依赖时直接阻止。

阻止会让用户无法拆坏依赖图。

更实用的做法是 warning + reload 后 demote。

第七，策略阻断后没有审计日志。

供应链问题排查时，需要知道是谁、什么时候、因为哪个策略被阻断。

第八，下架插件直接静默删除。

用户需要看到它是被市场策略移除，而不是自己误操作。

## 小结

本章给 Mini 增加了插件依赖和供应链策略。

现在 Mini 支持：

- `dependencies` 字段。
- bare dependency 自动继承声明插件的 marketplace。
- install-time 依赖闭包。
- 循环依赖检测。
- 缺失依赖错误。
- 跨市场依赖默认阻断。
- 根市场跨市场依赖 allowlist。
- 插件策略阻断。
- 市场来源 allowlist/blocklist。
- load-time dependency demote。
- 反向依赖提示。
- 下架插件检测。
- 插件供应链审计日志。

到这里，Mini 的插件系统已经具备团队使用的基本安全边界。

下一章可以继续做 **插件签名与完整性校验**：给 marketplace manifest、插件包、版本缓存增加 hash、签名、锁文件和离线校验能力。
