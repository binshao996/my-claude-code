export {
  acpLinkMirror,
  acpPermissionMessage,
  acpPromptMessage,
  acpResultMessage,
  acpSessionStartMessage,
  createAcpLinkSession,
  decodeAcpJsonl,
  encodeAcpJsonl,
  hashAcpSecret,
  type AcpLinkMessage,
  type AcpLinkSession,
} from '../../../packages/acp-link/src/index.js'

export const acpServiceMirror = {
  upstream: 'claude-code/src/services/acp',
  local: 'packages/acp-link/src/index.ts',
  status: 'r1.9-remote-bridge-daemon-acp-mirror',
  golden: 'docs/refactor/golden/transports/r1.9-remote-bridge-acp-golden.json',
} as const
