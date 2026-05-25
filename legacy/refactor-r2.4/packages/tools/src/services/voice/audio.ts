import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  isNativeAudioAvailable,
  microphoneAuthorizationStatus,
  startNativeRecording,
  stopNativeRecording,
} from 'audio-capture-napi'

const SAMPLE_RATE = 16_000
const CHANNELS = 1

export type VoiceProvider = 'anthropic' | 'doubao' | 'deepseek'
export { connectVoiceStream } from './stream.js'
export type {
  ConnectVoiceStreamOptions,
  VoiceStreamConnection,
  VoiceStreamEvent,
} from './stream.js'

export type VoiceAvailability = {
  available: boolean
  backend: 'native' | 'arecord' | 'sox' | 'unavailable'
  permission: 'authorized' | 'denied' | 'not_determined' | 'unknown'
  reason?: string
  installCommand?: string
}

export type VoiceRecordingSession = {
  id: string
  backend: 'native' | 'arecord' | 'sox'
  status: 'recording' | 'stopped'
  sampleRate: number
  channels: number
  rawPath: string
  startedAt: string
  stoppedAt?: string
  bytes: number
  error?: string
}

type ActiveRecording = {
  session: VoiceRecordingSession
  child?: ChildProcessWithoutNullStreams
}

const activeRecordings = new Map<string, ActiveRecording>()

export async function checkVoiceAvailability(): Promise<VoiceAvailability> {
  const permission = readMicrophonePermission()
  if (permission === 'denied') {
    return {
      available: false,
      backend: 'unavailable',
      permission,
      reason: microphoneSettingsGuidance(),
    }
  }
  if (isNativeAudioAvailable()) {
    return { available: true, backend: 'native', permission }
  }
  if (process.platform === 'linux' && hasCommand('arecord')) {
    const probe = await probeArecord()
    if (probe.ok) {
      return { available: true, backend: 'arecord', permission }
    }
    return {
      available: false,
      backend: 'unavailable',
      permission,
      reason: probe.stderr || 'arecord could not open an audio input device',
      installCommand: installCommandForPlatform(),
    }
  }
  if (process.platform !== 'win32' && hasCommand('rec')) {
    return { available: true, backend: 'sox', permission }
  }
  return {
    available: false,
    backend: 'unavailable',
    permission,
    reason: 'No native audio backend, arecord, or SoX rec command is available.',
    installCommand: installCommandForPlatform(),
  }
}

export async function startVoiceRecording(
  cwd: string,
  options: { sessionId?: string } = {},
): Promise<VoiceRecordingSession> {
  const availability = await checkVoiceAvailability()
  if (!availability.available || availability.backend === 'unavailable') {
    throw new Error(availability.reason ?? 'Voice recording is not available')
  }
  const id = options.sessionId ?? `voice_${Date.now()}`
  const rawPath = join(cwd, '.my-claude-code', 'voice', `${id}.s16le`)
  await mkdir(dirname(rawPath), { recursive: true })
  await writeFile(rawPath, '')
  const session: VoiceRecordingSession = {
    id,
    backend: availability.backend,
    status: 'recording',
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    rawPath,
    startedAt: new Date().toISOString(),
    bytes: 0,
  }

  if (availability.backend === 'native') {
    const ok = startNativeRecording(chunk => {
      session.bytes += chunk.length
      void appendAudio(rawPath, chunk)
    }, () => {
      session.status = 'stopped'
      session.stoppedAt ??= new Date().toISOString()
    })
    if (!ok) {
      throw new Error('Native audio backend refused to start recording')
    }
    activeRecordings.set(id, { session })
    return session
  }

  const child = availability.backend === 'arecord'
    ? spawn('arecord', ['-f', 'S16_LE', '-r', String(SAMPLE_RATE), '-c', String(CHANNELS), '-t', 'raw', rawPath])
    : spawn('rec', ['-q', '-b', '16', '-e', 'signed-integer', '-r', String(SAMPLE_RATE), '-c', String(CHANNELS), rawPath])

  child.stderr.on('data', chunk => {
    session.error = `${session.error ?? ''}${String(chunk)}`
  })
  child.once('close', code => {
    session.status = 'stopped'
    session.stoppedAt ??= new Date().toISOString()
    if (code && code !== 0) {
      session.error = `${session.error ?? ''}`.trim() || `recording exited with code ${code}`
    }
  })
  activeRecordings.set(id, { session, child })
  return session
}

export async function stopVoiceRecording(sessionId: string): Promise<VoiceRecordingSession> {
  const active = activeRecordings.get(sessionId)
  if (!active) {
    throw new Error(`Voice recording session not found: ${sessionId}`)
  }
  if (active.session.backend === 'native') {
    stopNativeRecording()
  } else {
    active.child?.kill('SIGTERM')
  }
  active.session.status = 'stopped'
  active.session.stoppedAt = new Date().toISOString()
  activeRecordings.delete(sessionId)
  active.session.bytes = await readFile(active.session.rawPath).then(buffer => buffer.length, () => active.session.bytes)
  return active.session
}

export function getActiveVoiceRecordings(): VoiceRecordingSession[] {
  return [...activeRecordings.values()].map(active => active.session)
}

export function getVoiceStreamStatus(env: Record<string, string | undefined> = process.env): {
  available: boolean
  provider: VoiceProvider
  endpoint: string
  auth: 'oauth' | 'api-key' | 'missing'
  reason?: string
} {
  const provider = resolveVoiceProvider(env)
  const endpoint = endpointForProvider(provider, env)
  const hasOauth = Boolean(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_OAUTH_TOKEN)
  const hasApiKey = Boolean(env.ANTHROPIC_API_KEY)
  if (provider === 'deepseek') {
    return {
      available: false,
      provider,
      endpoint,
      auth: env.DEEPSEEK_API_KEY ? 'api-key' : 'missing',
      reason: env.DEEPSEEK_API_KEY
        ? 'DeepSeek API key is configured for chat completions, but the official DeepSeek API does not expose a speech-to-text/audio transcription endpoint. Set MY_CLAUDE_CODE_VOICE_PROVIDER=anthropic or doubao and provide STT credentials for voice transcription.'
        : 'DeepSeek voice provider requires DEEPSEEK_API_KEY, but DeepSeek still does not expose a speech-to-text/audio transcription endpoint.',
    }
  }
  if (provider === 'anthropic' && !hasOauth && !hasApiKey) {
    return {
      available: false,
      provider,
      endpoint,
      auth: 'missing',
      reason: 'Voice STT requires Claude OAuth or ANTHROPIC_API_KEY credentials.',
    }
  }
  if (provider === 'doubao' && !env.DOUBAO_API_KEY) {
    return {
      available: false,
      provider,
      endpoint,
      auth: 'missing',
      reason: 'Doubao STT requires DOUBAO_API_KEY.',
    }
  }
  return {
    available: true,
    provider,
    endpoint,
    auth: hasOauth ? 'oauth' : 'api-key',
  }
}

function resolveVoiceProvider(env: Record<string, string | undefined>): VoiceProvider {
  if (env.MY_CLAUDE_CODE_VOICE_PROVIDER === 'doubao') {
    return 'doubao'
  }
  if (env.MY_CLAUDE_CODE_VOICE_PROVIDER === 'deepseek') {
    return 'deepseek'
  }
  if (env.MY_CLAUDE_CODE_VOICE_PROVIDER === 'anthropic') {
    return 'anthropic'
  }
  if (
    env.DEEPSEEK_API_KEY &&
    !env.ANTHROPIC_API_KEY &&
    !env.CLAUDE_CODE_OAUTH_TOKEN &&
    !env.ANTHROPIC_OAUTH_TOKEN &&
    !env.DOUBAO_API_KEY
  ) {
    return 'deepseek'
  }
  return 'anthropic'
}

function endpointForProvider(
  provider: VoiceProvider,
  env: Record<string, string | undefined>,
): string {
  if (provider === 'doubao') {
    return env.DOUBAO_VOICE_WS_URL ?? 'wss://openspeech.bytedance.com/api/v1/vc'
  }
  if (provider === 'deepseek') {
    return env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/chat/completions'
  }
  return env.VOICE_STREAM_BASE_URL ?? 'wss://api.anthropic.com/api/ws/speech_to_text/voice_stream'
}

function readMicrophonePermission(): VoiceAvailability['permission'] {
  const status = microphoneAuthorizationStatus()
  if (status === 2) {
    return 'denied'
  }
  if (status === 3) {
    return 'authorized'
  }
  if (status === 0) {
    return 'not_determined'
  }
  return 'unknown'
}

function hasCommand(command: string): boolean {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore', timeout: 3000 })
  return result.error === undefined
}

async function probeArecord(): Promise<{ ok: boolean; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn('arecord', ['-f', 'S16_LE', '-r', String(SAMPLE_RATE), '-c', String(CHANNELS), '-t', 'raw', '/dev/null'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve({ ok: true, stderr: '' })
    }, 150)
    child.once('close', code => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stderr: stderr.trim() })
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve({ ok: false, stderr: 'arecord command not found' })
    })
  })
}

async function appendAudio(path: string, chunk: Buffer): Promise<void> {
  const previous = await readFile(path).catch(() => Buffer.alloc(0))
  await writeFile(path, Buffer.concat([previous, chunk]))
}

function installCommandForPlatform(): string | undefined {
  if (process.platform === 'darwin') {
    return 'brew install sox'
  }
  if (process.platform === 'linux') {
    return 'sudo apt-get install -y sox alsa-utils'
  }
  return undefined
}

function microphoneSettingsGuidance(): string {
  if (process.platform === 'darwin') {
    return 'Microphone access is denied. Open System Settings -> Privacy & Security -> Microphone, then enable terminal access.'
  }
  if (process.platform === 'win32') {
    return 'Microphone access is denied. Open Settings -> Privacy -> Microphone, then enable desktop app access.'
  }
  return 'Microphone access is denied by the OS audio service.'
}
