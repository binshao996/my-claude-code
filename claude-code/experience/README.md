# AI Coding Agent 工程经验文档

这组文档是《从 0-1 实现 Claude Code》70 章之后的工程复盘，不是 Prompt 入门教程。

它面向已经开始用 Claude Code、Cursor、Claude、GPT、Gemini 开发复杂工程系统的人，重点讨论三个问题：

1. 如何让 AI 稳定参与大型工程，而不是只写 Demo。
2. 如何设计 Prompt、Context、Workflow，让 Agent 不跑偏。
3. 如何在人类架构控制下，让 AI 输出可维护、可验证、可长期演进的代码。

## 阅读顺序

1. [AI Coding Agent 工程经验与 Prompt 调教实战](./ai-coding-agent-engineering.md)

   主文档。覆盖高质量 Prompt、避免跑偏、工程级代码、大型项目协作、模型分工、长教程、长上下文、Agent 调试、真实踩坑、AI 行为机制、Agentic Workflow、Context Engineering、代码质量退化、人机协作边界。

2. [Prompt 设计模式（Prompt Patterns）](./prompt-patterns.md)

   可复用的 Prompt Pattern 手册。适合在实际开发中复制、裁剪、组合，包括 Planner、Architect、Reviewer、Refactor、Constraint、Incremental、Context Isolation、Spec-driven、Workflow-driven 等模式。

3. [AI 工程协作反模式（Anti-patterns）](./anti-patterns.md)

   失控案例手册。总结超长 Prompt、不拆任务、不隔离上下文、没有验收契约、过度相信 AI、一次性生成整个系统等反模式，以及识别和修复方式。

4. [AI Coding Agent 工程真实案例复盘](./case-studies.md)

   深案例集。按“背景 -> 错误 Prompt -> 错误输出 -> 排查过程 -> 最终修复 -> 修正后 Prompt”拆解 Tool Calling、Context Compaction、Verification Gate、插件供应链和 Memory 污染等真实工程问题。

5. [React Ink 终端交互架构实战](./react-ink-terminal-ui.md)

   终端 UI 专题。总结 React Ink 状态模型、PromptInput 模式切换、键盘焦点、权限弹窗、Diff/Plan、StatusLine、Streaming 渲染、Error Boundary 和历史会话 UI 的工程经验。

## 与 courses/ 的关系

`courses/` 解决的是“如何从 0-1 实现一个 Claude Code Mini”：

- 第 1-15 章：CLI、LLM、Chat Loop、Streaming、Tool Calling、Agent Loop、Planner、Sandbox、完整闭环。
- 第 16-24 章：质量门禁、Memory、Token Budget、模型路由、错误恢复、Transcript、Resume、Context Compaction。
- 第 25-40 章：Slash Command、MCP、权限审计、执行隔离、后台任务、多 Agent、插件和供应链。
- 第 41-56 章：认证、OAuth、API 恢复、会话 rewind、长期记忆、远控、Daemon、Runner、审计与可观测性。
- 第 57-70 章：命令控制流、多客户端一致性、事件存储、策略引擎、终端体验、代码智能、发布、生产支持、企业治理、高隔离部署。

`experience/` 解决的是“做完之后，如何把这些经验抽象成 AI 工程协作方法论”。

## 主题索引

| 经验主题 | 对应课程章节 | 建议先读 | 推荐案例 |
| --- | --- | --- | --- |
| Tool Calling 调试 | 第 7、8、15、56 章 | `ai-coding-agent-engineering.md` 第 9 节 | `case-studies.md` 案例 1 |
| Context Engineering | 第 11、18、24、45、46 章 | `ai-coding-agent-engineering.md` 第 8、13 节 | `case-studies.md` 案例 2 |
| Verification Gate | 第 16、34 章 | `prompt-patterns.md` Verification Pattern | `case-studies.md` 案例 3 |
| 插件与供应链 | 第 37、38、39、40、63 章 | `anti-patterns.md` 第 12、17 节 | `case-studies.md` 案例 4 |
| Memory 与长期协作 | 第 17、46 章 | `ai-coding-agent-engineering.md` 第 4、8 节 | `case-studies.md` 案例 5 |
| 多 Agent 工作流 | 第 30、31、32、33、34 章 | `prompt-patterns.md` Planner/Reviewer/Workflow Pattern | `ai-coding-agent-engineering.md` 第 12 节 |
| 权限与安全边界 | 第 27、55、60、61、62 章 | `anti-patterns.md` 第 11、17 节 | `case-studies.md` 案例 4 |
| 生产可观测性 | 第 22、56、68 章 | `ai-coding-agent-engineering.md` 第 9 节 | `case-studies.md` 案例 1、3 |
| React Ink 终端 UI | 第 47、64、68 章 | `react-ink-terminal-ui.md` | 第 64 章终端体验层 |

## 使用方式

做新功能前，先读主文档里的“任务拆解、Context Engineering、交付门禁”。

写复杂 Prompt 前，先查 `prompt-patterns.md`。

发现 AI 开始脑补、重构失控、输出 Demo Code、上下文混乱时，查 `anti-patterns.md`。

遇到“文章里讲得对，但不知道工程上怎么落地”的情况，查 `case-studies.md`。

如果要复刻 Claude Code 的官方级终端体验，读 `react-ink-terminal-ui.md`，再回到第 47、64、68 章看实现细节。

不要把这些文档当成固定模板。真正有效的做法是：每个项目维护自己的工程约束、术语表、验收标准和反模式清单。
