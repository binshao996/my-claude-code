# 06 - Plugin Panels & Lifecycle

## 当前章节目标

本章实现插件 UI panel 和生命周期。

## Panel Manifest

```ts
export type PluginPanelManifest = {
  title: string;
  entry: string;
  placement: "sidebar" | "agent-workspace" | "bottom-panel";
};
```

## PluginPanelHost

```tsx
export function PluginPanelHost({
  panels,
}: {
  panels: LoadedPluginPanel[];
}) {
  return (
    <section className="plugin-panel-host">
      {panels.map(panel => (
        <PluginPanelFrame key={panel.id} panel={panel} />
      ))}
    </section>
  );
}
```

## Scoped API

插件 panel 只能拿 scoped API：

```ts
export type PluginPanelApi = {
  workspace: {
    id: string;
    displayName: string;
  };
  commands: {
    execute(commandId: string, args: string): Promise<void>;
  };
  ui: {
    notify(message: string): void;
  };
};
```

不要把 `fs`、`shell`、`SessionStore` 直接暴露给 panel。

## Sandbox Panel UI Fixture

本章必须提供 panel sandbox UI，证明 panel 只能拿 scoped API：

```ts
export const fakeLoadedPluginPanel: LoadedPluginPanel = {
  id: "workspace-helper.notes",
  pluginId: "workspace-helper",
  title: "Workspace Notes",
  placement: "sidebar",
  entry: "panel.html",
  enabled: true,
  policyAllowed: true,
};

export const fakePanelApi: PluginPanelApi = {
  workspace: {
    id: "workspace-client",
    displayName: "claude-code-client",
  },
  commands: {
    async execute(commandId, args) {
      await runCommandThroughPalette(commandId, args);
    },
  },
  ui: {
    notify(message) {
      showToast({ source: "plugin", message });
    },
  },
};
```

```tsx
export function PluginPanelSandbox({
  panel,
  api,
}: {
  panel: LoadedPluginPanel;
  api: PluginPanelApi;
}) {
  return (
    <section className="plugin-panel-sandbox" data-panel-id={panel.id}>
      <header>
        <h2>{panel.title}</h2>
        <span>{panel.placement}</span>
      </header>
      <p>Workspace: {api.workspace.displayName}</p>
      <button type="button" onClick={() => api.commands.execute("workspace-helper.summarize", "")}>
        Run summarize
      </button>
      <button type="button" onClick={() => api.ui.notify("Panel action completed")}>
        Notify
      </button>
    </section>
  );
}
```

Panel 访问禁止 API 时要显示本 panel 的错误，不影响产品外壳：

```ts
export const fakePanelDeniedEvent = {
  type: "plugin_panel_api_denied",
  panelId: "workspace-helper.notes",
  requestedApi: "fs.readFile",
  reason: "Panel API only exposes workspace metadata, commands, and ui.",
} as const;
```

## 生命周期

```ts
export type PluginLifecycleEvent =
  | { type: "installed"; pluginName: string }
  | { type: "enabled"; pluginName: string }
  | { type: "disabled"; pluginName: string }
  | { type: "reloaded"; pluginName: string };
```

## 本章交付

本章交付插件面板和生命周期事件。

要求：

- `PluginPanelHost` 只渲染 enabled 且 policy allowed 的 panel。
- panel 只能访问 `PluginPanelApi`。
- enable / disable / reload 都产生 lifecycle event。
- panel crash 时只禁用该 panel，不影响 Product Shell。
- 远程资源加载必须由 policy 控制。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

启用一个带 panel 的插件后验证：

- 指定 placement 出现 panel。
- Sidebar 出现 `Workspace Notes` sandbox panel。
- panel 能调用 scoped `commands.execute` 和 `ui.notify`。
- panel denied event 显示 `Panel API only exposes workspace metadata, commands, and ui.`。
- panel 访问裸 `fs`、`shell`、`SessionStore` 会失败。
- Disable 后 panel 卸载，生命周期日志出现 `disabled`。
- panel 抛错后 Plugin Manager 显示该 panel error，核心 editor/chat/terminal 不受影响。

## 当前章节缺陷

本章只定义 panel 生命周期，不实现 iframe sandbox、远程资源隔离和真实资源回收压力测试。

## 下一章预告

下一章会补齐 Marketplace 与 Supply Chain，让插件从本地扩展升级为可治理生态。

随后 V10 会实现 Enterprise Claude Code Client。

V10 会把前面所有能力收束成完整企业级产品：

```text
Workspace
Editor
Terminal
Agent Workspace
Diff
Session
Plugin
Settings
Policy
Observability
```
