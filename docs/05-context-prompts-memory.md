# 05. Context、Prompts、Memory 与 Compact

## System prompt 构造

核心源码：

- `src/constants/prompts.ts`
- `src/constants/systemPromptSections.ts`
- `src/context.ts`
- `src/utils/api.ts`

System prompt 不是一段静态文本，而是按 section 动态拼接：

- 基础身份和工程任务行为。
- 工具使用规则。
- 安全和 prompt injection 规则。
- hooks 说明。
- output style。
- language preference。
- MCP instructions。
- model/provider 相关说明。
- skills/deferred tools 说明。
- worktree、proactive、browser、REPL、cached microcompact 等 feature-gated section。
- 动态边界 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`，用于 prompt cache。

`prompts.ts` 中明确将 prompt 分成静态可缓存部分和动态会话部分。实现时不能简单用一个大字符串替代。

## User/System Context

`src/context.ts` 提供两类上下文：

### System context

常见内容：

- git status snapshot。
- current branch。
- main branch。
- recent commits。
- git user。
- cache breaker injection。

git status 会被截断，避免一开始就污染上下文。

### User context

常见内容：

- CLAUDE.md / memory files。
- current date。

CLAUDE.md 不是只读当前目录一个文件，而是通过 `utils/claudemd.ts` 做目录发现、过滤、注入和缓存。

## Attachments

agent loop 内会在不同阶段注入 attachments：

- memory attachments
- skills/context attachments
- command attachments
- hook results
- file/image attachments
- queued command 相关消息

关键源码：

- `src/utils/attachments.ts`
- `src/utils/messages.ts`
- `src/query.ts`

设计重点：attachments 是 message 流的一部分，必须可被 transcript/resume/compact 处理。

## Memory

源码里 memory 来源较多：

- CLAUDE.md 和项目 memory files。
- `memdir` 目录。
- local memory / memory stores。
- session memory。
- auto memory extraction。
- relevant memory prefetch。

关键源码：

- `src/memdir/memdir.ts`
- `src/services/extractMemories/*`
- `src/services/localVault/*`
- `src/commands/memory/*`
- `src/commands/local-memory/*`
- `src/commands/memory-stores/*`

## Compact 类型

### Auto compact

`services/compact/autoCompact.ts` 根据 token window、buffer、模型上下文窗口判断是否自动压缩。压缩成功后由 `compact.ts` 生成 post-compact messages。

特性：

- 大窗口模型有更大 buffer。
- 连续 compact 失败会 circuit-break。
- compact 结果会包含 summary、保留消息、attachments、hook results。

### Manual compact

用户可以通过 `/compact` 触发。它同样走 compact runtime，而不是简单删除历史。

### Microcompact

微压缩主要处理工具结果、缓存编辑和旧上下文清理，降低上下文成本。

相关源码：

- `src/services/compact/microCompact.ts`
- `src/services/compact/cachedMicrocompact.ts`
- `src/services/compact/apiMicrocompact.ts`

### Snip compact

`HISTORY_SNIP` feature 下，对历史消息做裁剪，保留关键尾部上下文。

相关源码：

- `src/services/compact/snipCompact.ts`

### Reactive compact

当 API 返回 prompt too long、413、media size 等错误时，`reactiveCompact` 尝试在错误恢复路径中压缩后重试。

相关源码：

- `src/services/compact/reactiveCompact.ts`
- `src/query.ts`

### Context collapse

`services/contextCollapse/*` 为更细粒度的 collapse 留了接口。当前参考源码中部分实现仍有 stub/feature gate，但 `query.ts` 已有接入点和恢复路径。

## Tool result storage

长会话中，工具结果是最大上下文风险之一。源码通过以下机制控制：

- 每个工具有 `maxResultSizeChars`。
- `applyToolResultBudget()` 控制总预算。
- 大内容可被 content replacement 持久化。
- microcompact 清理旧 result。
- `toolUseResult` 原始 payload 在 UI 消费后删除。

关键源码：

- `src/utils/toolResultStorage.ts`
- `src/query.ts`

## 重新实现建议

第一阶段就应该实现：

1. `getSystemPrompt()` 分 section 构造。
2. `getUserContext()` 支持 CLAUDE.md 和 current date。
3. `getSystemContext()` 支持 git status snapshot。
4. transcript 中保留 attachment 和 compact boundary。
5. 简版 auto compact：超过阈值时总结旧消息。
6. tool result budget：至少能截断和标记大结果。

不要把上下文管理留到最后。没有上下文 runtime，长任务会很快退化。
