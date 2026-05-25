# Claude Code 源码架构分析文档

本目录基于 `claude-code/` 参考源码重新梳理，不依赖此前已删除的实现。目标是先理解 Claude Code-like agent 的完整能力边界和关键架构，再为后续重新实现提供模块拆分依据。

## 阅读顺序

1. [00-overview.md](./00-overview.md): 总体架构、能力地图、源码模块分层。
2. [01-agent-loop.md](./01-agent-loop.md): 核心 agent loop、状态机、上下文压缩、错误恢复。
3. [02-cli-tui-session.md](./02-cli-tui-session.md): CLI 入口、Ink TUI、会话恢复、命令交互。
4. [03-tools-permissions.md](./03-tools-permissions.md): 工具接口、工具调度、权限系统、hooks。
5. [04-mcp-plugins-skills.md](./04-mcp-plugins-skills.md): MCP、插件、skills、延迟工具发现。
6. [05-context-prompts-memory.md](./05-context-prompts-memory.md): system prompt、项目上下文、CLAUDE.md、记忆和压缩。
7. [06-api-models-observability.md](./06-api-models-observability.md): API/provider、模型、重试、telemetry、quota。
8. [07-remote-background-advanced.md](./07-remote-background-advanced.md): remote、bridge、daemon、后台任务、agent swarm 等高级能力。
9. [08-version-roadmap.md](./08-version-roadmap.md): 1:1 复刻的版本路线图、范围和验收标准。
10. [09-agile-delivery-plan.md](./09-agile-delivery-plan.md): 敏捷推进方式、Sprint 节奏、DoR/DoD 和质量门禁。
11. [10-source-coverage-ledger.md](./10-source-coverage-ledger.md): 源码目录、workspace package、feature flag、tool、command 和偏差的唯一覆盖台账。
12. [11-strict-1to1-parity-roadmap.md](./11-strict-1to1-parity-roadmap.md): 基于 Claude Code 源码差异的新严格 1:1 复刻路线图。
13. [adr/0001-tech-stack.md](./adr/0001-tech-stack.md): V0.1 技术栈 ADR。
14. [backlog.md](./backlog.md): 版本 backlog 初版。
15. [parity-cases.md](./parity-cases.md): 初始 30 个 parity cases。
16. [sprints/v0.1-sprint-planning.md](./sprints/v0.1-sprint-planning.md): V0.1 Sprint planning。

实现教程在仓库根目录 [tech-docs/](../tech-docs/) 下维护，用于按版本从 0 到 1 学习实现。

## 总体结论

Claude Code 不是一个“CLI 包一层 LLM API”的项目。它更接近一个终端里的 agent runtime，核心由以下部分组成：

- 一个可恢复、可流式输出、可多轮工具调用的 agent loop。
- 一个强类型工具系统，包含工具描述、schema、权限、UI 渲染、进度、并发调度、结果持久化。
- 一个复杂的权限体系，支持模式、规则、hooks、自动分类器、MCP/server 级匹配、交互确认。
- 一个完整的 TUI 应用，包含输入编辑、虚拟消息列表、权限弹窗、会话恢复、远程会话展示。
- 一个上下文管理系统，包含 CLAUDE.md、git status、memory attachments、auto compact、microcompact、snip、token budget。
- 一个扩展体系，MCP、plugins、skills、deferred tools、commands 都能注入能力。
- 一个多运行模式体系，支持 interactive、headless、SDK、remote、bridge、daemon、background、SSH、direct connect。

## 源码规模参考

当前参考源码主要在：

- `claude-code/src/`: CLI、TUI、query loop、commands、state、services。
- `claude-code/packages/builtin-tools/`: 内置工具实现。
- `claude-code/packages/mcp-client/`: MCP client 基础包。
- `claude-code/packages/@ant/ink/`: fork 后的终端 React/Ink 渲染栈。
- `claude-code/packages/@ant/model-provider/`: 多 provider 适配。

粗略规模：`claude-code/src` 下约 2200+ TS/TSX 文件、50 万行以上。后续实现不应从“补几个工具”开始，而应先搭出 runtime 分层和稳定接口。
