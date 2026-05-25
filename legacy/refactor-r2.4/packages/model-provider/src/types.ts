import type { ContentBlock, QueryEvent, Usage } from '@my-claude-code/core'

export type ProviderName = 'deepseek' | (string & {})

export type ProviderTool = {
  name: string
  description?: string
  input_schema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
}

export type ProviderMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentBlock[]
}

export type ToolChoice =
  | { type: 'auto' }
  | { type: 'none' }
  | { type: 'tool'; name: string }

export type ProviderRequest = {
  model: string
  messages: ProviderMessage[]
  tools?: ProviderTool[]
  toolChoice?: ToolChoice
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  apiKey?: string
  cachePolicy?: {
    break?: boolean
    reason?: string
  }
}

export type ProviderModelCapabilities = {
  provider: ProviderName
  model: string
  aliases: string[]
  displayName?: string
  contextWindowTokens: number
  maxOutputTokens: number
  supportsTextStreaming: boolean
  supportsToolCallDelta: boolean
  supportsThinking: boolean
  supportsUsageMapping: boolean
  supportsPromptCache: boolean
  supportsSystemMessages: boolean
  supportsTools: boolean
}

export type ProviderRateLimit = {
  windowMs: number
  requestLimit?: number
  tokenLimit?: number
}

export type ProviderMetadata = {
  name: ProviderName
  defaultModel: string
  apiKeyEnvVar: string
  displayName?: string
  baseUrl?: string
  models?: ProviderModelCapabilities[]
  rateLimit?: ProviderRateLimit
}

export type ProviderCompatibilityResult = {
  provider: ProviderName
  model: string
  supportsTextStreaming: boolean
  supportsToolCallDelta: boolean
  supportsUsageMapping: boolean
  requiresPromptWrappedToolCalls: boolean
  notes: string[]
}

export interface ModelProvider {
  metadata: ProviderMetadata
  stream(request: ProviderRequest): AsyncIterable<QueryEvent>
}

export type UsageMapper = (usage: unknown) => Usage | undefined

export type ProviderRegistration = ModelProvider

export type ResolvedProviderModel = {
  provider: ProviderName
  requestedModel: string
  model: string
  capabilities: ProviderModelCapabilities
  registration: ProviderRegistration
}

export type ProviderUsageTotals = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  totalTokens: number
  requestCount: number
}

export type ProviderBalanceSnapshot = {
  provider: ProviderName
  windowMs: number
  resetAt: string
  requestLimit?: number
  requestsUsed: number
  requestsRemaining?: number
  tokenLimit?: number
  tokensUsed: number
  tokensRemaining?: number
  limited: boolean
}

export type ProviderErrorKind =
  | 'rate_limit'
  | 'authentication'
  | 'balance_exhausted'
  | 'context_length'
  | 'abort'
  | 'network'
  | 'provider'
  | 'unknown'

export type ProviderErrorInfo = {
  provider?: ProviderName
  model?: string
  kind: ProviderErrorKind
  retryable: boolean
  message: string
  status?: number
}

export type ProviderCacheBreak = {
  provider: ProviderName
  model: string
  reason: 'explicit' | 'cache_read_dropped'
  previousCacheReadInputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens?: number
}

export type ProviderRuntimeSnapshot = {
  providers: Array<{
    name: ProviderName
    displayName?: string
    defaultModel: string
    apiKeyEnvVar: string
    baseUrl?: string
    models: ProviderModelCapabilities[]
    rateLimit?: ProviderRateLimit
    apiKeyConfigured: boolean
  }>
  usage: ProviderUsageTotals
  balances: ProviderBalanceSnapshot[]
  errors: ProviderErrorInfo[]
  cacheBreaks: ProviderCacheBreak[]
}
