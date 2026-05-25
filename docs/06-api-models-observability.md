# 06. API、模型与可观测性

## API 调用层

主要源码：

- `src/services/api/claude.ts`
- `src/services/api/client.ts`
- `src/query/deps.ts`
- `src/services/api/withRetry.ts`
- `packages/@ant/model-provider/*`

`query.ts` 不直接绑死某个 SDK，而是通过 `query/deps.ts` 注入 `callModel`、`autocompact`、`microcompact` 等依赖。生产依赖最终进入 `services/api/claude.ts` 或 provider 适配。

## Streaming

模型响应以流式事件进入 agent loop：

- text delta
- thinking/redacted thinking
- content block start/stop
- tool_use block
- message stop
- API error

`queryLoop()` 在流式过程中既要 yield 给 UI/SDK，又要收集 assistant messages 和 tool_use blocks，还可能启动 `StreamingToolExecutor` 提前执行工具。

## Provider 与模型

源码支持多种 provider/模型相关能力：

- Anthropic first-party。
- AWS Bedrock。
- Google Vertex。
- OpenAI/Gemini/Grok 等 provider 适配。
- model aliases、capabilities、context window。
- fallback model。
- fast mode。
- thinking config。
- advisor model。
- beta headers。

关键源码：

- `src/utils/model/*`
- `src/utils/model/providers.ts`
- `src/services/api/claude.ts`
- `packages/@ant/model-provider/src/*`

## Retry 与 fallback

`services/api/withRetry.ts` 是关键稳定性模块：

- 429/529 retry。
- stale connection 恢复。
- OAuth/token refresh。
- max_tokens/context 相关调整。
- fallback model 触发。
- fast mode fallback。

`queryLoop()` 还会处理 fallback 后已经 yield 的 partial message，发 tombstone 清理 UI 和 transcript，避免坏的 tool_use_id 残留。

## Prompt cache

Claude Code 非常重视 prompt cache：

- system prompt 有静态/动态边界。
- built-in tools 和 MCP tools 排序要保持稳定。
- tool input backfill 不修改 API-bound 原始 input，避免破坏 cache。
- cached microcompact 使用 API 报告的 cache deleted tokens 生成边界消息。

相关源码：

- `src/constants/prompts.ts`
- `src/utils/api.ts`
- `src/tools.ts`
- `src/query.ts`
- `src/services/compact/cachedMicrocompact.ts`

## 额度、成本和 token

相关能力：

- token estimation。
- context window 判断。
- output token budget。
- API task budget。
- usage/cost display。
- Claude AI limits / policy limits。
- rate limit warning。

关键源码：

- `src/utils/tokens.ts`
- `src/utils/context.ts`
- `src/query/tokenBudget.ts`
- `src/services/claudeAiLimits.ts`
- `src/services/policyLimits/*`
- `src/services/providerUsage/*`
- `src/commands/usage/*`

## Telemetry 和 tracing

Claude Code 源码里有多套可观测性：

- startup profiler。
- query profiler。
- Langfuse trace/span。
- OpenTelemetry events。
- Sentry error boundary。
- analytics/GrowthBook。
- plugin telemetry。
- skill loaded telemetry。
- internal logging / debug logging。

关键源码：

- `src/services/langfuse/*`
- `src/services/analytics/*`
- `src/utils/telemetry/*`
- `src/utils/startupProfiler.ts`
- `src/utils/queryProfiler.ts`
- `src/components/SentryErrorBoundary.tsx`

实现注意：这些能力不应和核心逻辑强耦合。源码用 feature flags、依赖注入和 fire-and-forget 方式降低主链路阻塞。

## Auth

认证不只是 API key：

- Claude AI OAuth。
- Console/API key。
- Bedrock/GCP credential。
- workspace key。
- MCP OAuth。
- bridge access token。
- keychain prefetch。

关键源码：

- `src/utils/auth.ts`
- `src/services/auth/*`
- `src/services/oauth/*`
- `src/services/mcp/auth.ts`
- `src/commands/login/*`

## 重新实现建议

优先实现顺序：

1. 定义 provider-neutral streaming event。
2. 实现 Anthropic 或 OpenAI-compatible 单 provider。
3. `withRetry` 先覆盖 abort、429、prompt too long、fallback。
4. 独立 token estimation/context window。
5. 再加入 usage/cost、telemetry、provider registry。

不要把 provider SDK 调用散落在 TUI 或工具中，必须集中在 API layer。
