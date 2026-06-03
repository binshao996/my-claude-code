# 01 - Plugin 边界

## 当前章节目标

本章定义插件系统的边界。

结论：

```text
插件可以扩展产品能力，但不能绕过 Runtime、Workspace 和 Permission 边界。
```

## 插件可以扩展什么

- Commands。
- Tools。
- Context snippets。
- UI panels。
- Settings。

## 插件不能做什么

- 直接访问任意文件系统路径。
- 直接执行 shell。
- 直接修改 PermissionStore。
- 直接写 Editor buffer。
- 静默注入大量 prompt。
- 绕过 Workspace scope。

## Runtime 对照

当前 Mini 插件已经支持：

```ts
export type PluginManifest = {
  name: string;
  version?: string;
  description?: string;
  commands?: Record<string, PluginCommandManifest>;
  tools?: Record<string, PluginToolManifest>;
  context?: string[];
};
```

V9 在这个基础上新增 Client UI extension point。

## 本章交付

本章交付插件能力边界，不加载真实插件。

要在 Plugin Manager 或 diagnostics 中展示一张边界表：

| 能力 | 允许方式 | 禁止方式 |
| --- | --- | --- |
| command | 生成 prompt，经 Runtime 发送 | 直接执行 shell |
| tool | 注入 Runtime ToolRegistry | 绕过 ToolRunner |
| context | 带 token budget 注入 | 静默无限注入 |
| panel | scoped API | 裸 `fs` / `shell` / `SessionStore` |

## Feature PR Skeleton

本章用 fake boundary policy event 驱动 Plugin Manager 的边界表：

```ts
export type PluginBoundaryCapability =
  | "command"
  | "tool"
  | "context"
  | "panel"
  | "settings";

export type PluginBoundaryRow = {
  capability: PluginBoundaryCapability;
  allowedPath: string;
  deniedPath: string;
};

export const pluginBoundaryRows: PluginBoundaryRow[] = [
  {
    capability: "command",
    allowedPath: "getPrompt(args) -> Runtime",
    deniedPath: "direct shell execution",
  },
  {
    capability: "tool",
    allowedPath: "ToolRegistry -> ToolRunner -> Permission",
    deniedPath: "bypass ToolRunner",
  },
  {
    capability: "panel",
    allowedPath: "PluginPanelApi",
    deniedPath: "raw fs / shell / SessionStore",
  },
];

export const fakeBoundaryViolationEvent = {
  type: "plugin_boundary_denied",
  pluginId: "workspace-helper",
  capability: "panel",
  reason: "Panel requested raw fs access.",
} as const;
```

```tsx
export function PluginBoundaryTable({ rows }: { rows: PluginBoundaryRow[] }) {
  return (
    <section className="plugin-boundary">
      <h2>Plugin Boundary</h2>
      {rows.map(row => (
        <article key={row.capability}>
          <strong>{row.capability}</strong>
          <p>Allowed: {row.allowedPath}</p>
          <p>Denied: {row.deniedPath}</p>
        </article>
      ))}
    </section>
  );
}
```

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

打开 Plugin Manager 后应该看到：

- 插件可扩展 commands、tools、context、panels、settings。
- 每个能力旁边有治理边界说明。
- fake violation 显示 `Panel requested raw fs access.`，但不阻塞 Plugin Manager 打开。
- 任何插件能力都指向 Runtime / Workspace / Permission 的受控入口。
- 章节不要求 registry reload，但不能出现“插件直接执行系统命令”的路径。

## 当前章节缺陷

本章只定义边界，不实现 manifest。

## 下一章预告

下一章会实现 Manifest 模型：commands、tools、context、panels。
