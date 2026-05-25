export {
  captureTerminal,
  connectRemote,
  detachRemote,
  readRemoteEnv,
  readRemoteSessions,
  resumeRemote,
  runRemoteCommand,
  setRemoteEnv,
  setupRemote,
  type RemoteCommandResult,
  type RemoteEnvRecord,
  type RemoteSession,
  type RemoteSetupReport,
  type RemoteTransport,
} from '../../packages/tools/src/remote.js'

export const remoteMirror = {
  upstream: 'claude-code/src/remote',
  local: 'packages/tools/src/remote.ts',
  status: 'r1.9-remote-bridge-daemon-acp-mirror',
  golden: 'docs/refactor/golden/transports/r1.9-remote-bridge-acp-golden.json',
} as const
