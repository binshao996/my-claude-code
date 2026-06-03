# 04 - Plugin Commands

## 当前章节目标

本章实现插件命令。

Runtime 命令类型：

```ts
export type PluginCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  model?: string;
  getPrompt(args: string): Promise<ChatMessage[]>;
};
```

## Command Palette 集成

```ts
export type CommandPaletteItem = {
  id: string;
  title: string;
  description: string;
  source: "core" | "plugin";
  run(args: string): Promise<void>;
};
```

## Command Palette Entry Fixture

本章必须用 manifest fixture 生成一个真实可见的 palette entry：

```ts
export const fakePluginCommand: PluginCommand = {
  name: "workspace-helper.summarize",
  description: "Summarize the current workspace task",
  argumentHint: "[topic]",
  async getPrompt(args: string) {
    return [
      {
        role: "user",
        content: `Summarize this workspace task: ${args || "current task"}`,
      },
    ];
  },
};
```

```ts
export function pluginCommandToPaletteItem(
  command: PluginCommand,
  runtime: RuntimeClient,
): CommandPaletteItem {
  return {
    id: `plugin:${command.name}`,
    title: command.name,
    description: command.description,
    source: "plugin",
    async run(args) {
      const messages = await command.getPrompt(args);
      for await (const event of runtime.send({
        text: renderPluginCommandMessages(messages),
      })) {
        dispatchRuntimeEvent(event);
      }
    },
  };
}
```

```tsx
export function CommandPalettePluginSection({
  items,
}: {
  items: CommandPaletteItem[];
}) {
  return (
    <section className="command-palette-plugin-section">
      <h2>Plugin Commands</h2>
      {items.map(item => (
        <button key={item.id} type="button" onClick={() => item.run("")}>
          <strong>{item.title}</strong>
          <span>{item.description}</span>
          <small>{item.source}</small>
        </button>
      ))}
    </section>
  );
}
```

## 安全边界

插件命令只生成 prompt，不直接执行工具。

如果命令最终导致工具调用，仍然由 Runtime 决定：

```text
Plugin command
  -> prompt
  -> Runtime
  -> tool_use
  -> ToolRunner / Permission
```

## 本章交付

本章交付插件命令到 Command Palette 的映射。

要求：

- Palette item id 使用 `plugin:<pluginId>.<commandId>`。
- 命令只调用 `getPrompt(args)` 并把结果送入 Runtime。
- Runtime 后续 tool_use 仍走 ToolRunner / Permission。
- disabled plugin 的 command 不出现在 Palette。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

启用一个带 command 的插件后验证：

- Command Palette 出现 `source=plugin` 的命令。
- Palette entry id 是 `plugin:workspace-helper.summarize`。
- 执行 fake command 后 Chat 出现 `Summarize this workspace task`。
- 执行命令后 Chat 中出现插件生成的 prompt。
- Runtime event stream 正常进入 Agent Workspace。
- 禁用插件后命令立即消失。
- 插件命令不能直接触发 shell 或写文件，只能通过 Runtime 产生后续工具调用。

## 当前章节缺陷

本章不做命令快捷键和命令分组。

## 下一章预告

下一章会实现 Plugin Tools：把插件工具注入 Runtime Tool Registry。
