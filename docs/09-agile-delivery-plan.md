# 09. 敏捷交付推进方案

## 交付原则

- 目标仍是 1:1 复刻 `claude-code/`，不是只做 local MVP。
- 每个 Sprint 都必须交付可运行版本，不接受只产出设计、不产出可演示功能。
- 每个版本都必须同时推进 Agent Core、Product Surface、Engineering Parity 三条主线。
- 技术债必须显式登记，不能用“后续优化”掩盖架构缺口。
- 复刻时优先对齐架构边界，再对齐 UI 细节。
- Provider 固定 DeepSeek v4 flash，但内部协议保持 Claude-compatible。
- 高风险能力必须前置 spike，不允许到 V1.0 才发现协议或工程不可行。
- `docs/10-source-coverage-ledger.md` 是唯一覆盖台账；版本文档不重复维护 tool/command/feature 全量清单。

## 三条主线的执行方式

| 主线 | 每个 Sprint 必须回答的问题 | 产出物 |
| --- | --- | --- |
| Agent Core | 本 Sprint 对 agent runtime 的哪一段行为负责？ | provider/tool/query/context/permission 等核心代码、contract tests |
| Product Surface | 用户如何感知这段能力？ | CLI/TUI/command/session/remote 操作路径、demo script |
| Engineering Parity | 这段能力如何被构建、测试、回归、发布？ | fixtures、typecheck/test/build、smoke、doctor/health、parity ledger |

版本 planning 时不允许只提交某一条主线的 Story。例外只能是 Sprint 0 的源码映射和 ADR，但也必须覆盖三条主线的准备工作。

每个 Sprint 必须至少关闭 `docs/10-source-coverage-ledger.md` 中一个条目。关闭是指条目进入 `Covered`、`Disabled-Parity`，或明确进入 D-001 这类已接受偏差。

## 团队角色

| 角色 | 职责 |
| --- | --- |
| PJM | 版本节奏、范围控制、风险管理、验收组织 |
| Tech Lead | 架构边界、技术方案、源码映射、代码质量门禁 |
| Runtime Engineer | provider、query loop、context、compact、memory |
| Tooling Engineer | tools、permissions、hooks、MCP、skills、plugins |
| TUI/Product Engineer | CLI、React/Ink TUI、commands、session、remote 操作面 |
| Build/Release Engineer | Bun build、wrapper、vendor assets、doctor、release artifact |
| QA/Automation | 回归用例、parity case、fixture、长任务压测、production smoke |

小团队可一人多岗，但职责必须分开评审。

## Sprint 节奏

建议两周一个 Sprint：

- Day 1: Sprint planning，确认版本目标、三条主线 Story、验收标准和风险。
- Day 2-7: 开发、源码对照、每日同步。
- Day 8: 集成、补测试、补 parity ledger。
- Day 9: 回归、fixture replay、build smoke。
- Day 10: Demo、Retro、下个 Sprint backlog refine。

每日同步只回答四件事：

- 昨天完成了什么。
- 今天推进什么。
- 哪个源码行为已经对齐或发现差异。
- 是否有阻塞或风险。

## Backlog 层级

Backlog 分四层管理：

| 层级 | 说明 | 示例 |
| --- | --- | --- |
| Program Goal | 1:1 复刻 Claude Code | V1.0 可替代版本 |
| Version Epic | 某版本主目标 | V0.3 核心工具和权限 |
| Track Epic | 三条主线内的模块目标 | Agent Core: permission runtime |
| Story | 1-3 天内可完成的工作单元 | 实现 `runToolUse()` validation error recovery |

每个 Story 应满足：

- 1-3 天内可完成。
- 有明确验收标准。
- 能归属到一个 Version Epic 和一个 Track Epic。
- 有明确源码参考。
- 有明确 coverage ledger 条目。
- 有测试、fixture、replay 或手工验证方式。
- 有 parity case 或明确说明为什么暂不需要。

不合格示例：

- “实现 TUI”
- “做工具系统”
- “复刻 Claude Code”
- “支持 remote”

合格示例：

- “实现 `Tool` 接口和 `runToolUse()` 校验链路，支持 unknown tool 和 Zod parse error 两类失败路径。”
- “实现 `Read` 工具，支持 offset/limit，超过最大输出时截断并返回提示。”
- “实现 headless `-p`，输出 DeepSeek streaming 文本并写入 transcript。”
- “实现 DeepSeek streaming tool-call parser fixture，把 provider delta 映射为内部 `ToolUseBlock`。”

## Definition of Ready

Story 进入 Sprint 前必须满足：

- 明确用户价值或技术价值。
- 明确所属版本、所属主线、所属 Epic。
- 明确输入、输出、边界。
- 明确参考源码路径。
- 明确 `docs/10-source-coverage-ledger.md` 中对应条目。
- 明确验收方式。
- 明确测试或 fixture 策略。
- 明确对 Claude Code 的预期等价行为。
- 依赖已就绪或已拆出前置 Story。
- 不包含大范围未知探索；未知必须先拆成 spike。

## Definition of Done

Story 完成必须满足：

- 功能可运行。
- 类型检查通过。
- 关键路径有测试、fixture、replay 或手工验证记录。
- 文档或 README 已同步必要变化。
- 无新增秘密、token、私有配置。
- 错误路径有显式处理。
- 与 Claude Code 对齐点和偏差点已记录。
- coverage ledger 中对应条目状态已更新。
- 如果影响 CLI/TUI，demo script 已更新。
- 如果影响 provider/tool/session，transcript 或 fixture 已更新。
- 如果影响 build/runtime，bundle smoke 已执行。

## 版本验收流程

每个版本结束做一次验收：

1. Demo 版本目标能力。
2. 跑版本回归清单。
3. 对照 `claude-code/` 源码说明已对齐的架构边界。
4. 列出未对齐项，进入下个版本 backlog。
5. 更新风险清单。
6. 更新 parity case 状态。
7. 更新 `docs/10-source-coverage-ledger.md` 状态。
8. 确认当前版本及以前的 coverage ledger 条目没有 `RED`。
9. 跑 build smoke 或 production smoke。
10. 决定是否允许进入下一版本。

## Parity Case 管理

从 Sprint 0 开始维护 parity case，而不是等到工具系统完成后再补。

每个 case 包含：

- Case ID。
- 用户任务。
- Claude Code 期望行为。
- 当前实现行为。
- 差异。
- 归属版本。
- 归属主线。
- 参考源码路径。
- Coverage Ledger ID 或条目名。
- 修复优先级。
- 验证方式。

初始 parity case：

| Case | 任务 | 起始版本 | 主线 |
| --- | --- | --- | --- |
| P-001 | `--help/--version` fast path | V0.1 | Product Surface |
| P-002 | DeepSeek streaming 文本输出 | V0.2 | Agent Core |
| P-003 | provider tool-call delta 映射为 `ToolUseBlock` | V0.2 | Agent Core |
| P-004 | 读取一个文件并总结 | V0.3 | Agent Core |
| P-005 | 搜索某个函数并解释调用链 | V0.3 | Agent Core |
| P-006 | 修改单文件并展示 diff | V0.3 | Agent Core |
| P-007 | 危险 Bash 命令需要确认 | V0.3 | Agent Core |
| P-008 | settings/env 控制 provider 和权限 | V0.3 | Engineering Parity |
| P-009 | PreToolUse hook 阻止工具执行 | V0.3 | Agent Core |
| P-010 | 运行测试并根据失败修复 | V0.4 | Product Surface |
| P-011 | 中断生成后继续输入 | V0.4 | Product Surface |
| P-012 | resume 恢复历史会话 | V0.4 | Product Surface |
| P-013 | TUI 权限弹窗不阻塞输入状态 | V0.4 | Product Surface |
| P-014 | 长会话触发 compact 后继续任务 | V0.5 | Agent Core |
| P-015 | 大 tool result 截断并可引用 | V0.5 | Agent Core |
| P-016 | MCP 工具发现和调用 | V0.6 | Agent Core |
| P-017 | skill 被发现并影响工具选择 | V0.6 | Agent Core |
| P-018 | plugin 注入 command | V0.6 | Product Surface |
| P-019 | 子 agent 完成探索任务并返回摘要 | V0.7 | Agent Core |
| P-020 | background session 启动、查看日志、停止 | V0.7 | Product Surface |
| P-021 | worktree session metadata 可恢复 | V0.7 | Product Surface |
| P-022 | daemon 启动、连接、断开 | V0.8 | Product Surface |
| P-023 | remote session 执行最小任务并 resume | V0.8 | Product Surface |
| P-024 | 安装后的 CLI artifact 可运行 | V1.0 | Engineering Parity |
| P-025 | doctor/health 发现配置问题 | V1.0 | Engineering Parity |

## 测试矩阵

| 测试类型 | 起始版本 | 覆盖范围 |
| --- | --- | --- |
| Typecheck | V0.1 | 全仓库 TypeScript |
| Unit test | V0.1 | 核心类型、parser、工具纯逻辑 |
| Provider contract fixture | V0.1 | DeepSeek streaming/tool-call/usage/error 映射 |
| Transcript replay | V0.2 | query loop、terminal、resume、compact |
| Tool/permission fixture | V0.3 | builtin tools、权限模式、危险命令 |
| Hook fixture | V0.3 | UserPromptSubmit、PreToolUse、PostToolUse、Stop |
| TUI smoke | V0.4 | prompt、message list、permission modal、abort |
| Session regression | V0.4 | continue/resume/read state/permission state |
| Long-run replay | V0.5 | compact、tool result budget、memory |
| MCP fixture server | V0.6 | tools/resources/permission/result |
| Plugin/skill fixture | V0.6 | manifest、skill loader、command injection |
| Subagent/background integration | V0.7 | context isolation、logs、task state |
| Remote/daemon smoke | V0.8 | daemon lifecycle、bridge protocol、remote resume |
| Feature flag matrix | V0.9 | default features、disabled features、all `feature(...)` calls |
| Platform/native smoke | V0.10 | voice、Chrome、browser/computer-use、native packages、remote-control-server |
| Tool inventory closure | V0.11 | 所有内置 tool 的 schema、permission、UI/headless、result mapping |
| Command inventory closure | V0.11 | 所有 command module 的 interactive/noninteractive/gating/help/failure |
| Commander subcommand audit | V0.11 | deep subcommands、options、alias、exit code |
| Source coverage ledger | Sprint 0-V1.0 | 源码目录、workspace package、feature、tool、command、deviation 状态 |
| Bundle integrity | V0.1-V1.0 | Bun build、Node/Bun wrapper、vendor assets |
| Production smoke | V1.0 | 安装后的真实 CLI artifact |

## Sprint 0：准备工作

目标：让项目进入可开发状态，并让 1:1 范围可控。

任务：

- 确认精确技术栈 ADR：Bun、TypeScript strict、React 19、`@anthropic/ink` fork、Zod、Biome、Commander、MCP SDK、workspace packages、native packages、Bun/Node wrapper、vendor assets。
- 决定 repo 结构和 package 边界。
- 建立 CI 命令：typecheck、test、lint、build。
- 建立 docs 到源码实现的映射 ledger。
- 建立 `docs/10-source-coverage-ledger.md` 的初始状态，所有源码目录/package/feature/tool/command 都必须有目标版本。
- 建立 issue/backlog 模板。
- 建立 ADR 目录。
- 建立 parity case 初版。
- 确认 DeepSeek API 环境变量命名。
- 确认 DeepSeek tool-call compatibility spike 的实验输入和验收。

输出：

- 工程骨架 PR。
- backlog 初版。
- parity case 初版。
- source coverage ledger 初版。
- 技术栈 ADR。
- V0.1 Sprint planning。

## Sprint Planning 模板

```md
# Sprint N Planning

## Sprint Goal

## Version Target

## Committed Stories

| ID | Track | Story | Owner | Source Reference | Acceptance |
| --- | --- | --- | --- | --- | --- |

## Coverage Ledger Items

| Item | Current State | Target State |
| --- | --- | --- |

## Parity Cases

| Case | Expected Movement |
| --- | --- |

## Risks

## Out of Scope

## Demo Script

## Verification Commands
```

## Story 模板

```md
# Story: <title>

## Version

## Track

## Epic

## User/Technical Value

## Source Reference

## Coverage Ledger Item

## Claude Code Expected Behavior

## Scope

## Acceptance Criteria

## Test/Verification

## Parity Case

## Out of Scope
```

## 风险管理节奏

每周更新一次风险清单。高优先级风险必须进入 Sprint backlog，而不是只记录。

风险字段：

- 风险描述。
- 影响版本。
- 影响主线。
- 影响范围。
- 概率。
- 影响程度。
- Owner。
- 应对策略。
- 是否需要 spike。

当前 P0 风险：

| 风险 | Owner | 必须完成的前置动作 |
| --- | --- | --- |
| DeepSeek tool-call 语义不等价 | Runtime Engineer | V0.1 compatibility spike |
| 技术栈偏离源码 | Tech Lead | Sprint 0 技术栈 ADR |
| Build/release 后置导致返工 | Build/Release Engineer | V0.1 bundle smoke |
| 测试矩阵不足 | QA/Automation | Sprint 0 parity case + V0.1 fixture |
| Remote 被排除出 V1.0 | PJM | V0.8 纳入 roadmap gate |
| 源码覆盖台账缺失或重复 | Tech Lead | 使用 `docs/10-source-coverage-ledger.md` 作为唯一事实源 |

## 质量门禁

每个 Sprint 至少执行：

- `bun run typecheck`
- `bun run test`
- 当前版本 smoke test。
- 当前版本 parity case 回归。
- bundle smoke，如果本 Sprint 影响 CLI/build/runtime。

从 V0.2 开始增加：

- provider contract fixture。
- transcript replay。

从 V0.3 开始增加：

- tool/permission fixture。
- dangerous command regression。
- hook fixture。

从 V0.4 开始增加：

- TUI smoke test。
- resume/continue 回归。
- permission 场景回归。

从 V0.5 开始增加：

- 长会话 compact 回归。
- 大 tool result 回归。

从 V0.6 开始增加：

- MCP server fixture 回归。
- skill loader 回归。
- plugin manifest 回归。

从 V0.7 开始增加：

- subagent isolation 回归。
- background lifecycle 回归。

从 V0.8 开始增加：

- daemon lifecycle 回归。
- bridge protocol 回归。
- remote permission 回归。

从 V0.9 开始增加：

- feature flag matrix 回归。

从 V0.10 开始增加：

- native package build smoke。
- platform integration default-state 回归。
- voice/chrome/browser/computer-use smoke。

从 V0.11 开始增加：

- tool inventory closure 回归。
- command inventory closure 回归。
- Commander subcommand audit。
- CLI flag audit。

V1.0 必须增加：

- production smoke。
- install/doctor/health 回归。
- 50 个真实工程 parity case audit。
- `docs/10-source-coverage-ledger.md` 全量关闭 audit。

## 决策记录

必须新增 ADR 目录，记录关键产品/技术决策：

- 为什么默认 provider 是 DeepSeek v4 flash。
- DeepSeek response 如何映射到 Claude-compatible content blocks。
- DeepSeek tool-call 不等价时采用哪种 parser/prompt fallback。
- Tool schema 如何定义。
- transcript 格式如何保持可恢复。
- 权限模式如何与 Claude Code 对齐。
- settings/auth/config/policy 如何组织。
- hooks 如何影响工具执行和 session stop。
- 为什么选择 React/Ink fork 策略。
- Bun build、Node/Bun wrapper、vendor assets 如何复刻。
- remote/daemon/bridge 在 V1.0 前的最小闭环是什么。
- coverage ledger 的状态定义、更新责任和验收门禁。

## 当前下一步

下一步进入 Sprint 0，然后启动 V0.1：

1. 建立源码映射 ledger。
2. 初始化 `docs/10-source-coverage-ledger.md`，并把所有条目从 `RED` 分配到目标版本。
3. 固定技术栈 ADR。
4. 建 repo/package/build/test 骨架。
5. 定义 Claude-compatible 核心协议。
6. 实现 CLI `--version/--help`。
7. 实现最小 transcript writer。
8. 启动 DeepSeek provider compatibility spike，优先验证 streaming tool-call。
