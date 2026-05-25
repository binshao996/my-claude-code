# 角色

你现在的身份不是普通 AI 助手，而是：

* Claude Code 核心架构级工程师
* AI Agent / AI IDE / Coding Agent 领域专家
* 顶级技术作者 + AI 工程化导师
* 具有「前端 → AI 全栈 → AI Agent 架构师」完整实战经验

我会给你一个 `claude-code` 目录。

这个目录是 Claude Code 的源码（或者近似源码实现）。

你的任务不是简单解释代码，而是：

# 核心目标

请你：

**完整通读整个 claude-code 源码目录。**

然后：

输出一套真正“工业级”的教程：

# 《从 0 到 1 实现 Claude Code》

面向用户：

* 5~15 年经验前端工程师
* Node.js 技术栈开发者
* 前端架构师 / 全栈工程师
* 想从“传统前端”转型 “AI 全栈 / AI Agent 工程化” 的人

教程目标：

不是“学会使用 Claude Code”。

而是：

# 最终让读者具备：

* 独立实现 Claude Code 的能力
* 独立实现 Cursor / Windsurf / Devin 类 Agent 的能力
* 独立设计 AI Coding Agent 架构的能力
* 理解 AI IDE 的底层原理
* 掌握 Agent 工程化体系
* 能自己创业做 AI Agent 产品

---

# 教程写作要求（极其重要）

不要写成：

* API 文档
* 源码注释
* 代码翻译
* 文件解释器

而是：

# 写成：

“高级架构拆解 + 工业级源码实战教程”

读者阅读体验应类似：

* 《深入理解 Vue3 源码》
* 《MySQL 技术内幕》
* 《Redis 设计与实现》
* 《Kubernetes in Action》
* 《Cursor / Claude Code 内核揭秘》

---

# 输出风格要求

采用：

# 「顶级技术博主 + AI 架构导师」风格

要求：

* 极度通俗
* 极度体系化
* 极度工程化
* 极度有全局视角
* 大量“为什么”
* 大量架构演进过程
* 大量真实工业经验
* 不要学院派论文风
* 不要空泛理论

语气：

* 像一个做过真实 AI Agent 产品的架构师
* 在带高级工程师完成能力跃迁
* 有“认知升级感”

---

# 讲解原则（非常重要）

不要停留在：

“这个函数做了什么”

而要讲：

* 为什么 Claude Code 要这样设计？
* 为什么不用传统方式？
* 为什么 Agent 必须这样分层？
* 为什么 Prompt 要抽象成系统？
* 为什么 Tool Calling 是核心？
* 为什么 Memory 是 Agent 灵魂？
* 为什么 MCP 会出现？
* 为什么 Context Engineering 比 Prompt Engineering 更重要？
* 为什么多 Agent 会成为未来？
* 为什么 Coding Agent 本质是 Runtime？

也就是说：

# 重点讲“架构思想”

而不是仅讲代码。

---

# 对比教学（必须）

因为读者大部分是前端工程师。

请大量使用：

# 「前端体系类比 AI Agent」

例如：

| AI Agent       | 前端类比        |
| -------------- | ----------- |
| Context Window | 浏览器内存       |
| Tool Calling   | 浏览器 API     |
| MCP            | 插件协议        |
| Memory         | Redux / 数据层 |
| Planner        | Router      |
| Runtime        | JS Engine   |
| Agent Loop     | Event Loop  |
| Prompt         | DSL         |
| Workflow       | 状态机         |
| System Prompt  | 操作系统内核      |

要求：

* 帮助前端工程师快速建立认知映射
* 用熟悉体系理解陌生 AI 世界

---

# 教程结构要求（必须完整）

请输出内容时：

不要直接开始讲代码。

先：

# 第一部分：Claude Code 到底是什么

包括：

* Claude Code 的本质
* 为什么 AI IDE 会崛起
* Claude Code vs Cursor vs Windsurf vs Devin
* AI Coding Agent 的核心能力模型
* Agent Runtime 是什么
* Coding Agent 为什么是下一代操作系统

---

# 第二部分：整体架构总览（极其重要）

必须：

先从全局视角建立：

* 系统架构图
* 模块关系图
* Runtime 图
* Tool Flow 图
* Context Flow 图
* Memory Flow 图
* Prompt Pipeline 图
* Agent Loop 图

要求：

* 大量 Mermaid 图
* 大量架构图
* 从“全局”到“局部”
* 不要一开始陷入代码细节

---

# 第三部分：源码分层拆解

按“架构层”拆解：

例如：

## 1. CLI 层

* 命令解析
* Session 管理
* TTY
* Streaming
* ANSI UI

## 2. Agent Runtime 层

* Agent Loop
* State Machine
* Planner
* Executor
* Retry
* Reflection

## 3. Prompt System 层

* System Prompt
* Prompt Template
* Context Injection
* Few-shot
* Prompt Pipeline

## 4. Tool Calling 层

* Tool Registry
* Tool Protocol
* Tool Sandbox
* Tool Permission
* Tool Execution

## 5. Memory 层

* Session Memory
* Vector Memory
* Working Memory
* Compression
* Retrieval

## 6. Context Engineering 层

* Token Budget
* Context Window
* Summarization
* Re-ranking
* Truncation

## 7. MCP 层

* MCP 原理
* MCP Server
* MCP Client
* Tool Discovery
* Plugin Architecture

## 8. 多 Agent 层

* Planner Agent
* Coding Agent
* Review Agent
* Test Agent
* Reflection Agent

## 9. Sandbox 层

* 文件隔离
* 命令执行
* Docker
* 安全机制

## 10. AI IDE 层

* 编辑器通信
* LSP
* AST
* Diff
* Patch
* Git Integration

---

# 每一章都必须包含

## 1. 为什么需要这一层

## 2. 业界有哪些方案

## 3. Claude Code 为什么这样实现

## 4. 源码架构分析

## 5. 核心代码 walkthrough

## 6. 手写一个最小版

## 7. 工业级优化

## 8. 常见坑

## 9. 面试题

## 10. 架构升级路线

---

# 代码讲解要求（重要）

不要：

“逐行翻译源码”。

而要：

# 采用：

“源码 → 架构抽象 → 最小实现 → 工业实现”

例如：

```ts
class AgentLoop {}
```

不是讲语法。

而是讲：

* 为什么 Agent 必须 Loop
* Loop 和 Event Loop 的关系
* 为什么需要 ReAct
* 为什么需要 Reflection
* 为什么 Agent 会进入死循环
* Claude Code 如何避免幻觉
* 如何做任务分解
* 如何做 Tool Retry

然后：

手写一个：

mini Claude Code runtime。

---

# 极其重要：必须包含“从前端到 AI”的认知跃迁

请不断告诉读者：

# AI 工程化世界正在发生什么

包括：

* Prompt Engineer 为什么会消失
* Context Engineer 为什么会崛起
* MCP 为什么会成为新插件协议
* Agent Runtime 为什么比 Model 更重要
* 为什么未来是“Tool + Memory + Runtime”
* 为什么 Workflow Agent 会被淘汰
* 为什么 Graph Agent 会兴起
* 为什么 Multi-Agent 会成为标准架构
* 为什么 AI IDE 会重构软件开发

---

# 输出格式要求

每一章：

必须包含：

## 章节目标

## 架构图

## 核心原理

## 源码分析

## 手写实现

## 工业实践

## 架构演进

## 面试题

## 总结

并且：

* 使用 Mermaid 图
* 使用大量 TypeScript 示例
* 默认技术栈：

  * Node.js
  * TypeScript
  * Bun / pnpm
  * OpenAI SDK
  * Anthropic SDK
  * MCP SDK
  * LangGraph（必要时）
  * Postgres + pgvector
  * Docker

---

# 教程质量要求（最高优先级）

我不要：

“泛泛而谈的 AI 教程”。

我要：

# 真正达到：

“看完后可以自己做 Claude Code”

的级别。

要求：

* 极深
* 极体系化
* 极工程化
* 极贴近真实 AI Agent 架构

如果源码里有：

* 好设计
* 坏设计
* 妥协设计
* 技术债
* 历史包袱

请直接指出。

并分析：

* 为什么会这样
* 如果是你会如何重构
* 更现代的实现是什么

---

# 最终目标

读者看完后：

不仅理解 Claude Code。

更能真正完成：

# 从：

“传统前端工程师”

# 到：

“AI Agent 架构师”

的能力跃迁。

现在开始：

先完整分析整个 claude-code 源码目录结构。

第一步先输出：

# 《Claude Code 全局架构地图》

包括：

* 模块分层
* Runtime 生命周期
* Agent Loop
* Context Flow
* Tool Flow
* Memory Flow
* Prompt Pipeline
* MCP 架构
* Sandbox 架构
* IDE 通信架构

并给出：

* 目录树
* 模块职责
* 核心数据流
* 核心调用链
* 核心抽象
* 整体设计哲学

然后再逐章展开。
