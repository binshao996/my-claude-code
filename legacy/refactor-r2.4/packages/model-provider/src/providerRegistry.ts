import type { QueryEvent, Usage } from '@my-claude-code/core'
import {
  DEFAULT_DEEPSEEK_MODEL,
  deepSeekMetadata,
  streamDeepSeekQuery,
} from './deepseek.js'
import type {
  ProviderBalanceSnapshot,
  ProviderCacheBreak,
  ProviderErrorInfo,
  ProviderMetadata,
  ProviderModelCapabilities,
  ProviderName,
  ProviderRateLimit,
  ProviderRegistration,
  ProviderRequest,
  ProviderRuntimeSnapshot,
  ProviderUsageTotals,
  ResolvedProviderModel,
} from './types.js'

const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000

type AliasTarget = {
  provider: ProviderName
  model: string
  capabilities: ProviderModelCapabilities
}

type ProviderWindowState = {
  startedAt: number
  requestsUsed: number
  tokensUsed: number
}

export class ProviderRegistry {
  private readonly providers = new Map<ProviderName, ProviderRegistration>()
  private readonly aliases = new Map<string, AliasTarget>()
  private defaultProvider: ProviderName | undefined

  constructor(registrations: ProviderRegistration[] = []) {
    for (const registration of registrations) {
      this.register(registration)
    }
  }

  register(registration: ProviderRegistration) {
    const provider = registration.metadata.name
    if (this.providers.has(provider)) {
      throw new Error(`provider already registered: ${provider}`)
    }

    this.providers.set(provider, registration)
    this.defaultProvider ??= provider

    for (const capabilities of providerModels(registration.metadata)) {
      const target = {
        provider,
        model: capabilities.model,
        capabilities,
      }
      for (const alias of [
        capabilities.model,
        `${provider}:${capabilities.model}`,
        ...capabilities.aliases,
      ]) {
        const key = normalizeModelKey(alias)
        const existing = this.aliases.get(key)
        if (existing) {
          throw new Error(
            `model alias collision: ${alias} maps to ${existing.provider}/${existing.model} and ${provider}/${capabilities.model}`,
          )
        }
        this.aliases.set(key, target)
      }
    }
  }

  resolve(model: string | undefined): ResolvedProviderModel {
    const requestedModel = model?.trim() || this.defaultModel()
    const target = this.aliases.get(normalizeModelKey(requestedModel))
    if (!target) {
      throw new Error(`unknown provider model or alias: ${requestedModel}`)
    }

    const registration = this.providers.get(target.provider)
    if (!registration) {
      throw new Error(`provider is not registered: ${target.provider}`)
    }

    return {
      provider: target.provider,
      requestedModel,
      model: target.model,
      capabilities: target.capabilities,
      registration,
    }
  }

  getProvider(provider: ProviderName): ProviderRegistration | undefined {
    return this.providers.get(provider)
  }

  listProviders(): ProviderRegistration[] {
    return [...this.providers.values()]
  }

  listModels(provider?: ProviderName): ProviderModelCapabilities[] {
    const registrations = provider
      ? [this.providers.get(provider)].filter(
          (registration): registration is ProviderRegistration =>
            registration !== undefined,
        )
      : this.listProviders()

    return registrations.flatMap(registration =>
      providerModels(registration.metadata),
    )
  }

  defaultModel(): string {
    const provider = this.defaultProvider
    if (!provider) {
      return DEFAULT_DEEPSEEK_MODEL
    }
    return this.providers.get(provider)?.metadata.defaultModel ?? DEFAULT_DEEPSEEK_MODEL
  }
}

export class ProviderRuntimeError extends Error {
  readonly info: ProviderErrorInfo

  constructor(info: ProviderErrorInfo) {
    super(info.message)
    this.name = 'ProviderRuntimeError'
    this.info = info
  }
}

export class ModelProviderRuntime {
  readonly registry: ProviderRegistry
  private readonly now: () => number
  private readonly usage = emptyUsageTotals()
  private readonly windows = new Map<ProviderName, ProviderWindowState>()
  private readonly errors: ProviderErrorInfo[] = []
  private readonly cacheBreaks: ProviderCacheBreak[] = []
  private previousCacheReadInputTokens = 0

  constructor(options: {
    registry?: ProviderRegistry
    now?: () => number
  } = {}) {
    this.registry = options.registry ?? createDefaultProviderRegistry()
    this.now = options.now ?? Date.now
  }

  async *stream(request: ProviderRequest): AsyncGenerator<QueryEvent, void> {
    const resolved = this.registry.resolve(request.model)
    const rateLimit = resolved.registration.metadata.rateLimit
    this.ensureRateLimitAvailable(resolved, rateLimit)

    if (request.cachePolicy?.break) {
      this.recordCacheBreak(resolved, {
        reason: 'explicit',
        usage: undefined,
      })
    }

    const requestUsage = emptyUsageTotals()
    try {
      for await (const event of resolved.registration.stream({
        ...request,
        model: resolved.model,
      })) {
        if (event.type === 'message_start') {
          mergeUsageMax(requestUsage, normalizeUsage(event.message.usage))
        }
        if (event.type === 'message_delta') {
          mergeUsageMax(requestUsage, normalizeUsage(event.usage))
        }
        if (event.type === 'error') {
          this.recordError({
            provider: resolved.provider,
            model: resolved.model,
            kind: 'provider',
            retryable: false,
            message: event.error.message,
          })
        }
        yield event
      }
    } catch (error) {
      const info = classifyProviderError(error, {
        provider: resolved.provider,
        model: resolved.model,
      })
      this.recordError(info)
      throw error
    } finally {
      this.recordUsage(resolved, requestUsage)
    }
  }

  snapshot(env: Record<string, string | undefined> = process.env): ProviderRuntimeSnapshot {
    return {
      providers: this.registry.listProviders().map(registration => ({
        name: registration.metadata.name,
        displayName: registration.metadata.displayName,
        defaultModel: registration.metadata.defaultModel,
        apiKeyEnvVar: registration.metadata.apiKeyEnvVar,
        baseUrl: registration.metadata.baseUrl,
        models: providerModels(registration.metadata),
        rateLimit: registration.metadata.rateLimit,
        apiKeyConfigured: Boolean(env[registration.metadata.apiKeyEnvVar]),
      })),
      usage: { ...this.usage },
      balances: this.registry.listProviders().map(registration =>
        this.balanceForProvider(registration.metadata.name, registration.metadata.rateLimit),
      ),
      errors: [...this.errors],
      cacheBreaks: [...this.cacheBreaks],
    }
  }

  reset() {
    Object.assign(this.usage, emptyUsageTotals())
    this.windows.clear()
    this.errors.length = 0
    this.cacheBreaks.length = 0
    this.previousCacheReadInputTokens = 0
  }

  private ensureRateLimitAvailable(
    resolved: ResolvedProviderModel,
    rateLimit: ProviderRateLimit | undefined,
  ) {
    if (!rateLimit) {
      return
    }

    const balance = this.balanceForProvider(resolved.provider, rateLimit)
    if (!balance.limited) {
      return
    }

    const info: ProviderErrorInfo = {
      provider: resolved.provider,
      model: resolved.model,
      kind: 'rate_limit',
      retryable: true,
      message: `provider rate limit exceeded for ${resolved.provider}; reset at ${balance.resetAt}`,
    }
    this.recordError(info)
    throw new ProviderRuntimeError(info)
  }

  private recordUsage(resolved: ResolvedProviderModel, usage: ProviderUsageTotals) {
    addUsageTotals(this.usage, usage)
    this.usage.requestCount += 1

    const window = this.windowForProvider(resolved.provider)
    window.requestsUsed += 1
    window.tokensUsed += usage.totalTokens

    if (usage.totalTokens === 0) {
      return
    }

    if (
      this.previousCacheReadInputTokens > 0 &&
      usage.cacheReadInputTokens === 0
    ) {
      this.recordCacheBreak(resolved, {
        reason: 'cache_read_dropped',
        usage,
      })
    }
    this.previousCacheReadInputTokens = usage.cacheReadInputTokens
  }

  private recordCacheBreak(
    resolved: ResolvedProviderModel,
    args: {
      reason: ProviderCacheBreak['reason']
      usage: ProviderUsageTotals | undefined
    },
  ) {
    this.cacheBreaks.push({
      provider: resolved.provider,
      model: resolved.model,
      reason: args.reason,
      previousCacheReadInputTokens: this.previousCacheReadInputTokens,
      cacheReadInputTokens: args.usage?.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: args.usage?.cacheCreationInputTokens,
    })
    if (args.reason === 'explicit') {
      this.previousCacheReadInputTokens = 0
    }
  }

  private recordError(info: ProviderErrorInfo) {
    this.errors.push(info)
  }

  private balanceForProvider(
    provider: ProviderName,
    rateLimit: ProviderRateLimit | undefined,
  ): ProviderBalanceSnapshot {
    const window = this.windowForProvider(provider)
    const windowMs = rateLimit?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS
    const resetAt = new Date(window.startedAt + windowMs).toISOString()
    const requestsRemaining =
      rateLimit?.requestLimit === undefined
        ? undefined
        : Math.max(0, rateLimit.requestLimit - window.requestsUsed)
    const tokensRemaining =
      rateLimit?.tokenLimit === undefined
        ? undefined
        : Math.max(0, rateLimit.tokenLimit - window.tokensUsed)

    return {
      provider,
      windowMs,
      resetAt,
      requestLimit: rateLimit?.requestLimit,
      requestsUsed: window.requestsUsed,
      requestsRemaining,
      tokenLimit: rateLimit?.tokenLimit,
      tokensUsed: window.tokensUsed,
      tokensRemaining,
      limited: requestsRemaining === 0 || tokensRemaining === 0,
    }
  }

  private windowForProvider(provider: ProviderName): ProviderWindowState {
    const existing = this.windows.get(provider)
    const metadata = this.registry.getProvider(provider)?.metadata
    const windowMs = metadata?.rateLimit?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS
    const now = this.now()
    if (existing && now - existing.startedAt < windowMs) {
      return existing
    }

    const next = {
      startedAt: now,
      requestsUsed: 0,
      tokensUsed: 0,
    }
    this.windows.set(provider, next)
    return next
  }
}

export function createDefaultProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    {
      metadata: deepSeekMetadata,
      stream: streamDeepSeekQuery,
    },
  ])
}

export function createModelProviderRuntime(options: {
  registry?: ProviderRegistry
  now?: () => number
} = {}): ModelProviderRuntime {
  return new ModelProviderRuntime(options)
}

const defaultProviderRuntime = createModelProviderRuntime()

export function getDefaultProviderRuntime(): ModelProviderRuntime {
  return defaultProviderRuntime
}

export function resolveProviderModel(
  model: string | undefined,
  registry = createDefaultProviderRegistry(),
): ResolvedProviderModel {
  return registry.resolve(model)
}

export function classifyProviderError(
  error: unknown,
  context: {
    provider?: ProviderName
    model?: string
  } = {},
): ProviderErrorInfo {
  const message = error instanceof Error ? error.message : String(error)
  const status = httpStatusFromMessage(message)
  const lower = message.toLowerCase()

  if (isAbortError(error) || lower.includes('abort')) {
    return { ...context, kind: 'abort', retryable: false, message, status }
  }
  if (status === 401 || status === 403 || lower.includes('api key')) {
    return { ...context, kind: 'authentication', retryable: false, message, status }
  }
  if (status === 402 || lower.includes('balance') || lower.includes('quota')) {
    return { ...context, kind: 'balance_exhausted', retryable: false, message, status }
  }
  if (status === 429 || lower.includes('rate limit')) {
    return { ...context, kind: 'rate_limit', retryable: true, message, status }
  }
  if (
    status === 413 ||
    lower.includes('context') ||
    lower.includes('too long')
  ) {
    return { ...context, kind: 'context_length', retryable: false, message, status }
  }
  if (status !== undefined && status >= 500) {
    return { ...context, kind: 'provider', retryable: true, message, status }
  }
  if (
    lower.includes('network') ||
    lower.includes('econnreset') ||
    lower.includes('fetch failed')
  ) {
    return { ...context, kind: 'network', retryable: true, message, status }
  }

  return { ...context, kind: 'unknown', retryable: false, message, status }
}

function providerModels(metadata: ProviderMetadata): ProviderModelCapabilities[] {
  if (metadata.models && metadata.models.length > 0) {
    return metadata.models
  }

  return [
    {
      provider: metadata.name,
      model: metadata.defaultModel,
      aliases: [metadata.name, 'default'],
      contextWindowTokens: 128_000,
      maxOutputTokens: 4_096,
      supportsTextStreaming: true,
      supportsToolCallDelta: false,
      supportsThinking: false,
      supportsUsageMapping: true,
      supportsPromptCache: false,
      supportsSystemMessages: true,
      supportsTools: true,
    },
  ]
}

function normalizeModelKey(model: string): string {
  return model.trim().toLowerCase()
}

function emptyUsageTotals(): ProviderUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
    requestCount: 0,
  }
}

function normalizeUsage(usage: Usage | undefined): ProviderUsageTotals {
  const inputTokens = usage?.input_tokens ?? 0
  const outputTokens = usage?.output_tokens ?? 0
  const cacheCreationInputTokens = usage?.cache_creation_input_tokens ?? 0
  const cacheReadInputTokens = usage?.cache_read_input_tokens ?? 0

  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens:
      inputTokens +
      outputTokens +
      cacheCreationInputTokens +
      cacheReadInputTokens,
    requestCount: 0,
  }
}

function mergeUsageMax(target: ProviderUsageTotals, source: ProviderUsageTotals) {
  target.inputTokens = Math.max(target.inputTokens, source.inputTokens)
  target.outputTokens = Math.max(target.outputTokens, source.outputTokens)
  target.cacheCreationInputTokens = Math.max(
    target.cacheCreationInputTokens,
    source.cacheCreationInputTokens,
  )
  target.cacheReadInputTokens = Math.max(
    target.cacheReadInputTokens,
    source.cacheReadInputTokens,
  )
  target.totalTokens =
    target.inputTokens +
    target.outputTokens +
    target.cacheCreationInputTokens +
    target.cacheReadInputTokens
}

function addUsageTotals(target: ProviderUsageTotals, source: ProviderUsageTotals) {
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.cacheCreationInputTokens += source.cacheCreationInputTokens
  target.cacheReadInputTokens += source.cacheReadInputTokens
  target.totalTokens += source.totalTokens
}

function httpStatusFromMessage(message: string): number | undefined {
  const match = /\bHTTP\s+(\d{3})\b/i.exec(message) ?? /\bstatus\s+(\d{3})\b/i.exec(message)
  if (!match) {
    return undefined
  }
  return Number.parseInt(match[1], 10)
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
