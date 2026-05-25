export {
  heartbeatDaemon,
  readDaemonState,
  startDaemon,
  stopDaemon,
  type DaemonState,
  type DaemonStatus,
} from '../../packages/tools/src/remote.js'

export const daemonMirror = {
  upstream: 'claude-code/src/daemon',
  local: 'packages/tools/src/remote.ts',
  status: 'r1.9-remote-bridge-daemon-acp-mirror',
  golden: 'docs/refactor/golden/transports/r1.9-remote-bridge-acp-golden.json',
} as const
