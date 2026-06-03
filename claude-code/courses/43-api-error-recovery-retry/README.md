# 第 43 章：官方 API 错误恢复与重试策略

第四十二章补上了 Claude.ai OAuth 和订阅态。

现在 Mini 已经有两条可解释的认证路径：

- DeepSeek Anthropic-compatible：`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` + `ANTHROPIC_MODEL`。
- Claude.ai OAuth：Authorization Code + PKCE + refresh token + subscription status。

接下来必须把 API 错误恢复补齐。

这不是简单的 `try/catch`。

真实 Claude Code 的请求链路会遇到很多不同性质的失败：

- 401：认证过期、OAuth token 失效、API key 错误。
- 403：OAuth token 被撤销、组织无权限、云 provider 凭据过期。
- 408：请求超时。
- 409：服务端锁冲突。
- 429：rate limit。
- 529：overloaded。
- 5xx：服务端错误。
- stream 建立失败。
- stream 中途断流。
- stream 长时间没有事件。
- `prompt is too long`。
- `max_tokens` 输出截断。
- request body 太大。
- 图片、PDF、many-image 限制。
- 模型不存在。
- provider 返回非标准错误格式。

第 21 章已经做过基础 API resilience。

这一章是升级版：把真实工程里的几条恢复路径合成一个更接近官方 Claude Code 的错误管道。

重点不只是“重试”，而是：

> 哪些错误先暂扣，哪些错误自动恢复，哪些错误展示给用户，哪些错误必须停止。

## 本章目标

完成本章后，Mini 会具备：

1. 标准化 API 错误分类。
2. `retry-after` 解析。
3. 指数退避 + jitter。
4. 可取消 sleep。
5. 401 OAuth refresh 后重试。
6. 429/529 重试策略。
7. 前台和后台请求的不同 529 策略。
8. streaming 失败降级到 non-streaming。
9. 连续 529 后模型 fallback。
10. prompt-too-long 暂扣和恢复。
11. max-output 暂扣和恢复。
12. request-too-large、media-too-large 的用户提示。
13. provider-specific error 归一化。
14. SDK/headless `api_retry` 事件。
15. Stop hook 对 API error 的跳过策略。
16. 单元测试覆盖可恢复和不可恢复路径。

这一章的工程目标是：

> 所有模型请求失败都进入同一个错误管道，而不是散落在 AgentLoop、Planner、Compactor、Plugin 里。

## 本章完成效果

429 时：

```txt
API retry: rate_limit, attempt 1/6, retrying in 1200ms
```

529 时：

```txt
API retry: overloaded, attempt 2/6, retrying in 2400ms
```

连续 overloaded 且配置了 fallback：

```txt
Switched to deepseek-v4-flash due to high demand for deepseek-v4-pro
```

streaming 中途断流：

```txt
Streaming fallback: switching to non-streaming request
```

prompt 太长：

```txt
Context too large. Running reactive compact and retrying...
```

输出截断：

```txt
Output token limit hit. Resuming directly...
```

认证失效：

```txt
Authentication failed. Run /login or check ANTHROPIC_AUTH_TOKEN.
```

密钥不会出现在任何错误消息里。

## 真实工程如何处理

真实工程主要分四层。

### `withRetry`

`src/services/api/withRetry.ts` 是底层重试核心。

它负责：

- 创建或复用 client。
- 遇到 401 时刷新 OAuth 或清理 key cache。
- 遇到 Bedrock/Vertex 凭据错误时清理云凭据 cache。
- 识别 stale keep-alive connection。
- 识别 429、529、408、409、5xx。
- 读取 `retry-after`。
- 做指数退避和 jitter。
- 用 `AbortSignal` 中断 sleep。
- 连续 529 后抛出 `FallbackTriggeredError`。
- 不可重试时抛出 `CannotRetryError`。

关键设计是：

```txt
withRetry 不改对话历史。
withRetry 不直接展示最终错误。
withRetry 只产出 retry event 或抛出结构化错误。
```

### `queryModelWithStreaming`

`src/services/api/claude.ts` 负责真正发起 streaming 请求。

它有两类 fallback：

1. stream 过程中报错，降级到 non-streaming。
2. stream 创建阶段 404，降级到 non-streaming。

真实工程还会处理 stream idle watchdog。

如果一段时间没有任何 SSE event，就主动中断 stream，走 fallback 或 retry。

### `query.ts`

`src/query.ts` 是 agent loop。

它处理“错误恢复会影响消息历史”的情况：

- 模型 fallback 后清空失败 attempt 的 assistant/tool 中间状态。
- streaming fallback 后 tombstone 已经展示的 partial assistant message。
- prompt-too-long 错误先暂扣，尝试 context collapse 或 reactive compact。
- max-output 错误先暂扣，尝试提升 output limit 或注入继续消息。
- API error 结束时跳过 stop hook，避免死循环。

这层比重试层更高，因为它知道消息历史、工具执行状态、compaction 状态。

### `errors.ts`

`src/services/api/errors.ts` 把最终错误转换成用户可理解的 assistant API error message。

它处理：

- timeout。
- rate limit。
- prompt too long。
- request too large。
- image/PDF 限制。
- tool_use/tool_result 结构错误。
- invalid model。
- billing error。
- API key 错误。
- OAuth token revoked。
- organization not allowed。
- provider-specific model access error。
- connection error。

这层只负责“最终怎么说”，不负责“要不要重试”。

## 本章项目结构变化

新增：

```txt
src/
  llm/
    errors/
      classify.ts
      retryAfter.ts
      userMessage.ts
      providerErrors.ts
    retry/
      sleep.ts
      policy.ts
      withRetry.ts
    recovery/
      streamingFallback.ts
      modelFallback.ts
      outputRecovery.ts
      contextRecovery.ts
    __tests__/
      classify.test.ts
      retryAfter.test.ts
      withRetry.test.ts
      streamingFallback.test.ts
      outputRecovery.test.ts
      contextRecovery.test.ts
      userMessage.test.ts
```

会修改：

```txt
src/
  llm/
    anthropic.ts
  agent/
    agentLoop.ts
  auth/
    resolver.ts
  oauth/
    refresh.ts
  commands/
    auth.ts
```

如果你的 Mini 当前文件名不同，以已有 LLM client 和 AgentLoop 为准。

关键是边界：

```txt
classify     只分类
withRetry    只重试
recovery     只处理需要改消息历史的恢复
userMessage  只格式化最终错误
```

## 错误管道总览

```txt
send model request
  ↓
classify raw error
  ↓
withRetry
  ├─ transient error → wait → retry
  ├─ auth 401 + oauth → refresh → retry
  ├─ repeated 529 → FallbackTriggeredError
  └─ cannot retry → CannotRetryError
  ↓
streaming fallback
  ├─ stream failed → non-streaming request
  └─ stream 404 → non-streaming request
  ↓
agent recovery
  ├─ prompt too long → compact → retry
  ├─ max output → resume → retry
  └─ model fallback → switch model → retry whole request
  ↓
user-facing error
```

不要把这些合成一个巨大的 `catch`。

每一层只做自己知道的信息。

## Step 1：错误分类类型

新增 `src/llm/errors/classify.ts`：

```ts
export type ApiErrorKind =
  | "aborted"
  | "timeout"
  | "connection"
  | "auth"
  | "token_revoked"
  | "rate_limit"
  | "overloaded"
  | "server"
  | "invalid_request"
  | "prompt_too_long"
  | "request_too_large"
  | "media_too_large"
  | "model_unavailable"
  | "billing"
  | "tool_result_mismatch"
  | "unknown";

export interface ClassifiedApiError {
  kind: ApiErrorKind;
  status?: number;
  retryable: boolean;
  message: string;
  retryAfterMs?: number;
  raw?: unknown;
}

export interface ErrorLike {
  name?: string;
  message?: string;
  status?: number;
  statusCode?: number;
  headers?: Headers | Record<string, string | undefined>;
  cause?: unknown;
}
```

这里用 duck typing，不直接绑定 `@anthropic-ai/sdk` 的错误类。

原因有两个：

1. DeepSeek Anthropic-compatible 可能返回 SDK 未完全识别的错误形状。
2. 测试可以构造普通对象，不需要 mock SDK internals。

## Step 2：提取 ErrorLike

继续写：

```ts
export function toErrorLike(error: unknown): ErrorLike {
  if (error instanceof Error) {
    return error as ErrorLike;
  }

  if (typeof error === "object" && error !== null) {
    return error as ErrorLike;
  }

  return {
    message: String(error),
  };
}

function statusOf(error: ErrorLike): number | undefined {
  return error.status ?? error.statusCode;
}

function messageOf(error: ErrorLike): string {
  return error.message ?? "Unknown API error";
}
```

所有分类先转成 `ErrorLike`。

不要在每个函数里重复写 `error instanceof Error`。

## Step 3：retry-after 解析

新增 `src/llm/errors/retryAfter.ts`：

```ts
export function getHeader(
  headers: Headers | Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;

  if (headers instanceof Headers) {
    return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
  }

  return headers[name] ?? headers[name.toLowerCase()];
}

export function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
}
```

`retry-after` 有两种合法形态：

- 秒数。
- HTTP date。

Mini 两种都支持。

## Step 4：错误分类

继续在 `classify.ts`：

```ts
import { getHeader, parseRetryAfterMs } from "./retryAfter";

export function classifyApiError(error: unknown): ClassifiedApiError {
  const err = toErrorLike(error);
  const status = statusOf(err);
  const message = messageOf(err);
  const lower = message.toLowerCase();
  const retryAfterMs = parseRetryAfterMs(getHeader(err.headers, "retry-after"));

  if (err.name === "AbortError" || lower.includes("aborted")) {
    return {
      kind: "aborted",
      status,
      retryable: false,
      message,
      raw: error,
    };
  }

  if (err.name === "APIConnectionTimeoutError" || lower.includes("timeout")) {
    return {
      kind: "timeout",
      status,
      retryable: true,
      message,
      retryAfterMs,
      raw: error,
    };
  }

  if (status === 401 || status === 403) {
    if (lower.includes("oauth token has been revoked")) {
      return {
        kind: "token_revoked",
        status,
        retryable: true,
        message,
        raw: error,
      };
    }

    return {
      kind: "auth",
      status,
      retryable: status === 401,
      message,
      raw: error,
    };
  }

  if (status === 429) {
    return {
      kind: "rate_limit",
      status,
      retryable: true,
      message,
      retryAfterMs,
      raw: error,
    };
  }

  if (status === 529 || lower.includes("overloaded_error")) {
    return {
      kind: "overloaded",
      status: status ?? 529,
      retryable: true,
      message,
      retryAfterMs,
      raw: error,
    };
  }

  if (lower.includes("prompt is too long")) {
    return {
      kind: "prompt_too_long",
      status,
      retryable: false,
      message,
      raw: error,
    };
  }

  if (status === 413) {
    return {
      kind: "request_too_large",
      status,
      retryable: false,
      message,
      raw: error,
    };
  }

  if (
    lower.includes("image exceeds") ||
    lower.includes("image dimensions exceed") ||
    /maximum of \d+ pdf pages/i.test(message)
  ) {
    return {
      kind: "media_too_large",
      status,
      retryable: false,
      message,
      raw: error,
    };
  }

  if (lower.includes("invalid model") || status === 404) {
    return {
      kind: "model_unavailable",
      status,
      retryable: false,
      message,
      raw: error,
    };
  }

  if (lower.includes("credit balance") || lower.includes("billing")) {
    return {
      kind: "billing",
      status,
      retryable: false,
      message,
      raw: error,
    };
  }

  if (
    lower.includes("tool_use") &&
    (lower.includes("tool_result") || lower.includes("must be unique"))
  ) {
    return {
      kind: "tool_result_mismatch",
      status,
      retryable: false,
      message,
      raw: error,
    };
  }

  if (status !== undefined && status >= 500) {
    return {
      kind: "server",
      status,
      retryable: true,
      message,
      retryAfterMs,
      raw: error,
    };
  }

  if (lower.includes("econnreset") || lower.includes("epipe") || lower.includes("network")) {
    return {
      kind: "connection",
      status,
      retryable: true,
      message,
      raw: error,
    };
  }

  if (status !== undefined && status >= 400) {
    return {
      kind: "invalid_request",
      status,
      retryable: false,
      message,
      raw: error,
    };
  }

  return {
    kind: "unknown",
    status,
    retryable: false,
    message,
    raw: error,
  };
}
```

注意：`prompt_too_long` 在分类里不是普通 retryable。

它不是“等一下再试”的错误。

它需要 agent recovery 改消息历史后重试。

所以它属于更高层的恢复。

## Step 5：Provider-specific error 归一化

新增 `src/llm/errors/providerErrors.ts`：

```ts
export type ProviderId = "anthropic-compatible" | "openai-compatible" | "gemini" | "grok";

export function normalizeProviderError(provider: ProviderId, error: unknown): unknown {
  if (provider === "anthropic-compatible") {
    return normalizeAnthropicCompatibleError(error);
  }

  return error;
}

function normalizeAnthropicCompatibleError(error: unknown): unknown {
  if (typeof error !== "object" || error === null) {
    return error;
  }

  const record = error as Record<string, unknown>;
  const status = typeof record.status === "number" ? record.status : undefined;
  const message = typeof record.message === "string" ? record.message : undefined;

  const body = record.error;
  if (body && typeof body === "object") {
    const inner = body as Record<string, unknown>;
    const innerType = typeof inner.type === "string" ? inner.type : undefined;
    const innerMessage = typeof inner.message === "string" ? inner.message : undefined;

    if (innerType || innerMessage) {
      return {
        ...record,
        status,
        message: [message, innerType, innerMessage].filter(Boolean).join(" · "),
      };
    }
  }

  return error;
}
```

这里先只做 Anthropic-compatible。

后续如果接 OpenAI-compatible，再补：

- OpenAI `error.type`。
- OpenAI `error.code`。
- Gemini `error.status`。
- Grok/xAI 错误体。

不要把 provider 的错误格式直接泄漏到用户 UI。

## Step 6：可取消 sleep

新增 `src/llm/retry/sleep.ts`：

```ts
export class AbortSleepError extends Error {
  constructor() {
    super("Retry sleep aborted");
    this.name = "AbortSleepError";
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new AbortSleepError());
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortSleepError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
```

重试等待必须可取消。

用户按 Esc 时，不应该等完 32 秒 backoff 才停。

## Step 7：重试策略

新增 `src/llm/retry/policy.ts`：

```ts
import type { ClassifiedApiError } from "../errors/classify";

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  max529Retries: number;
  retryBackground529: boolean;
}

export const defaultRetryPolicy: RetryPolicy = {
  maxRetries: 6,
  baseDelayMs: 500,
  maxDelayMs: 32_000,
  max529Retries: 3,
  retryBackground529: false,
};

export function getRetryDelayMs(
  attempt: number,
  error: ClassifiedApiError,
  policy: RetryPolicy,
): number {
  if (error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }

  const exponential = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  const jitter = Math.random() * exponential * 0.25;
  return Math.round(exponential + jitter);
}

export function shouldRetryError(input: {
  error: ClassifiedApiError;
  attempt: number;
  policy: RetryPolicy;
  foreground: boolean;
}): boolean {
  const { error, attempt, policy, foreground } = input;

  if (attempt > policy.maxRetries) return false;
  if (!error.retryable) return false;
  if (error.kind === "aborted") return false;

  if (error.kind === "overloaded" && !foreground && !policy.retryBackground529) {
    return false;
  }

  return true;
}
```

前台和后台请求区别很重要。

用户正在等主线程响应时，529 可以重试。

标题生成、后台摘要、提示建议这类任务如果也在容量不足时重试，会放大服务端压力。

Mini 要保留这个设计。

## Step 8：withRetry

新增 `src/llm/retry/withRetry.ts`：

```ts
import { classifyApiError, type ClassifiedApiError } from "../errors/classify";
import { normalizeProviderError, type ProviderId } from "../errors/providerErrors";
import { getRetryDelayMs, shouldRetryError, defaultRetryPolicy, type RetryPolicy } from "./policy";
import { sleep } from "./sleep";

export interface RetryEvent {
  type: "api_retry";
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: ClassifiedApiError;
}

export class CannotRetryError extends Error {
  constructor(
    public readonly error: ClassifiedApiError,
  ) {
    super(error.message);
    this.name = "CannotRetryError";
  }
}

export class ModelFallbackTriggeredError extends Error {
  constructor(
    public readonly fromModel: string,
    public readonly toModel: string,
  ) {
    super(`Model fallback triggered: ${fromModel} -> ${toModel}`);
    this.name = "ModelFallbackTriggeredError";
  }
}

export async function withRetry<T>(input: {
  provider: ProviderId;
  model: string;
  fallbackModel?: string;
  operation: (attempt: number) => Promise<T>;
  onRetry?: (event: RetryEvent) => void;
  refreshAuth?: () => Promise<boolean>;
  foreground?: boolean;
  signal?: AbortSignal;
  policy?: Partial<RetryPolicy>;
}): Promise<T> {
  const policy = { ...defaultRetryPolicy, ...input.policy };
  let consecutive529 = 0;

  for (let attempt = 1; attempt <= policy.maxRetries + 1; attempt++) {
    if (input.signal?.aborted) {
      throw new CannotRetryError({
        kind: "aborted",
        retryable: false,
        message: "Request aborted",
      });
    }

    try {
      return await input.operation(attempt);
    } catch (rawError) {
      const normalized = normalizeProviderError(input.provider, rawError);
      const error = classifyApiError(normalized);

      if (error.kind === "auth" && input.refreshAuth) {
        const refreshed = await input.refreshAuth();
        if (refreshed && attempt <= policy.maxRetries) {
          continue;
        }
      }

      if (error.kind === "overloaded") {
        consecutive529++;
        if (input.fallbackModel && consecutive529 >= policy.max529Retries) {
          throw new ModelFallbackTriggeredError(input.model, input.fallbackModel);
        }
      } else {
        consecutive529 = 0;
      }

      if (
        !shouldRetryError({
          error,
          attempt,
          policy,
          foreground: input.foreground ?? true,
        })
      ) {
        throw new CannotRetryError(error);
      }

      const delayMs = getRetryDelayMs(attempt, error, policy);
      input.onRetry?.({
        type: "api_retry",
        attempt,
        maxRetries: policy.maxRetries,
        delayMs,
        error,
      });

      await sleep(delayMs, input.signal);
    }
  }

  throw new Error("unreachable retry state");
}
```

这里的 `refreshAuth` 对应第 42 章的 OAuth refresh。

规则：

- 401 先尝试 refresh。
- refresh 成功就直接重试。
- refresh 失败就进入最终错误。
- 不要无限 refresh。

## Step 9：SDK/headless retry event

真实 QueryEngine 会把 `SystemAPIErrorMessage` 转成 SDK 的：

```txt
system / api_retry
```

Mini 也需要对外暴露。

定义：

```ts
export interface ApiRetrySystemEvent {
  type: "system";
  subtype: "api_retry";
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
  errorKind: string;
}

export function retryEventToSystemEvent(event: RetryEvent): ApiRetrySystemEvent {
  return {
    type: "system",
    subtype: "api_retry",
    attempt: event.attempt,
    maxRetries: event.maxRetries,
    retryDelayMs: event.delayMs,
    errorStatus: event.error.status ?? null,
    errorKind: event.error.kind,
  };
}
```

UI 可以显示：

```txt
Retrying in 2 seconds... (attempt 2/6)
```

SDK/headless 可以输出结构化事件。

不要只写日志。

调用方需要知道为什么卡住。

## Step 10：Streaming fallback

新增 `src/llm/recovery/streamingFallback.ts`：

```ts
export interface StreamingFallbackDecision {
  shouldFallback: boolean;
  reason: "stream_error" | "stream_404" | "stream_empty" | "disabled";
}

export function shouldFallbackToNonStreaming(input: {
  error: unknown;
  streamStarted: boolean;
  receivedMessageStart: boolean;
  receivedContentBlock: boolean;
  disabled?: boolean;
}): StreamingFallbackDecision {
  if (input.disabled) {
    return {
      shouldFallback: false,
      reason: "disabled",
    };
  }

  const errorLike = input.error as { status?: number; message?: string };
  if (errorLike.status === 404) {
    return {
      shouldFallback: true,
      reason: "stream_404",
    };
  }

  if (input.streamStarted && !input.receivedContentBlock) {
    return {
      shouldFallback: true,
      reason: "stream_empty",
    };
  }

  return {
    shouldFallback: true,
    reason: "stream_error",
  };
}
```

但这个函数只做决策。

真正执行 fallback 的地方必须清理失败 attempt 的状态：

```ts
export function resetFailedStreamingAttempt(state: {
  assistantMessages: unknown[];
  toolResults: unknown[];
  toolUseBlocks: unknown[];
  discardStreamingTools?: () => void;
}): void {
  state.assistantMessages.length = 0;
  state.toolResults.length = 0;
  state.toolUseBlocks.length = 0;
  state.discardStreamingTools?.();
}
```

如果 Mini 还没有 streaming tool execution，可以先只清空数组。

如果已经边流式边执行工具，必须 discard。

否则 fallback 后会出现重复工具调用或 orphan tool_result。

## Step 11：模型 fallback

新增 `src/llm/recovery/modelFallback.ts`：

```ts
export interface ModelFallbackState<TMessage> {
  currentModel: string;
  fallbackModel?: string;
  messages: TMessage[];
  assistantMessages: TMessage[];
  toolResults: TMessage[];
  stripModelBoundBlocks?: (messages: TMessage[]) => TMessage[];
}

export function applyModelFallback<TMessage>(
  state: ModelFallbackState<TMessage>,
): ModelFallbackState<TMessage> {
  if (!state.fallbackModel) {
    return state;
  }

  return {
    ...state,
    currentModel: state.fallbackModel,
    messages: state.stripModelBoundBlocks
      ? state.stripModelBoundBlocks(state.messages)
      : state.messages,
    assistantMessages: [],
    toolResults: [],
  };
}
```

模型 fallback 必须重跑整次请求。

不能从半条 response 继续。

原因：

- thinking signature 可能和模型绑定。
- tool_use id 来自失败 attempt。
- request id 和 usage 都属于失败 attempt。
- partial message 可能已经不完整。

## Step 12：max output recovery

真实工程的逻辑是：

1. 如果输出达到 `max_tokens`，先暂扣错误。
2. 如果可以提升输出上限，静默重试。
3. 如果仍然截断，注入 meta 用户消息让模型继续。
4. 最多恢复几次。
5. 恢复耗尽后才显示错误。

新增 `src/llm/recovery/outputRecovery.ts`：

```ts
export interface OutputRecoveryState<TMessage> {
  messages: TMessage[];
  assistantMessages: TMessage[];
  recoveryCount: number;
  maxRecoveryCount: number;
  maxOutputTokensOverride?: number;
}

export type OutputRecoveryDecision<TMessage> =
  | {
      type: "retry_with_larger_output";
      maxOutputTokensOverride: number;
    }
  | {
      type: "retry_with_resume_message";
      messages: TMessage[];
      recoveryCount: number;
    }
  | {
      type: "surface_error";
    };

export function recoverFromMaxOutput<TMessage>(input: {
  state: OutputRecoveryState<TMessage>;
  createResumeMessage: () => TMessage;
  canEscalateOutput: boolean;
  escalatedMaxOutputTokens: number;
}): OutputRecoveryDecision<TMessage> {
  if (input.canEscalateOutput && input.state.maxOutputTokensOverride === undefined) {
    return {
      type: "retry_with_larger_output",
      maxOutputTokensOverride: input.escalatedMaxOutputTokens,
    };
  }

  if (input.state.recoveryCount < input.state.maxRecoveryCount) {
    return {
      type: "retry_with_resume_message",
      messages: [
        ...input.state.messages,
        ...input.state.assistantMessages,
        input.createResumeMessage(),
      ],
      recoveryCount: input.state.recoveryCount + 1,
    };
  }

  return {
    type: "surface_error",
  };
}
```

resume message 内容建议保持直接：

```txt
Output token limit hit. Resume directly — no apology, no recap. Pick up mid-thought if needed.
```

不要让模型总结刚才发生了什么。

它应该继续完成任务。

## Step 13：prompt-too-long recovery

`prompt too long` 不是普通重试。

必须缩短上下文。

新增 `src/llm/recovery/contextRecovery.ts`：

```ts
export interface ContextRecoveryResult<TMessage> {
  recovered: boolean;
  messages: TMessage[];
  reason: "collapse_drain_retry" | "reactive_compact_retry" | "none";
}

export async function recoverFromPromptTooLong<TMessage>(input: {
  messages: TMessage[];
  previousTransition?: string;
  drainContextCollapse?: (messages: TMessage[]) => TMessage[] | null;
  reactiveCompact?: (messages: TMessage[]) => Promise<TMessage[] | null>;
  hasAttemptedReactiveCompact: boolean;
}): Promise<ContextRecoveryResult<TMessage>> {
  if (input.previousTransition !== "collapse_drain_retry" && input.drainContextCollapse) {
    const drained = input.drainContextCollapse(input.messages);
    if (drained) {
      return {
        recovered: true,
        messages: drained,
        reason: "collapse_drain_retry",
      };
    }
  }

  if (!input.hasAttemptedReactiveCompact && input.reactiveCompact) {
    const compacted = await input.reactiveCompact(input.messages);
    if (compacted) {
      return {
        recovered: true,
        messages: compacted,
        reason: "reactive_compact_retry",
      };
    }
  }

  return {
    recovered: false,
    messages: input.messages,
    reason: "none",
  };
}
```

真实工程优先 context collapse，再 reactive compact。

Mini 如果还没有 context collapse，可以只接 reactive compact。

但一定要保留两个 guard：

- 已经 collapse retry 过，不再重复 collapse。
- 已经 reactive compact 过，不再重复 compact。

否则会形成无限循环。

## Step 14：media-size recovery

图片和 PDF 超限有两种处理。

第一种：用户当前输入太大。

直接提示用户换小文件。

第二种：历史消息里有太多旧图片。

可以通过 reactive compact 或 strip old media 恢复。

定义：

```ts
export function isRecoverableMediaError(message: string): boolean {
  return (
    (message.includes("image exceeds") && message.includes("maximum")) ||
    message.includes("image dimensions exceed") ||
    /maximum of \d+ PDF pages/.test(message)
  );
}
```

恢复策略：

```txt
media error
  ↓
if old media can be stripped
  strip old media + retry
else
  surface user message
```

Mini 第一版可以只做 user message。

后面接 reactive compact 时再加入自动恢复。

## Step 15：最终用户错误

新增 `src/llm/errors/userMessage.ts`：

```ts
import type { ClassifiedApiError } from "./classify";

export function toUserFacingApiError(error: ClassifiedApiError): string {
  switch (error.kind) {
    case "auth":
      return "Authentication failed. Run /login or check ANTHROPIC_AUTH_TOKEN.";
    case "token_revoked":
      return "OAuth token revoked. Run /login again.";
    case "rate_limit":
      return "Rate limit reached. Try again later.";
    case "overloaded":
      return "The model is overloaded. Try again later or switch models.";
    case "timeout":
      return "Request timed out. Check your network and retry.";
    case "connection":
      return "Connection failed. Check your network, proxy, or TLS settings.";
    case "prompt_too_long":
      return "Prompt is too long. Run /compact or start a smaller session.";
    case "request_too_large":
      return "Request is too large. Use smaller files or reduce context.";
    case "media_too_large":
      return "An image or PDF is too large. Resize it or convert it to text.";
    case "model_unavailable":
      return "The selected model is unavailable. Use /model to choose another model.";
    case "billing":
      return "Billing or credit balance issue. Check your account.";
    case "tool_result_mismatch":
      return "Conversation tool state is inconsistent. Use /rewind or start a new turn.";
    case "aborted":
      return "Request interrupted.";
    case "server":
      return "Server error. Try again later.";
    case "invalid_request":
      return `API Error: ${error.message}`;
    case "unknown":
    default:
      return `API Error: ${error.message}`;
  }
}
```

这个函数只能接收已脱敏的错误。

如果原始错误可能包含 token，先 redaction，再格式化。

## Step 16：Secret redaction

第 41 章已经有 redaction。

这里要把它接到最终错误管道：

```ts
import { redactKnownSecrets } from "../../auth/redaction";
import type { ClassifiedApiError } from "./classify";

export function redactClassifiedError(
  error: ClassifiedApiError,
  secrets: Array<string | null | undefined>,
): ClassifiedApiError {
  return {
    ...error,
    message: redactKnownSecrets(error.message, secrets),
  };
}
```

任何 `API Error: ${error.message}` 之前都应该先 redaction。

尤其是：

- Authorization header。
- Bearer token。
- API key。
- custom gateway key。
- proxy credentials。

## Step 17：LLM client 接入

把 LLM client 改成统一入口：

```ts
import { createAnthropicCompatibleClient } from "../auth/client";
import { processEnvReader } from "../auth/env";
import { resolveProviderAuth } from "../auth/resolver";
import { forceRefreshOAuthTokens } from "../oauth/refresh";
import { createFileOAuthTokenStore } from "../oauth/tokenStore";
import { withRetry, ModelFallbackTriggeredError, CannotRetryError } from "./retry/withRetry";

const oauthStore = createFileOAuthTokenStore();

export async function runModelRequest(input: {
  model: string;
  fallbackModel?: string;
  foreground: boolean;
  signal?: AbortSignal;
}) {
  let resolved = await resolveProviderAuth(processEnvReader, {
    oauthStore,
  });

  try {
    return await withRetry({
      provider: "anthropic-compatible",
      model: input.model,
      fallbackModel: input.fallbackModel,
      foreground: input.foreground,
      signal: input.signal,
      refreshAuth: async () => {
        if (resolved.auth.mode !== "oauth") return false;
        const refreshed = await forceRefreshOAuthTokens(oauthStore);
        if (!refreshed) return false;
        resolved = await resolveProviderAuth(processEnvReader, { oauthStore });
        return true;
      },
      operation: async () => {
        const client = createAnthropicCompatibleClient(resolved);
        return await client.messages.create({
          model: input.model,
          max_tokens: 4096,
          messages: [{ role: "user", content: "ping" }],
        });
      },
    });
  } catch (error) {
    if (error instanceof ModelFallbackTriggeredError) {
      throw error;
    }
    if (error instanceof CannotRetryError) {
      throw error;
    }
    throw error;
  }
}
```

注意：OAuth refresh 后要重新 resolve auth。

否则 client 仍然拿旧 access token。

## Step 18：Agent loop 接入恢复

Agent loop 要处理三类特殊错误：

```ts
if (error instanceof ModelFallbackTriggeredError) {
  state = applyModelFallback(state);
  continue;
}

if (isPromptTooLongAssistantMessage(lastMessage)) {
  const recovered = await recoverFromPromptTooLong(...);
  if (recovered.recovered) {
    state = {
      ...state,
      messages: recovered.messages,
      transition: recovered.reason,
    };
    continue;
  }
}

if (isMaxOutputAssistantMessage(lastMessage)) {
  const recovered = recoverFromMaxOutput(...);
  if (recovered.type !== "surface_error") {
    state = applyOutputRecovery(state, recovered);
    continue;
  }
}
```

这说明一个边界：

```txt
withRetry 管网络和 API transient。
Agent loop 管消息历史变化。
```

不要让 retry 层调用 compact。

它不知道消息历史该怎么改。

## Step 19：API error 后跳过 Stop Hook

如果最后一条是 API error，不要跑 stop hook。

否则容易出现：

```txt
API error
  ↓
stop hook 认为输出不合规
  ↓
注入 blocking error
  ↓
再次请求
  ↓
同一个 API error
  ↓
无限循环
```

实现：

```ts
if (lastMessage?.isApiErrorMessage) {
  runStopFailureHooks(lastMessage);
  return {
    reason: "model_error",
    error: lastMessage.apiError ?? "api_error",
  };
}
```

Stop hook 只应该评估真实模型输出。

API error 不是模型完成结果。

## Step 20：结构化测试：classify

新增 `src/llm/__tests__/classify.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { classifyApiError } from "../errors/classify";

describe("classifyApiError", () => {
  test("classifies 429 as rate limit", () => {
    const result = classifyApiError({ status: 429, message: "rate limited" });

    expect(result.kind).toBe("rate_limit");
    expect(result.retryable).toBe(true);
  });

  test("classifies overloaded message as 529", () => {
    const result = classifyApiError({
      message: '{"type":"overloaded_error"}',
    });

    expect(result.kind).toBe("overloaded");
    expect(result.retryable).toBe(true);
  });

  test("classifies prompt too long", () => {
    const result = classifyApiError({
      status: 400,
      message: "prompt is too long: 137500 tokens > 135000 maximum",
    });

    expect(result.kind).toBe("prompt_too_long");
    expect(result.retryable).toBe(false);
  });

  test("classifies token revoked", () => {
    const result = classifyApiError({
      status: 403,
      message: "OAuth token has been revoked",
    });

    expect(result.kind).toBe("token_revoked");
    expect(result.retryable).toBe(true);
  });
});
```

## Step 21：测试 retry-after

新增 `src/llm/__tests__/retryAfter.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { parseRetryAfterMs } from "../errors/retryAfter";

describe("parseRetryAfterMs", () => {
  test("parses seconds", () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
  });

  test("parses HTTP date", () => {
    const date = new Date(Date.now() + 10_000).toUTCString();
    const value = parseRetryAfterMs(date);

    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(10_000);
  });

  test("ignores invalid value", () => {
    expect(parseRetryAfterMs("later")).toBeUndefined();
  });
});
```

## Step 22：测试 withRetry

新增 `src/llm/__tests__/withRetry.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { withRetry, ModelFallbackTriggeredError, CannotRetryError } from "../retry/withRetry";

describe("withRetry", () => {
  test("retries transient server error", async () => {
    let calls = 0;

    const result = await withRetry({
      provider: "anthropic-compatible",
      model: "model-a",
      policy: { baseDelayMs: 1, maxDelayMs: 1 },
      operation: async () => {
        calls++;
        if (calls === 1) {
          throw { status: 500, message: "server error" };
        }
        return "ok";
      },
    });

    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  test("does not retry invalid request", async () => {
    await expect(
      withRetry({
        provider: "anthropic-compatible",
        model: "model-a",
        operation: async () => {
          throw { status: 400, message: "bad request" };
        },
      }),
    ).rejects.toBeInstanceOf(CannotRetryError);
  });

  test("refreshes auth on 401", async () => {
    let calls = 0;
    let refreshed = false;

    const result = await withRetry({
      provider: "anthropic-compatible",
      model: "model-a",
      operation: async () => {
        calls++;
        if (!refreshed) {
          throw { status: 401, message: "expired" };
        }
        return "ok";
      },
      refreshAuth: async () => {
        refreshed = true;
        return true;
      },
    });

    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  test("triggers fallback after repeated 529", async () => {
    await expect(
      withRetry({
        provider: "anthropic-compatible",
        model: "model-a",
        fallbackModel: "model-b",
        policy: { baseDelayMs: 1, maxDelayMs: 1, max529Retries: 2 },
        operation: async () => {
          throw { status: 529, message: "overloaded" };
        },
      }),
    ).rejects.toBeInstanceOf(ModelFallbackTriggeredError);
  });
});
```

测试里把 delay 降到 1ms。

不要让重试测试真的等几十秒。

## Step 23：测试 output recovery

新增 `src/llm/__tests__/outputRecovery.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { recoverFromMaxOutput } from "../recovery/outputRecovery";

describe("recoverFromMaxOutput", () => {
  test("escalates output tokens first", () => {
    const result = recoverFromMaxOutput({
      state: {
        messages: ["user"],
        assistantMessages: ["assistant"],
        recoveryCount: 0,
        maxRecoveryCount: 3,
      },
      canEscalateOutput: true,
      escalatedMaxOutputTokens: 64000,
      createResumeMessage: () => "resume",
    });

    expect(result.type).toBe("retry_with_larger_output");
  });

  test("adds resume message after escalation", () => {
    const result = recoverFromMaxOutput({
      state: {
        messages: ["user"],
        assistantMessages: ["assistant"],
        recoveryCount: 0,
        maxRecoveryCount: 3,
        maxOutputTokensOverride: 64000,
      },
      canEscalateOutput: true,
      escalatedMaxOutputTokens: 64000,
      createResumeMessage: () => "resume",
    });

    expect(result.type).toBe("retry_with_resume_message");
  });
});
```

## Step 24：测试 context recovery

新增 `src/llm/__tests__/contextRecovery.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { recoverFromPromptTooLong } from "../recovery/contextRecovery";

describe("recoverFromPromptTooLong", () => {
  test("uses collapse drain first", async () => {
    const result = await recoverFromPromptTooLong({
      messages: ["a", "b"],
      hasAttemptedReactiveCompact: false,
      drainContextCollapse: messages => messages.slice(1),
    });

    expect(result.recovered).toBe(true);
    expect(result.reason).toBe("collapse_drain_retry");
    expect(result.messages).toEqual(["b"]);
  });

  test("does not repeat collapse drain", async () => {
    const result = await recoverFromPromptTooLong({
      messages: ["a", "b"],
      previousTransition: "collapse_drain_retry",
      hasAttemptedReactiveCompact: false,
      drainContextCollapse: messages => messages.slice(1),
      reactiveCompact: async () => ["summary"],
    });

    expect(result.reason).toBe("reactive_compact_retry");
    expect(result.messages).toEqual(["summary"]);
  });
});
```

## Step 25：手动验收

DeepSeek Anthropic-compatible 仍然这样启动：

```bash
export ANTHROPIC_AUTH_TOKEN="<your-deepseek-key>"
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_MODEL="deepseek-v4-flash"
bun run dev
```

模拟 rate limit：

```bash
CCMINI_FAKE_API_ERROR=429 bun run dev
```

期望看到 retry event。

模拟 overloaded：

```bash
CCMINI_FAKE_API_ERROR=529 CCMINI_MODEL_FALLBACK="deepseek-v4-flash" bun run dev
```

期望连续失败后触发模型 fallback。

模拟 prompt too long：

```bash
CCMINI_FAKE_API_ERROR=prompt_too_long bun run dev
```

期望触发 compact recovery，而不是普通 backoff retry。

模拟 max output：

```bash
CCMINI_FAKE_STOP_REASON=max_tokens bun run dev
```

期望 Mini 注入 resume message 继续，而不是直接停止。

这些 fake env 需要你在测试 harness 里实现。

不要让手动验收依赖真实 429 或 529。

## Step 26：自动化验收

运行本章测试：

```bash
bun test src/llm/__tests__/classify.test.ts
bun test src/llm/__tests__/retryAfter.test.ts
bun test src/llm/__tests__/withRetry.test.ts
bun test src/llm/__tests__/streamingFallback.test.ts
bun test src/llm/__tests__/outputRecovery.test.ts
bun test src/llm/__tests__/contextRecovery.test.ts
bun test src/llm/__tests__/userMessage.test.ts
```

运行类型检查：

```bash
bun run typecheck
```

运行已有核心测试：

```bash
bun test
```

## 常见坑

第一，把 prompt-too-long 当普通 retry。

等再久也不会变短。

必须 compact 或减少上下文。

第二，max output 直接当失败。

输出截断经常可以继续。

先恢复，再展示失败。

第三，streaming fallback 不清理 partial state。

这会导致 orphan assistant message、重复 tool_use、旧 tool_result 泄漏。

第四，模型 fallback 从半条 response 继续。

必须重跑整次请求。

第五，后台任务在 529 时和前台一样重试。

容量不足时，后台重试会放大压力。

第六，Stop hook 处理 API error。

API error 不是模型输出。

让 stop hook 介入容易死循环。

第七，错误消息打印 secret。

所有最终错误都必须先 redaction。

第八，重试 sleep 不可取消。

用户中断必须立即生效。

第九，`retry-after` 只支持秒数。

HTTP date 也要支持。

第十，401 refresh 后复用旧 client。

OAuth refresh 后要重新创建带新 token 的 client。

## 和官方 Claude Code 的距离

这一章之后，Mini 已经接近官方错误管道的核心：

- transient retry。
- retry-after。
- exponential backoff。
- 401 refresh。
- 429/529 策略。
- foreground/background 区分。
- streaming fallback。
- model fallback。
- prompt-too-long recovery。
- max-output recovery。
- API retry event。
- API error skip stop hook。
- user-facing error normalization。

仍然缺少：

- fast mode cooldown。
- unattended persistent retry。
- Bedrock/Vertex 凭据刷新。
- stale keep-alive socket 处理。
- 真实 quota header 解析。
- overage/extra usage 提示。
- stream idle watchdog 的完整遥测。
- context collapse 和 reactive compact 的生产级实现。
- tool_use mismatch 的 rewind/share 辅助。

但 Mini 的恢复边界已经对了。

后续补复杂功能时，应该继续挂在这些层上，而不是回到散落 catch。

## 小结

本章把 Mini 的 API 错误处理升级成官方式错误管道。

现在 Mini 支持：

- 分类原始 API error。
- 解析 `retry-after`。
- 可取消 backoff。
- OAuth 401 refresh retry。
- 429/529 retry。
- 连续 529 模型 fallback。
- streaming 到 non-streaming fallback。
- prompt-too-long recovery。
- max-output recovery。
- provider-specific error normalization。
- user-facing error message。
- SDK/headless retry event。

核心规则是：

```txt
可等待的错误交给 retry。
需要改历史的错误交给 recovery。
最终展示交给 userMessage。
任何层都不能泄漏 secret。
```

下一章可以继续做 **会话持久化、恢复与 rewind**：把 transcript、message tombstone、partial stream、tool result pairing、checkpoint、resume、rewind 和 crash recovery 做成一个可靠的会话系统。
