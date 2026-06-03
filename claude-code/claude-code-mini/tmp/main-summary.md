# src/main.ts 总结

## 概述
该文件是 CLI 应用的主入口点，使用 **Commander.js** 框架构建。它定义了一个支持**交互式聊天模式**和**非交互式打印模式**的 Agent CLI 工具。

---

## 类型定义

| 类型 | 说明 |
|------|------|
| `RootOptions` | CLI 选项接口：contextWindow、print、cwd、model、maxTurns、session、resume、continue、listSessions |
| `SessionStartMode` | 会话启动模式：`"new" \| "resume" \| "continue"` |
| `ResolvedStartupSession` | 解析后的启动会话结果（模式 + 加载的会话） |

---

## 主函数 `main()`

- 使用 `CommanderCommand` 构建 CLI
- 接受一个可选参数 `[prompt...]`（用户输入的提示词）
- 支持的选项：
  - `-p, --print` — 非交互模式，打印结果后退出
  - `--cwd <path>` — 工作目录（默认当前目录）
  - `--model <model>` — 覆盖 LLM 模型
  - `--max-turns <number>` — 最大模型/工具迭代次数（默认 8）
  - `--context-window <tokens>` — 输入上下文窗口大小（默认 32,000 tokens）
  - `--session <id>` — 指定新的会话 ID
  - `--resume <id>` — 恢复指定会话
  - `--continue` — 继续最近一次会话
  - `--list-sessions` — 列出当前项目会话
  - `-v, --version` — 输出版本号

---

## 核心逻辑 `handlePrompt()`

1. **加载 LLM 配置**，可选覆盖 model
2. **创建 `SessionStore`**（与会话存储交互）
3. **处理 `--list-sessions`**：列出会话后退出
4. **解析启动会话**（通过 `resolveStartupSession()`）
5. **创建 `PlannerStore` 和 `ToolRegistry`**
6. **三种执行路径**：
   - ⭐ **有 prompt + 普通模式** → 调用 `runSinglePrompt()` 流式执行单次请求
   - ❌ **`--print` 但无 prompt** → 报错退出
   - 💬 **无 prompt + TTY 可用** → 调用 `runChatLoop()` 进入交互式多轮对话

错误处理：捕获所有异常，输出错误消息并设置 `exitCode = 1`。

---

## 流式处理 `runSinglePrompt()`

通过 `async generator`（`session.sendUserMessageStream(prompt)`）处理事件：

| 事件类型 | 行为 |
|----------|------|
| `turn_start` | 打印 `[turn N]` |
| `context_update` | 打印上下文压缩信息（token 变化、压缩的工具结果数、修剪的消息数） |
| `text_delta` | 流式输出文本到 stdout |
| `tool_use_start` | 打印 `[tool_use] name`，启动输入进度 |
| `tool_input_delta` | 更新工具输入接收进度 |
| `tool_use` | 打印最终工具输入，结束进度显示 |
| `turn_complete` | 打印该轮工具调用次数 |
| `tool_start` | 打印 `[tool_start] name` |
| `tool_result` | 打印工具执行结果（ok/error）及 diff |
| `max_turns_reached` | 打印达到最大轮次警告 |
| `message_stop` | 记录最终响应 |

完成后，若非打印模式且有响应，则输出模型名称、token 用量、cwd 和 max-turns。

---

## 辅助函数

| 函数 | 说明 |
|------|------|
| `createSessionToolRegistry()` | 创建会话级工具注册表（含 cwd、readFileState、planner） |
| `parsePositiveInteger()` | 校验并转换正整数参数，无效则抛出 `InvalidArgumentError` |
| `printDiff()` | 如果存在 diff 则打印 |
| `resolveStartupSession()` | 解析会话启动模式，校验参数冲突（如 `--resume` 和 `--continue` 不能同时使用） |
| `printSessionList()` | 格式化输出会话列表（ID、更新时间、消息数、首条提示词） |

---

## 关键依赖模块

- `commander` — CLI 框架
- `./chat/session` — ChatSession
- `./chat/chatLoop` — runChatLoop（交互式循环）
- `./llm/config` — LLM 配置加载
- `./llm/types` — LLM 类型定义（LLMConfig, LLMResponse）
- `./constants` — 常量（CLI_NAME, PRODUCT_NAME, VERSION）
- `./tools` — 工具注册表及 ToolContext
- `./session` — SessionStore 及会话类型
- `./planner` — PlannerStore
- `./chat/toolInputFormatter` — 工具输入进度格式化
