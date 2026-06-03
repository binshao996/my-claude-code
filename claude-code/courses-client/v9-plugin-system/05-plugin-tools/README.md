# 05 - Plugin Tools

## 当前章节目标

本章实现插件工具注入。

Runtime 已有 `PluginTool`：

```ts
export type PluginTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  run(input: unknown, context: { cwd: string }): Promise<string>;
};
```

`createDefaultToolRegistry()` 已经把 plugin tool 桥接到 Mini Tool。

## 工具注入流程

```text
PluginRegistry.reload()
  -> getTools()
  -> createDefaultToolRegistry({ pluginTools })
  -> ToolRunner
  -> Sandbox / Permission
```

## Plugin Tool Fake Runtime Event

本章必须提供 fake runtime event，证明插件工具仍走 Runtime ToolRunner、Sandbox、Permission：

```ts
export type PluginToolRuntimeEvent =
  | {
      type: "tool_use_requested";
      toolName: "workspace-helper.readWorkspaceNote";
      input: { path: string };
      permission: "pending";
    }
  | {
      type: "tool_permission_decided";
      toolName: "workspace-helper.readWorkspaceNote";
      decision: "allowed" | "denied";
      reason?: string;
    }
  | {
      type: "tool_use_completed";
      toolName: "workspace-helper.readWorkspaceNote";
      status: "success" | "error";
      outputPreview: string;
    };

export const fakePluginToolEvents: PluginToolRuntimeEvent[] = [
  {
    type: "tool_use_requested",
    toolName: "workspace-helper.readWorkspaceNote",
    input: { path: "notes/session.md" },
    permission: "pending",
  },
  {
    type: "tool_permission_decided",
    toolName: "workspace-helper.readWorkspaceNote",
    decision: "allowed",
  },
  {
    type: "tool_use_completed",
    toolName: "workspace-helper.readWorkspaceNote",
    status: "success",
    outputPreview: "Session timeline notes...",
  },
];
```

## Client 侧展示

```tsx
export function PluginToolList({
  tools,
  events,
}: {
  tools: PluginTool[];
  events: PluginToolRuntimeEvent[];
}) {
  return (
    <section>
      <h2>Plugin Tools</h2>
      {tools.map(tool => (
        <article key={tool.name}>
          <strong>{tool.name}</strong>
          <p>{tool.description}</p>
        </article>
      ))}
      {events.map((event, index) => (
        <PluginToolEventRow key={index} event={event} />
      ))}
    </section>
  );
}
```

```tsx
export function PluginToolEventRow({
  event,
}: {
  event: PluginToolRuntimeEvent;
}) {
  if (event.type === "tool_use_requested") {
    return <p>{event.toolName} waiting for permission</p>;
  }

  if (event.type === "tool_permission_decided") {
    return <p>{event.toolName} permission {event.decision}</p>;
  }

  return <p>{event.toolName} {event.status}: {event.outputPreview}</p>;
}
```

## 安全边界

插件工具不应该拿到裸 Node API。

教学版 Runtime 当前给插件工具：

```ts
{ cwd: ctx.cwd }
```

生产实现应提供 scoped context：

```ts
export type PluginToolContext = {
  workspace: {
    cwd: string;
    readFile(path: string): Promise<string>;
  };
  permissions: {
    request(reason: string): Promise<boolean>;
  };
};
```

## 本章交付

本章交付插件工具注入 Runtime Tool Registry。

治理边界：

- plugin tool name 使用 `pluginId.toolName`。
- input schema 必须被 Runtime 校验。
- tool run context 只能是 scoped context。
- 每次 tool_use 仍产生 permission decision 和 audit event。
- disabled 或 policy denied 的插件工具不能注入。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

启用一个带 tool 的插件后验证：

- Plugin Tool List 显示工具名、描述和权限级别。
- Runtime Tool Registry 中能看到 `pluginId.toolName`。
- fake runtime event 在 Agent Workspace 显示 `workspace-helper.readWorkspaceNote waiting for permission`。
- 调用工具前出现正常 permission 流程。
- 禁用插件后工具从 Tool Registry 移除。
- 插件工具拿不到裸 `fs`、`shell`、`SessionStore`。

## 当前章节缺陷

V9 教学版不实现插件工具签名和供应链安全。

## 下一章预告

下一章会实现 Plugin Panels & Lifecycle：把插件扩展到 UI，但只提供 scoped API。
