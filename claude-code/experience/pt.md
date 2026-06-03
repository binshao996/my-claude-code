````markdown
# AI 工程经验总结（非常重要）

在 courses/ 目录下的《从 0-1 实现 Claude Code》教程全部撰写完成后：

请基于：

- 整个 Claude Code 类系统的实现过程
- AI Coding Agent 的工程实践
- Prompt Engineering 实践
- 长期与 Claude / GPT / Gemini 协作开发复杂系统的经验
- AI Agent 调试经验
- Context Engineering 经验
- Tool Calling 经验
- 多轮协作经验
- 真实工程踩坑经验

额外撰写一套：

# 《AI Coding Agent 工程经验与 Prompt 调教实战》

经验总结文档。

---

# 这部分内容的定位（非常重要）

这不是：

- Prompt 入门教程
- ChatGPT 使用技巧
- AI 科普
- AI 鸡汤
- “10 个 Prompt 技巧”
- AI 工具推荐

而是：

真正面向：

“已经开始使用 AI 开发复杂工程系统的人”

的：

高级 AI 工程协作实战总结。

---

# 核心目标

帮助读者真正掌握：

## 如何调教 AI 开发复杂工程系统

包括：

- 如何与 AI 协作开发大型项目
- 如何让 AI 不跑偏
- 如何减少 AI 幻觉
- 如何让 AI 输出工程级代码
- 如何控制 AI 输出质量
- 如何构建长期可维护 Prompt
- 如何组织大型工程 Prompt
- 如何拆分复杂任务
- 如何管理长上下文
- 如何调试 Claude Code 类 Agent
- 如何提升一次生成成功率
- 如何减少返工
- 如何让 AI 更懂工程

---

# 输出目录

统一输出到：

```bash
experience/
```

---

# 内容要求（非常重要）

所有经验总结：

必须：

- 强工程实践
- 强踩坑经验
- 强 Prompt Engineering
- 强上下文管理
- 强 AI 协作
- 强真实案例

不要：

- 空泛建议
- AI 鸡汤
- 营销文案
- “AI 会改变世界”
- “多和 AI 沟通”
- “AI 是你的助手”

这种废话。

---

# 必须覆盖的主题（非常重要）

至少包括：

---

# 1. 如何写高质量 Prompt

必须讲：

- Prompt 分层
- Role Prompt
- Constraint Prompt
- Workflow Prompt
- Context Prompt
- Output Contract
- Multi-step Prompt
- Planning Prompt
- Reflection Prompt

以及：

- 为什么很多 Prompt 会失效
- 为什么 Prompt 会越来越乱
- 为什么 Prompt 越长越容易跑偏
- 为什么 AI 会忽略后面的约束
- 如何设计长期可维护 Prompt
- 如何做 Prompt 模块化
- 如何做 Prompt 分层架构

---

# 2. 如何避免 AI 跑偏

必须讲：

- 如何限制 AI 自由发挥
- 如何减少 AI 脑补
- 如何约束输出结构
- 如何避免 AI 偷懒
- 如何避免 AI 输出伪代码
- 如何避免 AI 擅自设计不存在模块
- 如何避免 AI 重构整个系统
- 如何避免 AI “自作聪明”

必须分析：

为什么 AI 会跑偏。

---

# 3. 如何让 AI 更懂工程

必须讲：

- 如何要求真实工程实现
- 如何要求真实调用链
- 如何要求真实模块协作
- 如何要求工程级目录结构
- 如何要求工程级代码
- 如何避免“Demo Code”
- 如何避免“玩具架构”
- 如何避免“概念代码”

必须重点讲：

“如何让 AI 写出真正能维护的大型工程代码”。

---

# 4. 如何与 AI 协作开发大型项目

必须讲：

- 如何拆解任务
- 如何拆分章节
- 如何拆分 Prompt
- 如何控制上下文
- 如何做增量开发
- 如何保持术语一致
- 如何保持架构一致
- 如何长期维护 AI 项目
- 如何避免上下文漂移
- 如何避免 AI 遗忘历史决策

必须讲：

大型项目为什么比小 Demo 难很多。

---

# 5. 如何调教 Claude / GPT / Gemini

必须讲：

- Claude 的优势
- GPT 的优势
- Gemini 的优势
- 不同模型适合什么任务
- 如何组合使用模型
- 哪些任务适合 Claude
- 哪些任务适合 GPT
- 哪些任务 Gemini 更强

例如：

- 长文档分析
- 工程架构
- Refactor
- Prompt 生成
- UI 生成
- Debug
- Tool Calling
- Agent Loop

等。

---

# 6. 如何让 AI 输出高质量代码

必须讲：

- 如何要求工程级代码
- 如何要求可维护性
- 如何要求模块边界
- 如何要求代码规范
- 如何要求类型系统
- 如何要求真实错误处理
- 如何要求日志系统
- 如何要求可扩展架构

必须讲：

为什么 AI 默认会输出：

“Demo 代码”。

以及：

如何纠正。

---

# 7. 如何让 AI 写长教程

必须讲：

- 如何保持章节一致性
- 如何保持术语统一
- 如何保持 Diagram 风格统一
- 如何保持代码风格统一
- 如何持续输出长教程
- 如何减少风格漂移
- 如何维护教程上下文

必须讲：

为什么 AI 写长教程容易崩。

---

# 8. 如何管理长上下文（非常重要）

必须讲：

- 如何拆 Context
- 如何减少 Token 浪费
- 如何避免 Context 污染
- 如何做阶段化 Prompt
- 如何做多轮工程协作
- 如何做 Context Compression
- 如何做摘要管理
- 如何避免历史信息失真

必须讲：

为什么 Context 是 AI 工程核心问题。

---

# 9. 如何调试 AI Agent

必须讲：

- 如何 Debug Agent Loop
- 如何 Debug Tool Calling
- 如何 Debug Prompt
- 如何 Debug Memory
- 如何 Debug Context
- 如何 Debug Planning
- 如何 Debug Multi-step Agent

必须包含：

真实调试案例。

---

# 10. 真实踩坑总结（非常重要）

必须包含：

真实工程中的：

- 错误 Prompt 示例
- AI 跑偏案例
- 错误架构案例
- Context 崩坏案例
- Tool Calling 崩坏案例
- Token 爆炸案例
- Prompt 污染案例
- 多轮协作失控案例

并分析：

- 为什么发生
- 如何避免
- 如何修复

---

# 11. 必须分析 AI 的行为机制（非常重要）

不能只讲：

“怎么写 Prompt”。

还必须解释：

“为什么 AI 会这样行为”。

必须分析：

- 为什么 AI 会忽略约束
- 为什么 AI 会脑补
- 为什么 AI 会偷懒
- 为什么 AI 会风格漂移
- 为什么 AI 会输出 Demo Code
- 为什么 AI 会重构整个项目
- 为什么 AI 会假装理解
- 为什么长上下文会失真
- 为什么 AI 后期质量会下降

必须从：

- Token Prediction
- Attention
- Context Window
- RLHF
- Sampling
- Instruction Hierarchy
- Next-token Prediction

角度解释。

必须让读者真正理解：

AI 为什么会产生这些行为。

---

# 12. 必须分析 Agentic Workflow（非常重要）

必须总结：

真正复杂工程中的：

AI Workflow。

包括：

- Planner → Executor → Reviewer
- Architect → Implementer → Reviewer
- Spec → Plan → Code → Test
- Reflection Loop
- Self-debugging Workflow
- Iterative Refinement

并分析：

- 为什么比单轮 Prompt 更稳定
- 如何拆阶段
- 如何降低上下文污染
- 如何提高生成质量
- 如何减少返工
- 如何做 AI Review
- 如何做 AI Self-check

必须讲：

为什么：

“复杂工程不能靠一次 Prompt 完成”。

---

# 13. 必须重点分析 Context Engineering（核心重点）

必须深入分析：

- Context Packing
- Context Isolation
- Context Refresh
- Context Compression
- Memory Layering
- Retrieval Injection
- Context Window Budgeting

以及：

- 为什么 Context 是 AI 工程真正瓶颈
- 为什么不是 Prompt 越长越好
- 为什么 Context 会熵增
- 为什么 AI 后期会越来越混乱
- 如何做上下文分层
- 如何控制上下文质量

必须讲：

Context Engineering：

是 Claude Code 类系统最核心的问题之一。

---

# 14. 必须分析 AI 代码质量退化（非常重要）

必须讲：

- 为什么 AI 越写后面质量越差
- 为什么 AI 会逐渐失去架构一致性
- 为什么 AI 会开始复制粘贴
- 为什么 AI 会 over-engineering
- 为什么 AI 会开始偷懒
- 为什么 AI 会开始无意义抽象
- 为什么 AI 会逐渐失去边界感

以及：

如何解决：

- 定期 Refactor
- 架构回收
- Prompt Refresh
- Context Reset
- Codebase Re-index
- 分阶段重构
- 重新约束 AI

必须讲：

为什么：

“大型工程里的 AI 质量退化”

是必然问题。

---

# 15. 必须分析 Human + AI 协作模式（非常重要）

必须讲：

- 人类负责什么
- AI 负责什么
- 什么不能交给 AI
- 什么必须人工决策
- 什么必须人工 Review
- 如何做人类架构控制
- 如何避免 AI 主导系统架构
- 如何避免 AI 过度重构
- 如何做人类最终质量控制

必须强调：

AI 是：

“高能力工程协作者”。

不是：

“完全自动工程师”。

---

# 每个主题必须包含（非常重要）

每个主题：

都必须包含：

## 错误示例

## 正确示例

## 为什么错误

## 为什么正确

## 最佳实践

## 实战经验

## 真实踩坑

---

# 写作风格要求

必须像：

一个真正长期使用：

- Claude Code
- Cursor
- Claude
- GPT
- Gemini

开发大型工程系统的人：

写出来的高级工程经验总结。

而不是：

AI 入门文章。

---

# 额外输出 1（非常重要）

还必须额外输出：

# 《Prompt 设计模式（Prompt Patterns）》

总结：

大型工程中：

真正有效的 Prompt Pattern。

例如：

- Planner Pattern
- Reviewer Pattern
- Architect Pattern
- Refactor Pattern
- Constraint Pattern
- Incremental Pattern
- Context Isolation Pattern
- Spec-driven Pattern
- Workflow-driven Pattern

并说明：

- 适用场景
- 优势
- 缺点
- 失败案例
- 最佳实践

---

# 额外输出 2（非常重要）

还必须输出：

# 《AI 工程协作反模式（Anti-patterns）》

总结：

最容易导致 AI 项目失控的问题。

例如：

- 超长 Prompt
- 不做任务拆分
- 不做上下文隔离
- Prompt 不可维护
- 过度相信 AI
- 没有约束输出
- 没有工程规范
- 一次性生成整个系统
- 不做阶段化开发

并说明：

- 为什么危险
- 如何识别
- 如何避免
- 如何修复

---

# 最终目标

最终这部分内容：

必须达到：

“真正教会读者如何调教 AI 开发复杂工程系统”

的水平。

而不是：

普通 Prompt 技巧合集。

必须让读者：

真正掌握：

AI 工程协作能力。
````
