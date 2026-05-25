export {
  discoverExtensionRegistry,
  installMarketplacePlugin,
  loadPlugins,
  readPluginInstallState,
  readPluginMarketplace,
  reconcilePluginMarketplace,
  setPluginEnabled,
  updateMarketplacePlugin,
  type PluginDescriptor,
  type PluginInstallState,
  type PluginLifecycleResult,
  type PluginManifest,
  type PluginMarketplaceEntry,
} from '../../packages/tools/src/extensions.js'

export const pluginsMirror = {
  upstream: 'claude-code/src/plugins',
  local: 'packages/tools/src/extensions.ts',
  status: 'r1.8-mcp-oauth-plugin-skill-mirror',
  golden: 'docs/refactor/golden/runtime/r1.8-extension-ecosystem-golden.json',
} as const
