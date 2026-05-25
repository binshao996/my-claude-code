export {
  kickBridge,
  readBridgeEvents,
  startRemoteControlServer,
  triggerRemote,
  type BridgeEvent,
  type BridgeEventType,
  type RemoteControlServerHandle,
} from '../../packages/tools/src/remote.js'

export const bridgeMirror = {
  upstream: 'claude-code/src/bridge',
  local: 'packages/tools/src/remote.ts',
  status: 'r1.9-remote-bridge-daemon-acp-mirror',
  golden: 'docs/refactor/golden/transports/r1.9-remote-bridge-acp-golden.json',
} as const
