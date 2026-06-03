# 第 21 章：API 请求容错与 fallback

第二十章实现了模型路由。Mini 已经能根据 `main`、`fast`、`planner`、`compact`、`plugin` 这些角色选择模型，也能继续用 DeepSeek Anthropic-compatible endpoint 和 `@anthropic-ai/sdk` 发请求。

但真实运行时，模型请求并不总是成功：

- 网络断开、代理异常、TLS 证书错误。
- 请求超时。
- 429 rate limit。
- 529 overloaded。
- streaming 中途断流。
- streaming endpoint 不支持，但非流式 endpoint 可用。
- 模型不存在或没有权限。
- prompt 太长。
- request body 太大。
- API key 错误或过期。

如果每个调用点都自己处理这些错误，AgentLoop、Planner、Compactor、Plugin 都会被异常处理污染。本章要做的是把 API 请求容错收束到 LLM client 层。

本章继续保持第二章和第二十章的接入方式：

```bash
export ANTHROPIC_AUTH_TOKEN="<your-deepseek-key>"
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_MODEL="deepseek-v4-flash"
```

SDK 仍然是 `@anthropic-ai/sdk`。这一章不换协议、不新增 provider adapter，只给 Anthropic-compatible 请求路径加容错。

## 本章目标

完成本章后，你会得到：

1. `src/llm/apiErrors.ts`：错误分类和用户可读错误。
2. `src/llm/retry.ts`：指数退避、jitter、`retry-after`、可取消 sleep。
3. `src/llm/fallback.ts`：模型 fallback 和 streaming fallback 策略。
4. `src/llm/resilientAnthropic.ts`：带容错的 Anthropic-compatible client。
5. 对 AgentLoop 暴露 retry/fallback 事件。
6. 对 API 错误做脱敏输出。
7. 单元测试覆盖重试、不可重试错误、模型 fallback、streaming fallback、secret 不泄漏。

这一章的工程目标是：调用模型失败时，Mini 能清楚知道“该不该重试、等多久、是否换模型、最终怎么告诉用户”。

## 本章完成效果

429 或 529 时，Mini 会等待并重试：

```txt
API retry: rate_limit, attempt 1/4, retrying in 1200ms
```

如果连续 overloaded，并且配置了 fallback：

```bash
export CCMINI_MODEL_FALLBACK="deepseek-v4-flash"
```

Mini 会切换模型并重跑整次请求：

```txt
Model fallback: deepseek-v4-flash -> deepseek-v4-flash
```

如果 streaming endpoint 返回 404，但非流式请求可用，Mini 会自动改用非流式请求：

```txt
Streaming fallback: switching to non-streaming request
```

如果错误不可恢复，例如认证失败：

```txt
API Error: authentication failed. Check ANTHROPIC_AUTH_TOKEN.
```

密钥不会出现在错误消息、日志或调试输出里。

## 真实工程如何处理 API 容错

真实 Claude Code 的 API 容错主要分布在四个位置。

### `withRetry`

`src/services/api/withRetry.ts` 是重试核心。它做几件事：

- 默认最多重试多次。
- 读取 `retry-after` header。
- 使用指数退避和 jitter。
- 429、408、409、5xx、连接错误可重试。
- 401 会清理 key cache 或刷新 OAuth 后重试。
- 529 overloaded 会单独计数，连续失败后可能触发模型 fallback。
- 对非前台任务，529 不继续重试，避免容量雪崩时放大请求量。
- sleep 绑定 `AbortSignal`，用户中断时立即停止。

它还有两个关键错误类型：

- `CannotRetryError`：已经判断不能再重试，带着原始错误和 retry context 抛出去。
- `FallbackTriggeredError`：不是最终失败，而是通知外层“该切模型并重跑请求”。

这个设计很重要：重试层不应该自己改对话历史，也不应该自己清理工具状态。它只负责告诉外层发生了什么。

### streaming fallback

`src/services/api/claude.ts` 里，streaming 请求失败时有两条 fallback：

1. streaming 中途异常，可以切到非流式请求。
2. stream 创建阶段 404，也可以切到非流式请求。

但这里有一个风险：如果工具调用已经在 streaming 过程中开始执行，fallback 后非流式请求可能再次生成同一个工具调用，导致工具被执行两次。

真实工程通过 `StreamingToolExecutor.discard()` 丢弃失败 attempt 的工具执行状态，避免 orphan tool result 泄漏到重试里。

Mini 如果还没有“边流式边执行工具”，可以简单很多：只在完整 assistant message 结束后执行工具。这样 streaming fallback 不会导致工具重复执行。

### 模型 fallback

`src/query.ts` 捕获 `FallbackTriggeredError` 后会做这些事：

- 将当前模型切到 fallback model。
- 重跑整次 API 请求。
- 清掉失败 attempt 的 assistant/tool 中间状态。
- 丢弃正在运行的 streaming tool executor。
- 给用户展示一条 warning：模型因为高负载切换了。

注意：模型 fallback 不是“接着失败的半条 response 往下续”。它必须重跑整次请求，否则 tool use、thinking / redacted_thinking block、request id、签名和消息结构都可能不一致。

### 错误归一化

`src/services/api/errors.ts` 把最终错误转成用户能理解的 assistant API error message。典型分类包括：

- timeout。
- rate limit。
- prompt too long。
- request too large。
- image/pdf 太大。
- authentication failed。
- model unavailable。
- connection error。
- generic API error。

同一个原始错误在交互模式和非交互模式下提示也可能不同。例如交互模式可以建议 `/model`，非交互模式更适合提示启动参数或环境配置。

Mini 本章实现一个精简版，但保持同样边界。

## 本章项目结构变化

新增：

```txt
src/
  llm/
    apiErrors.ts
    retry.ts
    fallback.ts
    resilientAnthropic.ts
    __tests__/
      retry.test.ts
      apiErrors.test.ts
      resilientAnthropic.test.ts
```

修改：

```txt
src/
  llm/
    anthropic.ts
  agent/
    agentLoop.ts
  models/
    config.ts
    types.ts
```

如果你的 Mini 文件名不同，以现有 LLM client 和 AgentLoop 为准。本章的核心是：所有请求都通过 `resilientAnthropic.ts`，业务层不直接处理 SDK 错误。

## 设计原则

API 容错遵循五条规则：

1. 重试只处理 transient error，不重试配置错误和请求格式错误。
2. 等待时间优先尊重 `retry-after`。
3. 用户中断必须立即停止重试。
4. streaming fallback 必须保证工具不会重复执行。
5. 最终展示给用户的错误必须脱敏。

错误处理链路：

```txt
request
  ↓
withRetry
  ↓
streaming fallback
  ↓
model fallback
  ↓
toUserFacingApiError
```

`withRetry` 不直接打印用户消息，`toUserFacingApiError` 不决定是否重试。保持这两个边界，代码会清晰很多。

## 第一步：定义错误类型

创建 `src/llm/apiErrors.ts`：

```ts
export type ApiErrorKind =
  | "timeout"
  | "rate_limit"
  | "overloaded"
  | "auth"
  | "invalid_request"
  | "prompt_too_long"
  | "request_too_large"
  | "model_unavailable"
  | "connection"
  | "server"
  | "aborted"
  | "unknown";

export type ClassifiedApiError = {
  kind: ApiErrorKind;
  status?: number;
  message: string;
  retryAfterMs?: number;
  retryable: boolean;
};

type HeadersLike = Headers | Record<string, string | undefined>;

type ErrorLike = {
  name?: string;
  message?: string;
  status?: number;
  headers?: HeadersLike;
  cause?: unknown;
};
```

这里不用直接依赖 SDK 的具体错误类。Mini 可以通过 duck typing 识别 `status`、`headers`、`message`，测试也更容易写。

继续添加工具函数：

```ts
function asErrorLike(error: unknown): ErrorLike {
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

function headerValue(headers: HeadersLike | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  return headers[name] ?? headers[name.toLowerCase()];
}

export function getRetryAfterMs(error: unknown): number | undefined {
  const value = headerValue(asErrorLike(error).headers, "retry-after");
  if (!value) {
    return undefined;
  }

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

`retry-after` 可能是秒数，也可能是 HTTP date。Mini 两种都支持。

## 第二步：分类 API 错误

在 `src/llm/apiErrors.ts` 继续写：

```ts
export function classifyApiError(error: unknown): ClassifiedApiError {
  const err = asErrorLike(error);
  const message = err.message ?? "Unknown API error";
  const lower = message.toLowerCase();
  const retryAfterMs = getRetryAfterMs(error);

  if (err.name === "AbortError" || lower.includes("aborted")) {
    return {
      kind: "aborted",
      message,
      retryable: false,
    };
  }

  if (lower.includes("timeout") || err.name === "APIConnectionTimeoutError") {
    return {
      kind: "timeout",
      message,
      retryable: true,
    };
  }

  if (err.status === 429) {
    return {
      kind: "rate_limit",
      status: err.status,
      message,
      retryAfterMs,
      retryable: true,
    };
  }

  if (err.status === 529 || lower.includes("overloaded_error")) {
    return {
      kind: "overloaded",
      status: err.status,
      message,
      retryAfterMs,
      retryable: true,
    };
  }

  if (err.status === 401 || err.status === 403 || lower.includes("x-api-key")) {
    return {
      kind: "auth",
      status: err.status,
      message,
      retryable: false,
    };
  }

  if (err.status === 404 || lower.includes("invalid model")) {
    return {
      kind: "model_unavailable",
      status: err.status,
      message,
      retryable: false,
    };
  }

  if (lower.includes("prompt is too long")) {
    return {
      kind: "prompt_too_long",
      status: err.status,
      message,
      retryable: false,
    };
  }

  if (err.status === 413 || lower.includes("request too large")) {
    return {
      kind: "request_too_large",
      status: err.status,
      message,
      retryable: false,
    };
  }

  if (err.status === 400) {
    return {
      kind: "invalid_request",
      status: err.status,
      message,
      retryable: false,
    };
  }

  if (err.status === 408 || err.status === 409) {
    return {
      kind: "server",
      status: err.status,
      message,
      retryAfterMs,
      retryable: true,
    };
  }

  if (err.status !== undefined && err.status >= 500) {
    return {
      kind: "server",
      status: err.status,
      message,
      retryAfterMs,
      retryable: true,
    };
  }

  if (
    err.name === "APIConnectionError" ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("network")
  ) {
    return {
      kind: "connection",
      message,
      retryable: true,
    };
  }

  return {
    kind: "unknown",
    status: err.status,
    message,
    retryAfterMs,
    retryable: false,
  };
}
```

这个分类比真实工程少很多分支，但已经覆盖 Coding Agent 最常见的失败。

## 第三步：错误脱敏和用户提示

继续在 `src/llm/apiErrors.ts` 添加：

```ts
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]+/g,
  /Bearer\s+[a-zA-Z0-9._-]+/g,
  /ANTHROPIC_AUTH_TOKEN=([^\s]+)/g,
  /ANTHROPIC_API_KEY=([^\s]+)/g,
  /api[_-]?key["']?\s*[:=]\s*["']?[^"',\s]+/gi,
];

export function redactApiErrorMessage(message: string): string {
  return SECRET_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, "[redacted]"),
    message,
  );
}

export function toUserFacingApiError(error: unknown, model: string): string {
  const classified = classifyApiError(error);
  const detail = redactApiErrorMessage(classified.message);

  switch (classified.kind) {
    case "timeout":
      return "API Error: request timed out. Try again or increase API_TIMEOUT_MS.";
    case "rate_limit":
      return "API Error: rate limit reached. Wait and retry, or switch to another configured model.";
    case "overloaded":
      return `API Error: model is overloaded (${model}). Try again or configure CCMINI_MODEL_FALLBACK.`;
    case "auth":
      return "API Error: authentication failed. Check ANTHROPIC_AUTH_TOKEN.";
    case "model_unavailable":
      return `API Error: model is unavailable (${model}). Check ANTHROPIC_MODEL or /model.`;
    case "prompt_too_long":
      return "API Error: prompt is too long. Run /context or /compact, then retry.";
    case "request_too_large":
      return "API Error: request is too large. Remove large files or images from the request.";
    case "invalid_request":
      return `API Error: invalid request. ${detail}`;
    case "connection":
      return `API Error: connection failed. ${detail}`;
    case "server":
      return `API Error: server error. ${detail}`;
    case "aborted":
      return "Request interrupted.";
    case "unknown":
      return `API Error: ${detail}`;
  }
}
```

注意：这里提示 `ANTHROPIC_AUTH_TOKEN`，但不打印它的值。

真实工程里对 OAuth、订阅限流、图片/PDF、远端环境等场景有更细的文案。Mini 先保持简洁。

## 第四步：实现可取消 sleep

创建 `src/llm/retry.ts`：

```ts
import { classifyApiError } from "./apiErrors";

export type RetryEvent = {
  kind: "retry";
  errorKind: string;
  attempt: number;
  maxRetries: number;
  retryInMs: number;
};

export type RetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (event: RetryEvent) => void;
};

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 32_000;

export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly attempts: number,
  ) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
    this.name = "CannotRetryError";
  }
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new DOMException("Request aborted", "AbortError");
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Request aborted", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
```

`sleep()` 必须支持 abort。否则用户按下中断后，程序还会傻等到退避时间结束。

## 第五步：实现退避算法

继续写 `src/llm/retry.ts`：

```ts
export function getRetryDelayMs(
  attempt: number,
  retryAfterMs: number | undefined,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number {
  if (retryAfterMs !== undefined) {
    return retryAfterMs;
  }

  const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  const jitter = Math.random() * 0.25 * exponential;
  return Math.round(exponential + jitter);
}
```

为什么要 jitter？

如果很多客户端在同一秒收到 429，然后都严格等待 1 秒、2 秒、4 秒，它们会一起冲回去。加一点随机抖动可以降低同步重试带来的尖峰。

## 第六步：实现 `withRetry`

继续写 `src/llm/retry.ts`：

```ts
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new DOMException("Request aborted", "AbortError");
    }

    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const classified = classifyApiError(error);

      if (!classified.retryable || attempt > maxRetries) {
        throw new CannotRetryError(error, attempt);
      }

      const retryInMs = getRetryDelayMs(
        attempt,
        classified.retryAfterMs,
        baseDelayMs,
        maxDelayMs,
      );

      options.onRetry?.({
        kind: "retry",
        errorKind: classified.kind,
        attempt,
        maxRetries,
        retryInMs,
      });

      await sleep(retryInMs, options.signal);
    }
  }

  throw new CannotRetryError(lastError, maxRetries + 1);
}
```

这段代码只做重试，不关心模型 fallback，也不关心最终用户文案。

## 第七步：定义 fallback 策略

创建 `src/llm/fallback.ts`：

```ts
import { classifyApiError } from "./apiErrors";

export type ModelFallbackEvent = {
  kind: "model_fallback";
  from: string;
  to: string;
  reason: string;
};

export type StreamingFallbackEvent = {
  kind: "streaming_fallback";
  reason: string;
};

export type FallbackEvent = ModelFallbackEvent | StreamingFallbackEvent;

export function shouldFallbackModel(error: unknown): boolean {
  const classified = classifyApiError(error);
  return classified.kind === "overloaded" || classified.kind === "rate_limit";
}

export function shouldFallbackToNonStreaming(error: unknown): boolean {
  const classified = classifyApiError(error);

  if (classified.kind === "aborted") {
    return false;
  }

  if (classified.status === 404) {
    return true;
  }

  return classified.kind === "connection" || classified.kind === "timeout";
}
```

这里的策略很保守：

- 用户主动中断不 fallback。
- stream endpoint 404 可以非流式 fallback。
- 网络和超时可以非流式 fallback。
- rate limit 和 overloaded 可以模型 fallback。

不要对 400 invalid request 做 fallback。请求格式错了，换请求模式或换模型通常只会掩盖问题。

## 第八步：扩展模型配置

第二十章的 `ModelConfig` 增加 fallback model。

修改 `src/models/types.ts`：

```ts
export type ModelConfig = {
  provider: ModelProvider;
  baseUrl?: string;
  authToken?: string;
  authTokenEnv: "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";
  mainModel: string;
  fastModel?: string;
  plannerModel?: string;
  compactModel?: string;
  pluginModel?: string;
  largeContextModel?: string;
  fallbackModel?: string;
};
```

修改 `src/models/config.ts`：

```ts
return {
  provider: "anthropic-compatible",
  baseUrl: readEnv("ANTHROPIC_BASE_URL") ?? DEFAULT_BASE_URL,
  authToken,
  authTokenEnv,
  mainModel,
  fastModel: readEnv("CCMINI_MODEL_FAST"),
  plannerModel: readEnv("CCMINI_MODEL_PLANNER"),
  compactModel: readEnv("CCMINI_MODEL_COMPACT"),
  pluginModel: readEnv("CCMINI_MODEL_PLUGIN"),
  largeContextModel: readEnv("CCMINI_MODEL_LARGE_CONTEXT"),
  fallbackModel: readEnv("CCMINI_MODEL_FALLBACK"),
};
```

配置方式：

```bash
export CCMINI_MODEL_FALLBACK="deepseek-v4-flash"
```

当前你可能主模型和 fallback 模型相同。没关系，这一章主要搭容错结构。以后你可以把 fallback 指向另一个可用模型。

## 第九步：实现带容错的请求入口

创建 `src/llm/resilientAnthropic.ts`：

```ts
import Anthropic from "@anthropic-ai/sdk";
import { toUserFacingApiError } from "./apiErrors";
import {
  type FallbackEvent,
  shouldFallbackModel,
  shouldFallbackToNonStreaming,
} from "./fallback";
import { CannotRetryError, type RetryEvent, withRetry } from "./retry";
import { assertModelConfig } from "../models/config";
import { modelRouter } from "../models/router";
import type { ModelRouteRequest } from "../models/types";
import type { ChatMessage } from "./types";

export type ResilientLlmRequest = {
  route: ModelRouteRequest;
  system: string;
  messages: ChatMessage[];
  tools?: unknown[];
  stream?: boolean;
  signal?: AbortSignal;
  onRetry?: (event: RetryEvent) => void;
  onFallback?: (event: FallbackEvent) => void;
};

type RequestAttempt = ResilientLlmRequest & {
  overrideModel?: string;
  usedModelFallback?: boolean;
};
```

这里暴露两个事件：

- `onRetry`：告诉 UI 正在等待重试。
- `onFallback`：告诉 UI 切换了请求策略。

业务层可以展示事件，但不需要自己决定策略。

## 第十步：实现非流式请求

继续写 `src/llm/resilientAnthropic.ts`：

```ts
function createClient(): Anthropic {
  const config = modelRouter.getConfig();
  assertModelConfig(config);

  return new Anthropic({
    apiKey: config.authToken,
    baseURL: config.baseUrl,
  });
}

async function createMessageOnce(request: RequestAttempt): Promise<string> {
  const route = modelRouter.resolve({
    ...request.route,
    commandModel: request.overrideModel ?? request.route.commandModel,
  });
  const client = createClient();

  const response = await client.messages.create(
    {
      model: route.model,
      max_tokens: route.capability.maxOutputTokens,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
    },
    {
      signal: request.signal,
    },
  );

  return response.content
    .map(block => (block.type === "text" ? block.text : ""))
    .join("");
}
```

这就是最普通的请求。容错不写在这里，避免单次请求函数变复杂。

## 第十一步：实现 streaming 请求

继续写：

```ts
async function streamMessageOnce(request: RequestAttempt): Promise<string> {
  const route = modelRouter.resolve({
    ...request.route,
    commandModel: request.overrideModel ?? request.route.commandModel,
  });
  const client = createClient();
  const chunks: string[] = [];

  const stream = client.messages.stream(
    {
      model: route.model,
      max_tokens: route.capability.maxOutputTokens,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
    },
    {
      signal: request.signal,
    },
  );

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      chunks.push(event.delta.text);
    }
  }

  return chunks.join("");
}
```

Mini 这里把 stream 收集成完整文本返回，是为了让课程代码更简单。如果你的 REPL 已经可以实时渲染 token，可以把这个函数改成 async generator，但容错边界不变。

## 第十二步：组合 retry、streaming fallback、model fallback

继续写：

```ts
export async function createResilientMessage(
  request: ResilientLlmRequest,
): Promise<string> {
  return createResilientMessageAttempt(request, {
    ...request,
    usedModelFallback: false,
  });
}

async function createResilientMessageAttempt(
  original: ResilientLlmRequest,
  attemptRequest: RequestAttempt,
): Promise<string> {
  const route = modelRouter.resolve({
    ...attemptRequest.route,
    commandModel: attemptRequest.overrideModel ?? attemptRequest.route.commandModel,
  });

  try {
    return await withRetry(
      async () => {
        if (!attemptRequest.stream) {
          return createMessageOnce(attemptRequest);
        }

        try {
          return await streamMessageOnce(attemptRequest);
        } catch (error) {
          if (!shouldFallbackToNonStreaming(error)) {
            throw error;
          }

          original.onFallback?.({
            kind: "streaming_fallback",
            reason: "streaming request failed; retrying once without streaming",
          });

          return createMessageOnce({
            ...attemptRequest,
            stream: false,
          });
        }
      },
      {
        signal: original.signal,
        onRetry: original.onRetry,
      },
    );
  } catch (error) {
    const originalError =
      error instanceof CannotRetryError ? error.originalError : error;

    const config = modelRouter.getConfig();
    if (
      config.fallbackModel &&
      !attemptRequest.usedModelFallback &&
      shouldFallbackModel(originalError)
    ) {
      original.onFallback?.({
        kind: "model_fallback",
        from: route.model,
        to: config.fallbackModel,
        reason: "capacity or rate limit error",
      });

      return createResilientMessageAttempt(original, {
        ...attemptRequest,
        overrideModel: config.fallbackModel,
        usedModelFallback: true,
      });
    }

    throw new Error(toUserFacingApiError(originalError, route.model));
  }
}
```

这里有三个关键点：

1. streaming fallback 只在单次 attempt 内发生。
2. model fallback 会重跑完整请求。
3. model fallback 只允许一次，避免两个模型之间来回跳。

真实工程里 `query.ts` 会清理 assistant/tool 中间状态。Mini 如果当前工具是在完整消息后才执行，清理工作会少很多。

## 第十三步：AgentLoop 接入 retry/fallback 事件

主循环调用从旧的 `createMessage()` 改成 `createResilientMessage()`。

```ts
const answer = await createResilientMessage({
  route: {
    role: "main",
    permissionMode: state.permissionMode,
    contextTokens: preparedContext.estimatedTokens,
  },
  system: preparedContext.system,
  messages: preparedContext.messages,
  tools: toolRegistry.toAnthropicTools(),
  stream: true,
  signal,
  onRetry(event) {
    ui.addSystemMessage(
      `API retry: ${event.errorKind}, attempt ${event.attempt}/${event.maxRetries}, retrying in ${event.retryInMs}ms`,
    );
  },
  onFallback(event) {
    if (event.kind === "model_fallback") {
      ui.addSystemMessage(`Model fallback: ${event.from} -> ${event.to}`);
      return;
    }

    ui.addSystemMessage("Streaming fallback: switching to non-streaming request");
  },
});
```

如果你的 Mini 还没有 UI event 系统，可以先把这些事件写进普通 system message 数组，或者在交互模式下打印。

不要把 retry 事件作为 user/assistant 历史发给模型。它是运行时状态，不是对话内容。

## 第十四步：Planner、Compactor、Plugin 接入

Planner：

```ts
const plan = await createResilientMessage({
  route: {
    role: "planner",
    permissionMode: "plan",
    contextTokens: context.estimatedTokens,
  },
  system: plannerSystemPrompt,
  messages: [{ role: "user", content: userGoal }],
  stream: false,
  signal,
});
```

Compactor：

```ts
const summary = await createResilientMessage({
  route: {
    role: "compact",
    contextTokens: context.estimatedTokens,
  },
  system: compactSystemPrompt,
  messages: [{ role: "user", content: transcript }],
  stream: false,
  signal,
});
```

Plugin command：

```ts
const output = await createResilientMessage({
  route: {
    role: "plugin",
    commandModel: command.model,
    contextTokens: context.estimatedTokens,
  },
  system: pluginCommandSystemPrompt,
  messages: [{ role: "user", content: renderedPrompt }],
  tools: toolRegistry.toAnthropicTools(),
  stream: true,
  signal,
});
```

这三个调用点都不需要关心 429、529、timeout、fallback。这就是本章的价值。

## 第十五步：不要重试这些错误

Mini 应该直接失败并展示用户提示：

| 错误 | 原因 |
|------|------|
| 400 invalid request | 请求格式错，重试无意义 |
| 401/403 auth | 配置或权限问题，重试通常无意义 |
| 404 model unavailable | 模型名或部署权限问题 |
| prompt too long | 需要裁剪或 compact |
| request too large | 需要减少文件、图片或附件 |
| user abort | 用户明确中断 |

应该重试：

| 错误 | 原因 |
|------|------|
| 408 timeout | 临时超时 |
| 409 lock timeout | 服务端临时锁 |
| 429 rate limit | 可能有 `retry-after` |
| 529 overloaded | 容量临时不足 |
| 5xx | 服务端临时错误 |
| connection error | 网络或代理临时故障 |

这一组规则和真实工程不完全相同，但足够支撑 Mini。

## 第十六步：测试错误分类

创建 `src/llm/__tests__/apiErrors.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import {
  classifyApiError,
  redactApiErrorMessage,
  toUserFacingApiError,
} from "../apiErrors";

describe("classifyApiError", () => {
  test("classifies 429 as retryable rate limit", () => {
    const error = {
      status: 429,
      message: "rate limited",
      headers: {
        "retry-after": "2",
      },
    };

    const classified = classifyApiError(error);

    expect(classified.kind).toBe("rate_limit");
    expect(classified.retryable).toBe(true);
    expect(classified.retryAfterMs).toBe(2000);
  });

  test("classifies 529 as overloaded", () => {
    const classified = classifyApiError({
      status: 529,
      message: "overloaded_error",
    });

    expect(classified.kind).toBe("overloaded");
    expect(classified.retryable).toBe(true);
  });

  test("does not retry auth errors", () => {
    const classified = classifyApiError({
      status: 401,
      message: "invalid x-api-key",
    });

    expect(classified.kind).toBe("auth");
    expect(classified.retryable).toBe(false);
  });

  test("redacts token-like text", () => {
    const redacted = redactApiErrorMessage("bad key sk-test123");

    expect(redacted).not.toContain("sk-test123");
    expect(redacted).toContain("[redacted]");
  });

  test("user-facing auth error does not include raw detail", () => {
    const message = toUserFacingApiError(
      {
        status: 401,
        message: "invalid x-api-key sk-test123",
      },
      "deepseek-v4-flash",
    );

    expect(message).toBe("API Error: authentication failed. Check ANTHROPIC_AUTH_TOKEN.");
  });
});
```

## 第十七步：测试 retry

创建 `src/llm/__tests__/retry.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { CannotRetryError, getRetryDelayMs, withRetry } from "../retry";

describe("withRetry", () => {
  test("retries transient errors and returns success", async () => {
    let calls = 0;

    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 2) {
          throw { status: 500, message: "server error" };
        }
        return "ok";
      },
      {
        baseDelayMs: 1,
      },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  test("does not retry invalid request", async () => {
    let calls = 0;

    await expect(
      withRetry(async () => {
        calls++;
        throw { status: 400, message: "bad request" };
      }),
    ).rejects.toBeInstanceOf(CannotRetryError);

    expect(calls).toBe(1);
  });

  test("uses retry-after before exponential delay", () => {
    expect(getRetryDelayMs(3, 2000)).toBe(2000);
  });

  test("emits retry events", async () => {
    const events: unknown[] = [];
    let calls = 0;

    await withRetry(
      async () => {
        calls++;
        if (calls === 1) {
          throw { status: 500, message: "server error" };
        }
        return "ok";
      },
      {
        baseDelayMs: 1,
        onRetry(event) {
          events.push(event);
        },
      },
    );

    expect(events).toHaveLength(1);
  });
});
```

测试里把 `baseDelayMs` 设得很小，避免单测慢。

## 第十八步：测试 resilient client

创建 `src/llm/__tests__/resilientAnthropic.test.ts`。真实 SDK 比较重，建议把底层 request function 抽成可注入依赖。

先调整 `resilientAnthropic.ts`，导出一个内部测试友好的函数：

```ts
export type RequestFns = {
  create: (request: RequestAttempt) => Promise<string>;
  stream: (request: RequestAttempt) => Promise<string>;
};

export async function createResilientMessageWithFns(
  request: ResilientLlmRequest,
  fns: RequestFns,
): Promise<string> {
  return createResilientMessageAttempt(
    request,
    {
      ...request,
      usedModelFallback: false,
    },
    fns,
  );
}
```

然后把内部调用从固定函数改成依赖：

```ts
const fns = {
  create: createMessageOnce,
  stream: streamMessageOnce,
};
```

测试：

```ts
import { describe, expect, test } from "bun:test";
import { createResilientMessageWithFns } from "../resilientAnthropic";

const baseRequest = {
  route: { role: "main" as const },
  system: "You are Mini.",
  messages: [{ role: "user" as const, content: "hi" }],
};

describe("createResilientMessageWithFns", () => {
  test("falls back from streaming to non-streaming", async () => {
    const events: unknown[] = [];

    const result = await createResilientMessageWithFns(
      {
        ...baseRequest,
        stream: true,
        onFallback(event) {
          events.push(event);
        },
      },
      {
        stream: async () => {
          throw { status: 404, message: "stream not found" };
        },
        create: async () => "ok",
      },
    );

    expect(result).toBe("ok");
    expect(events).toEqual([
      {
        kind: "streaming_fallback",
        reason: "streaming request failed; retrying once without streaming",
      },
    ]);
  });
});
```

如果你觉得注入依赖会让课程代码偏长，也可以只测试 `fallback.ts` 的策略函数。本章重点是让容错逻辑可测，不要真的打 API。

## 第十九步：运行验证

运行本章新增测试：

```bash
bun test src/llm/__tests__/apiErrors.test.ts
bun test src/llm/__tests__/retry.test.ts
bun test src/llm/__tests__/resilientAnthropic.test.ts
```

运行类型检查：

```bash
bun run typecheck
```

如果你把 `resilientAnthropic.ts` 接入了真实 AgentLoop，再跑一个最小 pipe 模式：

```bash
echo "say hello" | bun run src/entrypoints/cli.tsx -p
```

## 常见问题

### 为什么不让 SDK 自己重试

SDK 的重试只能看到单次 HTTP 请求。Coding Agent 还需要处理更高层的状态：

- streaming 失败后是否切非流式。
- 连续 overloaded 后是否切模型。
- fallback 后是否清理 partial assistant message。
- 是否向 UI 展示 retry 事件。
- 是否防止工具重复执行。

这些都属于 Agent runtime，不适合完全交给 SDK。

### streaming fallback 会不会重复执行工具

取决于你的工具执行时机。

如果 Mini 只在完整 assistant message 结束后执行工具，streaming fallback 是安全的。因为失败的 streaming attempt 没有触发工具执行。

如果你已经实现“边收到 tool_use 边执行工具”，fallback 前必须丢弃失败 attempt 的工具执行器，并取消正在运行的工具。真实工程的 `StreamingToolExecutor.discard()` 就是为了解决这个问题。

### 为什么 model fallback 要重跑整次请求

因为半条 response 不可靠：

- tool_use 可能只收到一半。
- thinking / redacted_thinking block 可能绑定模型签名。
- request id 和 usage 不完整。
- 已经开始的工具结果不能直接接到另一个模型的 response 后面。

所以模型 fallback 必须从同一份输入消息重新请求。

### 为什么不重试 prompt too long

prompt too long 不是临时错误。它需要上下文裁剪、compact 或减少输入。盲目重试只会浪费请求。

第十八章已经实现了上下文预算，本章只负责把最终错误变成清晰提示。

### DeepSeek 的 Anthropic-compatible endpoint 也适用吗

适用。因为本章的容错层包在 `@anthropic-ai/sdk` 调用外面。只要错误对象里有 `status`、`message`、`headers` 这些字段，分类和重试策略就能工作。

不同 provider 的错误格式可能略有差异，所以 `apiErrors.ts` 用 duck typing，不强依赖具体 SDK class。

## 本章检查清单

完成后确认：

1. 所有 LLM 请求都走 `createResilientMessage()`。
2. 429、529、5xx、连接错误会重试。
3. 400、401、403、404、prompt too long 不盲目重试。
4. `retry-after` 被优先使用。
5. 用户 abort 能中断 sleep。
6. streaming 失败可以 fallback 到非流式。
7. 模型 fallback 最多触发一次。
8. 最终错误消息不包含 token。
9. AgentLoop 只消费 retry/fallback 事件，不自己判断错误类型。

验证命令：

```bash
bun test src/llm/__tests__/apiErrors.test.ts
bun test src/llm/__tests__/retry.test.ts
bun test src/llm/__tests__/resilientAnthropic.test.ts
bun run typecheck
```

## 小结

本章给 Mini 加了 API 请求容错层：

- `apiErrors.ts` 负责错误分类和用户文案。
- `retry.ts` 负责 transient error 的等待和重试。
- `fallback.ts` 负责是否切模型、是否切非流式。
- `resilientAnthropic.ts` 把这些策略包到 SDK 请求外面。

到这里，Mini 的模型层已经具备三块关键能力：能接入 DeepSeek Anthropic-compatible endpoint，能按任务角色路由模型，也能在请求失败时做可控恢复。

下一章可以继续把这些运行时事件沉淀下来：实现日志、调试模式和 transcript 中的 API 事件记录，方便定位失败和复盘会话。
