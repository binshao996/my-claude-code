export {
  ModelProviderRuntime,
  ProviderRegistry,
  ProviderRuntimeError,
  classifyProviderError,
  createDefaultProviderRegistry,
  createModelProviderRuntime,
  getDefaultProviderRuntime,
  resolveProviderModel,
} from '../../../packages/model-provider/src/providerRegistry.js'
export type {
  ProviderBalanceSnapshot,
  ProviderCacheBreak,
  ProviderErrorInfo,
  ProviderMetadata,
  ProviderModelCapabilities,
  ProviderName,
  ProviderRegistration,
  ProviderRequest,
  ProviderRuntimeSnapshot,
  ProviderTool,
  ProviderUsageTotals,
  ResolvedProviderModel,
  ToolChoice,
} from '../../../packages/model-provider/src/types.js'

export const providerRegistryMirror = {
  upstream: 'claude-code/src/services/providerRegistry',
  local: 'packages/model-provider/src/providerRegistry.ts',
  status: 'r1.6-provider-runtime-mirror',
  golden: 'docs/refactor/golden/runtime/r1.6-provider-runtime-golden.json',
} as const
