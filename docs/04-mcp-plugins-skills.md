# 04. MCP、Plugins 与 Skills

## MCP 角色

MCP 是 Claude Code 的外部工具和资源接入层。源码中 MCP 不只是“列工具并调用”，还包括：

- 多 transport 连接。
- server config scopes。
- auth/OAuth。
- tools/list 到本地 `Tool` 的适配。
- resources/list/read。
- prompts/instructions。
- tool progress。
- elicitation。
- 权限规则按 MCP server/tool 匹配。
- plugin 注入 MCP server。

关键源码：

- `src/services/mcp/client.ts`
- `src/services/mcp/config.ts`
- `src/services/mcp/auth.ts`
- `src/services/mcp/types.ts`
- `src/services/mcp/MCPConnectionManager.tsx`
- `packages/mcp-client/src/*`

## MCP transport

`src/services/mcp/types.ts` 中支持多种 server 类型：

- `stdio`
- `sse`
- `http` / streamable HTTP
- `ws`
- `sdk`
- `claudeai-proxy`

MCP tool 名称默认规范化为：

```text
mcp__<server>__<tool>
```

即使在 SDK skip-prefix 模式中使用原始工具名，`mcpInfo` 仍保留 server/tool 原名，用于权限、telemetry 和渲染。

## MCP tool 适配为本地 Tool

`services/mcp/client.ts` 会把 MCP `tools/list` 返回的 schema 和 annotations 映射为本地 `Tool`：

- `inputJSONSchema`: 来自 MCP tool schema。
- `mcpInfo`: serverName/toolName。
- `isReadOnly`: 来自 `readOnlyHint`。
- `isConcurrencySafe`: 通常 read-only 可并发。
- `isDestructive`: 来自 `destructiveHint`。
- `isOpenWorld`: 来自 `openWorldHint`。
- `call()`: 最终调用 MCP client 的 `callTool()`，带 timeout、progress、meta。

因此 MCP tool 和内置工具共用同一套 `runTools()`、权限、hooks、结果处理。

## MCP 权限

MCP 权限要处理三层匹配：

- 单个 MCP tool：`mcp__server__tool`
- server 级：`mcp__server`
- wildcard：`mcp__server__*`

相关逻辑在：

- `src/utils/permissions/permissions.ts`
- `src/services/mcp/utils.ts`
- `src/services/mcp/mcpStringUtils.ts`
- `src/services/mcp/normalization.ts`

## Plugins

插件是更高层扩展包，可以提供：

- slash commands
- skills
- hooks
- MCP servers
- plugin options/config
- marketplace metadata

关键源码：

- `src/plugins/builtinPlugins.ts`
- `src/plugins/bundled/*`
- `src/utils/plugins/*`
- `src/services/plugins/*`
- `src/commands/plugin/*`

插件来源包括：

- bundled plugins
- user/project/local plugin dirs
- marketplace install
- managed plugins
- MCPB package

插件 MCP server 可来自：

- 插件 `.mcp.json`
- manifest `mcpServers`
- MCPB 文件

插件 MCP 去重按 command 或 URL signature，手动配置优先于插件配置。

## Skills

Skills 是面向模型的任务能力包，通常是 markdown/frontmatter + 资源文件。来源：

- bundled skills: `src/skills/bundled/*`
- user skills: `.claude/skills`
- plugin skills
- managed skills
- MCP `skill://` resources

关键源码：

- `src/skills/loadSkillsDir.ts`
- `src/skills/bundledSkills.ts`
- `src/skills/mcpSkills.ts`
- `packages/builtin-tools/src/tools/SkillTool/*`
- `packages/builtin-tools/src/tools/DiscoverSkillsTool/*`

frontmatter 支持的信息包括：

- `allowed-tools`
- `when_to_use`
- `model`
- `hooks`
- `context`
- `agent`
- `effort`

## SkillTool

`SkillTool` 让模型显式调用某个 skill。它会合并本地 commands 和 MCP skills，并做来源过滤。调用 skill 后，skill 的说明、上下文、资源会进入模型上下文，模型再用普通工具完成任务。

## Deferred tools

Claude Code 还有“延迟工具发现”机制：

- `SearchExtraTools`: 让模型根据关键词发现额外工具。
- `ExecuteTool`: 调用被发现的 deferred tool。
- `shouldDefer` / `alwaysLoad`: 控制工具是否初始暴露给模型。

这解决了工具数量过多导致 prompt 过大的问题。核心工具直接暴露，长尾工具通过搜索发现。

## Commands 与 Skills 的关系

命令不只有内置命令。`getCommands(cwd)` 会合并：

- built-in commands
- bundled skill commands
- builtin plugin skill commands
- user skill dir commands
- workflow commands
- plugin commands
- plugin skills

所以 commands、plugins、skills 不是三套孤立系统，而是共享“能力注入”机制。

## 重新实现建议

优先级：

1. 先实现 MCP config + stdio client + tools/list/callTool。
2. 将 MCP tool 适配为同一个 `Tool` interface。
3. 支持 MCP server/tool 权限匹配。
4. 实现 skills loader，先支持本地 markdown/frontmatter。
5. 再做 plugin manifest，最后做 marketplace/install/update。
6. deferred tools 可在工具数量增长后补，不必第一阶段实现。
