export {
  callLiveMcpTool,
  collectProjectMcpServerConfigs,
  discoverLiveMcpResources,
  discoverLiveMcpTools,
  getMcpServerConnectionStates,
  subscribeLiveMcpResource,
  type McpConnectionState,
  type McpDiscoveryOptions,
  type McpOAuthConfig,
  type McpOAuthRefreshRequest,
  type McpServerApprovalRequest,
  type McpServerConfig,
  type McpToolDescriptor,
  type McpTransportKind,
} from '../../../packages/mcp-client/src/index.js'

export const mcpServiceMirror = {
  upstream: 'claude-code/src/services/mcp',
  local: 'packages/mcp-client/src/index.ts',
  status: 'r1.8-mcp-oauth-plugin-skill-mirror',
  golden: 'docs/refactor/golden/runtime/r1.8-extension-ecosystem-golden.json',
} as const
