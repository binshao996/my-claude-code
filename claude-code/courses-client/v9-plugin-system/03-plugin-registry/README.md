# 03 - Plugin Registry

## 当前章节目标

本章实现 Plugin Registry。

Runtime 里已经有：

```ts
export class PluginRegistry {
  async reload(): Promise<PluginRuntime>;
  getRuntime(): PluginRuntime;
  findCommand(name: string): PluginCommand | undefined;
  getTools(): PluginTool[];
  getContextPrompt(): string | null;
}
```

Client 需要在 UI 中暴露状态。

## PluginState

```ts
export type PluginState = {
  installed: InstalledPluginView[];
  enabledCount: number;
  errors: string[];
  status: "idle" | "loading" | "reloading" | "error";
};
```

## 插件安装来源与状态持久化

Registry 不应该只记“当前启用了几个插件”。生产版还要持久化：

- 插件来源。
- 安装版本。
- 启用状态。
- 上次 reload 错误。
- 企业策略是否强制禁用。

这些状态用于启动恢复、审计和回滚。

## Registry Fixture Loader

本章必须提供 registry fixture loader，确保 reload/enable/disable 不依赖真实安装目录：

```ts
export type RegistryFixtureRecord = {
  manifest: ClientPluginManifest;
  enabled: boolean;
  policyDeniedReason?: string;
  lastError?: string;
};

export type InstalledPluginStatus =
  | "enabled"
  | "disabled"
  | "error"
  | "policy-denied";

export type InstalledPluginView = {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  status: InstalledPluginStatus;
  capabilities: PluginCapabilitySummary;
  deniedReason?: string;
};

export const fakeRegistryFixture: RegistryFixtureRecord[] = [
  {
    manifest: fakeValidPluginManifest,
    enabled: true,
  },
  {
    manifest: {
      ...fakeValidPluginManifest,
      name: "policy-denied-plugin",
      version: "0.1.0",
    },
    enabled: false,
    policyDeniedReason: "Workspace policy denies plugin tools.",
  },
];

export function loadRegistryFixture(
  records: RegistryFixtureRecord[],
): InstalledPluginView[] {
  return records.map(record => ({
    id: record.manifest.name,
    name: record.manifest.name,
    version: record.manifest.version ?? "0.0.0",
    enabled: record.enabled && !record.policyDeniedReason,
    status: record.lastError
      ? "error"
      : record.policyDeniedReason
        ? "policy-denied"
        : record.enabled
          ? "enabled"
          : "disabled",
    capabilities: summarizePluginCapabilities(record.manifest),
    deniedReason: record.policyDeniedReason,
  }));
}
```

## PluginService

```ts
export class PluginService {
  constructor(private readonly registry: PluginRegistry) {}

  async reload(): Promise<PluginRuntime> {
    return this.registry.reload();
  }

  getRuntime(): PluginRuntime {
    return this.registry.getRuntime();
  }
}
```

## 插件冲突与命名空间治理

插件命令和工具必须带 namespace：

```text
pluginId.commandId
pluginId.toolName
```

如果两个插件注册同名 command，Client 应该在 Registry 层报错或要求显式别名，而不是让后加载的插件覆盖先加载的插件。

## PluginManager

```tsx
export function PluginManager({ state, onReload, onToggle }: PluginManagerProps) {
  return (
    <section className="plugin-manager">
      <header>
        <h2>Plugins</h2>
        <button type="button" onClick={onReload}>Reload</button>
      </header>
      <p>{state.enabledCount} enabled</p>
      {state.errors.map(error => <pre key={error}>{error}</pre>)}
      {state.installed.map(plugin => (
        <article key={plugin.id}>
          <strong>{plugin.name}</strong>
          <span>{plugin.status}</span>
          {plugin.deniedReason ? <p>{plugin.deniedReason}</p> : null}
          <button type="button" onClick={() => onToggle(plugin.id)} disabled={plugin.status === "policy-denied"}>
            {plugin.enabled ? "Disable" : "Enable"}
          </button>
        </article>
      ))}
    </section>
  );
}
```

## 本章交付

本章交付 Plugin Registry 的加载、启用、禁用和 reload。

接入链路：

```text
PluginService.reload()
  -> validate manifests
  -> apply enabled state
  -> namespace conflict check
  -> expose commands / tools / panels / context
  -> PluginManager state
```

enable / disable 必须同步影响 command、tool、panel 和 context，不能只改变 UI 开关。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

安装两个测试插件后验证：

- Reload 后 `enabledCount` 正确。
- fake registry fixture 显示 `workspace-helper` 为 enabled，`policy-denied-plugin` 为 policy-denied。
- Disable 某插件后，它的 command、tool、panel、context 同时消失。
- Enable 后这些能力恢复。
- 命名空间冲突显示 registry error，不以后加载覆盖先加载。
- enterprise policy 强制禁用的插件不能被用户重新 enable。

## 当前章节缺陷

本章只做 registry 状态，不接 command palette，也不实现真实安装回滚。

## 下一章预告

下一章会实现 Plugin Commands：把插件命令接入 Command Palette 和 Chat。
