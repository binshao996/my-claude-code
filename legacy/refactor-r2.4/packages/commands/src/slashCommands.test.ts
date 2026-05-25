import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import {
  recordFileSnapshot,
  recordSession,
  replaySession,
} from '@my-claude-code/session'
import { loadSettings } from '@my-claude-code/settings'
import { getDefaultProviderRuntime } from '@my-claude-code/model-provider'
import { resolveResumeContext, runSlashCommand } from './slashCommands.js'

class BufferStream {
  value = ''

  write(chunk: string) {
    this.value += chunk
  }
}

function createTestIO() {
  return {
    stdout: new BufferStream(),
    stderr: new BufferStream(),
  }
}

describe('slash commands', () => {
  const previousNotificationDisable = process.env.MY_CLAUDE_CODE_DISABLE_OS_NOTIFICATIONS

  beforeEach(() => {
    process.env.MY_CLAUDE_CODE_DISABLE_OS_NOTIFICATIONS = '1'
  })

  afterEach(() => {
    if (previousNotificationDisable === undefined) {
      delete process.env.MY_CLAUDE_CODE_DISABLE_OS_NOTIFICATIONS
    } else {
      process.env.MY_CLAUDE_CODE_DISABLE_OS_NOTIFICATIONS = previousNotificationDisable
    }
  })

  it('prints status through the shared command handler', async () => {
    const io = createTestIO()
    const result = await runSlashCommand({
      command: '/status',
      io,
      version: '0.4.0',
    })

    expect(result.exitRequested).toBe(false)
    expect(JSON.parse(io.stdout.value)).toMatchObject({
      version: '0.4.0',
      model: 'deepseek-v4-flash',
    })
  })

  it('prints permission summary through the shared command handler', async () => {
    const io = createTestIO()
    await runSlashCommand({
      command: '/permissions',
      io,
      version: '0.4.0',
      options: {
        permissionMode: 'acceptEdits',
        allowedTools: ['Read'],
        disallowedTools: ['Bash'],
      },
    })

    expect(io.stdout.value).toContain('permissionMode: acceptEdits')
    expect(io.stdout.value).toContain('allowedTools: Read')
    expect(io.stdout.value).toContain('disallowedTools: Bash')
  })

  it('prints V1.6 TUI surface commands through structured screens', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v16-surfaces-'))
    mkdirSync(join(cwd, '.my-claude-code'), { recursive: true })
    writeFileSync(
      join(cwd, '.my-claude-code', 'settings.json'),
      JSON.stringify({ theme: 'dark', permissionMode: 'default' }),
      'utf8',
    )

    try {
      for (const command of [
        '/help settings',
        '/settings',
        '/trust',
        '/onboarding',
        '/wizard',
        '/sandbox',
        '/paste-image',
      ]) {
        const io = createTestIO()
        await runSlashCommand({ command, io, version: '1.6.0', cwd })
        expect(io.stdout.value).not.toContain('pending-real-runtime')
      }

      const help = createTestIO()
      await runSlashCommand({ command: '/help settings', io: help, version: '1.6.0', cwd })
      expect(help.stdout.value).toContain('Help:')
      expect(help.stdout.value).toContain('/settings')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('runs V1.1 full ecosystem parity from /parity --full', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-commands-'))
    const io = createTestIO()

    try {
      mkdirSync(join(cwd, 'docs'), { recursive: true })
      mkdirSync(join(cwd, 'claude-code', 'src'), { recursive: true })
      writeFileSync(
        join(cwd, 'docs', '10-source-coverage-ledger.md'),
        [
          '| Item ID | Item Type | Target Version | State | Owner | Evidence | Parity Case | Last Updated |',
          '| --- | --- | --- | --- | --- | --- | --- | --- |',
          '| `SRC:fixture` | source | V1.0 | Covered | Test | Covered for MVP: fixture | PC-000 | 2026-05-23 |',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(join(cwd, 'claude-code', 'src', 'missing.ts'), 'export {}\n', 'utf8')

      await runSlashCommand({
        command: '/parity --full',
        io,
        version: '1.0.0',
        cwd,
      })
      const report = JSON.parse(io.stdout.value) as {
        mode: string
        status: string
        checks: Array<{ label: string; status: string }>
      }

      expect(report.mode).toBe('full-ecosystem')
      expect(report.status).toBe('fail')
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'full ecosystem feature parity',
          status: 'pass',
        }),
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('runs V1.2 strict parity from /parity --strict', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-commands-'))
    const io = createTestIO()

    try {
      mkdirSync(join(cwd, 'docs'), { recursive: true })
      mkdirSync(join(cwd, 'claude-code', 'src', 'commands', 'missing'), { recursive: true })
      mkdirSync(join(cwd, 'claude-code', 'packages', 'missing'), { recursive: true })
      writeFileSync(
        join(cwd, 'docs', '10-source-coverage-ledger.md'),
        [
          '| Item ID | Item Type | Target Version | State | Owner | Evidence | Parity Case | Last Updated |',
          '| --- | --- | --- | --- | --- | --- | --- | --- |',
          '| `SRC:fixture` | source | V1.0 | Covered | Test | fixture | PC-000 | 2026-05-23 |',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        join(cwd, 'docs', 'strict-parity-manifest.json'),
        JSON.stringify({ schemaVersion: 1, toolAliases: { FileReadTool: 'Read' } }),
        'utf8',
      )

      await runSlashCommand({
        command: '/parity --strict',
        io,
        version: '1.0.0',
        cwd,
      })
      const report = JSON.parse(io.stdout.value) as {
        mode: string
        status: string
        checks: Array<{ label: string; status: string }>
      }

      expect(report.mode).toBe('strict')
      expect(report.status).toBe('fail')
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'strict parity manifest',
          status: 'pass',
        }),
      )
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'strict command inventory',
          status: 'fail',
        }),
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('runs V1.6 TUI parity checks from /parity --strict --tui', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-commands-'))
    const io = createTestIO()

    try {
      mkdirSync(join(cwd, 'docs'), { recursive: true })
      mkdirSync(join(cwd, 'claude-code', 'src', 'commands', 'missing'), { recursive: true })
      mkdirSync(join(cwd, 'claude-code', 'packages', 'missing'), { recursive: true })
      writeFileSync(
        join(cwd, 'docs', '10-source-coverage-ledger.md'),
        [
          '| Item ID | Item Type | Target Version | State | Owner | Evidence | Parity Case | Last Updated |',
          '| --- | --- | --- | --- | --- | --- | --- | --- |',
          '| `SRC:fixture` | source | V1.0 | Covered | Test | fixture | PC-000 | 2026-05-23 |',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        join(cwd, 'docs', 'strict-parity-manifest.json'),
        JSON.stringify({ schemaVersion: 1, toolAliases: { FileReadTool: 'Read' } }),
        'utf8',
      )

      await runSlashCommand({
        command: '/parity --strict --tui',
        io,
        version: '1.0.0',
        cwd,
      })
      const report = JSON.parse(io.stdout.value) as {
        mode: string
        checks: Array<{ label: string; status: string }>
      }

      expect(report.mode).toBe('strict')
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'strict TUI Ink internals',
          status: 'fail',
        }),
      )
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'strict TUI component surface',
          status: 'fail',
        }),
      )
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'strict TUI upstream surface',
          status: 'fail',
        }),
      )
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'strict TUI runtime tests',
          status: 'fail',
        }),
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('exposes V1.3 upstream command surfaces instead of treating them as unknown', async () => {
    const io = createTestIO()

    await runSlashCommand({
      command: '/chrome status',
      io,
      version: '1.0.0',
    })

    const surface = JSON.parse(io.stdout.value) as {
      command: string
      description: string
      args: string[]
      parity: { surface: string; strictVersion: string }
      behaviorStatus: string
    }

    expect(surface.command).toBe('/chrome')
    expect(surface.description).toContain('Chrome')
    expect(surface.args).toEqual(['status'])
    expect(surface.parity).toMatchObject({
      surface: 'registered',
      strictVersion: 'V1.3',
    })
    expect(surface.behaviorStatus).toBe('local-runtime')
  })

  it('runs V1.7 platform strict focus and local platform command surfaces', async () => {
    const parityIo = createTestIO()
    await runSlashCommand({
      command: '/parity --strict --platform',
      io: parityIo,
      version: '1.0.0',
    })
    const report = JSON.parse(parityIo.stdout.value) as {
      status: string
      checks: Array<{ label: string; status: string }>
    }
    expect(report.status).toBe('pass')
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        label: 'strict platform browser runtime',
        status: 'pass',
      }),
    )

    const ideIo = createTestIO()
    await runSlashCommand({
      command: '/ide status',
      io: ideIo,
      version: '1.7.0',
    })
    expect(JSON.parse(ideIo.stdout.value)).toMatchObject({
      behaviorStatus: 'local-runtime',
      lspTool: 'LSP',
      surfaces: expect.arrayContaining(['MagicDocs', 'PromptSuggestion']),
    })
  })

  it('runs V1.8 voice strict focus and voice command surfaces', async () => {
    const parityIo = createTestIO()
    await runSlashCommand({
      command: '/parity --strict --voice',
      io: parityIo,
      version: '1.0.0',
    })
    const report = JSON.parse(parityIo.stdout.value) as {
      status: string
      checks: Array<{ label: string; status: string }>
    }
    expect(report.status).toBe('pass')
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        label: 'strict voice runtime',
        status: 'pass',
      }),
    )

    const voiceIo = createTestIO()
    await runSlashCommand({
      command: '/voice check',
      io: voiceIo,
      version: '1.8.0',
    })
    expect(JSON.parse(voiceIo.stdout.value)).toMatchObject({
      availability: expect.objectContaining({ backend: expect.any(String) }),
      stt: expect.objectContaining({ provider: expect.any(String) }),
    })
  })

  it('runs V1.9 memory strict focus and memory command surfaces', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-slash-'))

    try {
      const extractIo = createTestIO()
      await runSlashCommand({
        command: '/memory extract Billing migrations must remain reversible.',
        io: extractIo,
        version: '1.9.0',
        cwd,
      })
      expect(JSON.parse(extractIo.stdout.value).memories).toHaveLength(1)

      const memoryIo = createTestIO()
      await runSlashCommand({
        command: '/memory rank billing migration',
        io: memoryIo,
        version: '1.9.0',
        cwd,
      })
      expect(JSON.parse(memoryIo.stdout.value)).toMatchObject({
        entries: [expect.objectContaining({ store: 'extracted' })],
      })

      const vaultIo = createTestIO()
      await runSlashCommand({
        command: '/vault list',
        io: vaultIo,
        version: '1.9.0',
        cwd,
      })
      expect(JSON.parse(vaultIo.stdout.value)).toMatchObject({
        behaviorStatus: 'secret-safe-local',
        tool: 'VaultHttpFetch',
      })

      const parityIo = createTestIO()
      await runSlashCommand({
        command: '/parity --strict --memory',
        io: parityIo,
        version: '1.0.0',
      })
      const report = JSON.parse(parityIo.stdout.value) as {
        status: string
        checks: Array<{ label: string; status: string }>
      }
      expect(report.status).toBe('pass')
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'strict memory runtime',
          status: 'pass',
        }),
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('runs V2.0 agent workflow strict focus and command surfaces', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-slash-'))

    try {
      const actionIo = createTestIO()
      await runSlashCommand({
        command: '/message-action msg_1 pin useful',
        io: actionIo,
        version: '2.0.0',
        cwd,
      })
      expect(JSON.parse(actionIo.stdout.value)).toMatchObject({
        messageId: 'msg_1',
        action: 'pin',
      })

      const jobIo = createTestIO()
      await runSlashCommand({
        command: '/job review this PR',
        io: jobIo,
        version: '2.0.0',
        cwd,
      })
      expect(JSON.parse(jobIo.stdout.value)).toMatchObject({
        behaviorStatus: 'local-runtime',
        classification: expect.objectContaining({ kind: 'review' }),
      })

      const reviewIo = createTestIO()
      await runSlashCommand({
        command: '/review inspect current diff',
        io: reviewIo,
        version: '2.0.0',
        cwd,
      })
      expect(JSON.parse(reviewIo.stdout.value)).toMatchObject({
        behaviorStatus: 'local-runtime',
        review: expect.objectContaining({ mutationApplied: false }),
      })

      const scheduleIo = createTestIO()
      await runSlashCommand({
        command: '/schedule add nightly',
        io: scheduleIo,
        version: '2.0.0',
        cwd,
      })
      expect(JSON.parse(scheduleIo.stdout.value)).toMatchObject({
        name: 'nightly',
        status: 'scheduled',
      })

      const parityIo = createTestIO()
      await runSlashCommand({
        command: '/parity --strict --agent-workflows',
        io: parityIo,
        version: '1.0.0',
      })
      const report = JSON.parse(parityIo.stdout.value) as {
        status: string
        checks: Array<{ label: string; status: string }>
      }
      expect(report.status).toBe('pass')
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'strict agent workflow runtime',
          status: 'pass',
        }),
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('routes V1.3 upstream aliases to concrete local command handlers when available', async () => {
    const io = createTestIO()

    await runSlashCommand({
      command: '/stats',
      io,
      version: '1.0.0',
    })

    expect(io.stdout.value).toContain('Usage:')
    expect(io.stdout.value).not.toContain('pending-real-runtime')
  })

  it('prints V1.4 provider registry and rate-limit runtime state', async () => {
    getDefaultProviderRuntime().reset()
    const providerIo = createTestIO()

    await runSlashCommand({
      command: '/provider',
      io: providerIo,
      version: '1.4.0',
      options: {
        model: 'fast',
      },
    })

    const provider = JSON.parse(providerIo.stdout.value) as {
      active: {
        provider: string
        requestedModel: string
        model: string
        capabilities: {
          supportsPromptCache: boolean
          supportsToolCallDelta: boolean
        }
      }
      providers: Array<{
        name: string
        apiKeyConfigured: boolean
      }>
      balances: Array<{
        provider: string
        requestLimit: number
        requestsUsed: number
        limited: boolean
      }>
    }

    expect(provider.active).toMatchObject({
      provider: 'deepseek',
      requestedModel: 'fast',
      model: 'deepseek-v4-flash',
      capabilities: {
        supportsPromptCache: true,
        supportsToolCallDelta: true,
      },
    })
    expect(provider.providers[0]).toMatchObject({
      name: 'deepseek',
    })
    expect(typeof provider.providers[0].apiKeyConfigured).toBe('boolean')
    expect(provider.balances[0]).toMatchObject({
      provider: 'deepseek',
      requestLimit: 60,
      requestsUsed: 0,
      limited: false,
    })

    const rateLimitIo = createTestIO()
    await runSlashCommand({
      command: '/rate-limit-options',
      io: rateLimitIo,
      version: '1.4.0',
    })
    expect(JSON.parse(rateLimitIo.stdout.value)).toMatchObject({
      balances: [
        {
          provider: 'deepseek',
          requestLimit: 60,
          tokenLimit: 200000,
        },
      ],
      errors: [],
    })

    const breakCacheIo = createTestIO()
    await runSlashCommand({
      command: '/break-cache',
      io: breakCacheIo,
      version: '1.4.0',
    })
    expect(JSON.parse(breakCacheIo.stdout.value)).toMatchObject({
      behaviorStatus: 'local-runtime',
      cacheBreaks: [],
    })
  })

  it('runs V1.4 auth commands without printing or persisting raw credentials', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-auth-'))
    const originalKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'fixture-secret-key'

    try {
      const loginIo = createTestIO()
      await runSlashCommand({
        command: '/login',
        io: loginIo,
        version: '1.0.0',
        cwd,
      })
      const login = JSON.parse(loginIo.stdout.value) as {
        behaviorStatus: string
        authenticated: boolean
        provider: string
        credentialSource: string
        tokenHash: string
      }
      expect(login).toMatchObject({
        behaviorStatus: 'local-runtime',
        authenticated: true,
        provider: 'anthropic',
        credentialSource: 'env:ANTHROPIC_API_KEY',
      })
      expect(login.tokenHash).not.toBe('fixture-secret-key')
      expect(loginIo.stdout.value).not.toContain('fixture-secret-key')

      const authState = readFileSync(join(cwd, '.my-claude-code', 'auth.json'), 'utf8')
      expect(authState).not.toContain('fixture-secret-key')
      expect(JSON.parse(authState)).toMatchObject({
        version: 1,
        provider: 'anthropic',
        credentialSource: 'env:ANTHROPIC_API_KEY',
      })

      const refreshIo = createTestIO()
      await runSlashCommand({
        command: '/oauth-refresh',
        io: refreshIo,
        version: '1.0.0',
        cwd,
      })
      expect(JSON.parse(refreshIo.stdout.value)).toMatchObject({
        behaviorStatus: 'local-runtime',
        authenticated: true,
        sideEffect: 'refreshed local auth state metadata',
      })

      const logoutIo = createTestIO()
      await runSlashCommand({
        command: '/logout',
        io: logoutIo,
        version: '1.0.0',
        cwd,
      })
      expect(JSON.parse(logoutIo.stdout.value)).toMatchObject({
        behaviorStatus: 'local-runtime',
        authenticated: false,
      })
      expect(() => readFileSync(join(cwd, '.my-claude-code', 'auth.json'), 'utf8')).toThrow()
    } finally {
      if (originalKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = originalKey
      }
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('uploads and downloads settings sync snapshots through /config', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-commands-'))
    const io = createTestIO()

    try {
      await runSlashCommand({
        command: '/theme dark',
        io,
        version: '1.0.0',
        cwd,
      })
      await runSlashCommand({
        command: '/config sync-upload',
        io,
        version: '1.0.0',
        cwd,
      })
      rmSync(join(cwd, '.my-claude-code', 'settings.json'), { force: true })
      await runSlashCommand({
        command: '/config sync-download',
        io,
        version: '1.0.0',
        cwd,
      })

      expect(io.stdout.value).toContain('"action": "sync-upload"')
      expect(io.stdout.value).toContain('"action": "sync-download"')
      expect(io.stdout.value).toContain('"entryCount": 1')
      expect(io.stdout.value).toContain('"project"')
      expect(io.stdout.value).toContain('"theme": "dark"')
      await expect(loadSettings(cwd)).resolves.toEqual({ theme: 'dark' })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('prints V0.4 utility command summaries', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-commands-'))
    const io = createTestIO()

    try {
      await runSlashCommand({
        command: '/add-dir ../shared,/tmp/work ../shared',
        io,
        version: '0.4.0',
        cwd,
      })
      await runSlashCommand({
        command: '/doctor',
        io,
        version: '0.4.0',
        cwd,
      })
      await runSlashCommand({
        command: '/theme',
        io,
        version: '0.4.0',
        cwd,
      })
      await runSlashCommand({
        command: '/statusline',
        io,
        version: '0.4.0',
        cwd,
      })
      await runSlashCommand({
        command: '/usage',
        io,
        version: '0.4.0',
        cwd,
      })
      await runSlashCommand({
        command: '/keybindings',
        io,
        version: '0.4.0',
        cwd,
      })
      await runSlashCommand({
        command: '/config',
        io,
        version: '0.4.0',
        cwd,
      })
      await runSlashCommand({
        command: '/env',
        io,
        version: '0.4.0',
        cwd,
      })
      await runSlashCommand({
        command: '/features',
        io,
        version: '0.9.0',
        cwd,
      })
      await runSlashCommand({
        command: '/health',
        io,
        version: '1.0.0',
        cwd,
      })
      await runSlashCommand({
        command: '/memory',
        io,
        version: '0.4.0',
        cwd,
      })
      await runSlashCommand({
        command: '/output-style',
        io,
        version: '0.4.0',
        cwd,
      })
      await runSlashCommand({
        command: '/diff',
        io,
        version: '0.4.0',
        cwd,
      })
      await runSlashCommand({
        command: '/version',
        io,
        version: '0.4.0',
        cwd,
      })

      expect(io.stdout.value).toContain('Additional directories: ../shared, /tmp/work')
      expect(io.stdout.value).toContain('Doctor:')
      expect(io.stdout.value).toContain('status: warning')
      expect(io.stdout.value).toContain('check settings source project:')
      expect(io.stdout.value).toContain('check permission rule coverage:')
      expect(io.stdout.value).toContain('Theme:')
      expect(io.stdout.value).toContain('active: default')
      expect(io.stdout.value).toContain('my-claude-code 0.4.0')
      expect(io.stdout.value).toContain('No usage found.')
      expect(io.stdout.value).toContain('Keybindings:')
      expect(io.stdout.value).toContain('Ctrl+R: reverse history search')
      expect(io.stdout.value).toContain('Up / Esc with queued input')
      expect(io.stdout.value).toContain('"vimMode": false')
      expect(io.stdout.value).toContain('Environment:')
      expect(io.stdout.value).toContain('"features"')
      expect(io.stdout.value).toContain('"BUDDY"')
      expect(io.stdout.value).toContain('"parityState": "Covered"')
      expect(io.stdout.value).toContain('"checks"')
      expect(io.stdout.value).toContain('"coverage ledger"')
      expect(io.stdout.value).toContain('Memory:')
      expect(io.stdout.value).toContain('Output style:')
      expect(io.stdout.value).toContain('Diff:')
      expect(io.stdout.value).toContain('0.4.0')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('prints V0.6 skills, MCP, and plugin command surfaces', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-commands-'))
    const io = createTestIO()

    try {
      mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true })
      writeFileSync(
        join(cwd, '.claude', 'skills', 'reviewer.md'),
        [
          '---',
          'name: reviewer',
          'description: Review changes',
          '---',
          'Review code and tests.',
        ].join('\n'),
        'utf8',
      )
      mkdirSync(join(cwd, '.my-claude-code', 'plugins', 'demo'), { recursive: true })
      writeFileSync(
        join(cwd, '.my-claude-code', 'plugins', 'demo', 'plugin.json'),
        JSON.stringify({
          name: 'demo',
          commands: [{ name: 'hello', content: 'hello from plugin' }],
        }),
        'utf8',
      )
      writeFileSync(
        join(cwd, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            disabled: {
              type: 'stdio',
              command: 'node',
              disabled: true,
            },
          },
        }),
        'utf8',
      )

      await runSlashCommand({
        command: '/skills',
        io,
        version: '0.6.0',
        cwd,
      })
      const skillsReport = JSON.parse(io.stdout.value) as {
        skills: Array<{ name: string; source: string }>
        feedbackCount: number
      }
      expect(skillsReport).toMatchObject({
        feedbackCount: 0,
        learningCount: 0,
      })
      expect(skillsReport.skills).toContainEqual(
        expect.objectContaining({ name: 'claude-api', source: 'bundled' }),
      )
      expect(skillsReport.skills).toContainEqual(
        expect.objectContaining({ name: 'reviewer', source: 'project' }),
      )

      io.stdout.value = ''
      await runSlashCommand({
        command: '/skills feedback reviewer helpful local note',
        io,
        version: '0.6.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        skillName: 'reviewer',
        outcome: 'helpful',
        note: 'local note',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/skills generate slash-skill -- Use for slash generated skills',
        io,
        version: '1.1.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        name: 'slash-skill',
        status: 'created',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/skills learn slash-skill -- Keep generated skills focused',
        io,
        version: '1.1.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        skillName: 'slash-skill',
        lesson: 'Keep generated skills focused',
        source: 'manual',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/skills',
        io,
        version: '0.6.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        feedbackCount: 1,
        feedback: [expect.objectContaining({ skillName: 'reviewer' })],
        learningCount: 1,
        learning: [expect.objectContaining({ skillName: 'slash-skill' })],
        skillStore: expect.objectContaining({
          version: '1.4',
          entries: expect.any(Number),
          resolved: expect.any(Number),
        }),
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/skill-search generated',
        io,
        version: '1.4.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        query: 'generated',
        results: [expect.objectContaining({ name: 'slash-skill' })],
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/skill-store summary',
        io,
        version: '1.4.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        version: '1.4',
        entries: expect.any(Number),
        resolved: expect.any(Number),
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/plugin',
        io,
        version: '0.6.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        plugins: [
          expect.objectContaining({
            name: 'demo',
            commands: [expect.objectContaining({ name: 'hello' })],
          }),
        ],
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/plugin run demo hello',
        io,
        version: '0.6.0',
        cwd,
      })
      expect(io.stdout.value).toBe('hello from plugin\n')

      io.stdout.value = ''
      await runSlashCommand({
        command: '/mcp',
        io,
        version: '0.6.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        servers: [expect.objectContaining({ name: 'disabled' })],
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('runs V1.4 plugin marketplace lifecycle through /plugin commands', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-commands-'))
    const io = createTestIO()
    const marketplacePath = join(cwd, '.my-claude-code', 'plugin-marketplace.json')
    const pluginManifestPath = join(cwd, '.my-claude-code', 'plugins', 'demo', 'plugin.json')

    try {
      mkdirSync(join(cwd, '.my-claude-code'), { recursive: true })
      writeFileSync(
        marketplacePath,
        JSON.stringify({
          plugins: [{
            name: 'demo',
            version: '1.0.0',
            manifest: {
              name: 'demo',
              commands: [{ name: 'hello', content: 'hello v1' }],
            },
          }],
        }),
        'utf8',
      )

      await runSlashCommand({ command: '/plugin marketplace', io, version: '1.4.0', cwd })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        marketplace: [expect.objectContaining({ name: 'demo', version: '1.0.0' })],
        installed: [],
      })

      io.stdout.value = ''
      await runSlashCommand({ command: '/plugin install demo', io, version: '1.4.0', cwd })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        status: 'installed',
        plugin: { name: 'demo', enabled: true, version: '1.0.0' },
      })
      expect(readFileSync(pluginManifestPath, 'utf8')).toContain('hello v1')

      io.stdout.value = ''
      await runSlashCommand({ command: '/plugin disable demo', io, version: '1.4.0', cwd })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        status: 'disabled',
        plugin: { enabled: false },
      })

      io.stdout.value = ''
      await runSlashCommand({ command: '/plugin', io, version: '1.4.0', cwd })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        plugins: [],
        installed: [expect.objectContaining({ name: 'demo', enabled: false })],
      })

      io.stdout.value = ''
      await runSlashCommand({ command: '/plugin enable demo', io, version: '1.4.0', cwd })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        status: 'enabled',
        plugin: { enabled: true },
      })

      writeFileSync(
        marketplacePath,
        JSON.stringify({
          plugins: [{
            name: 'demo',
            version: '1.1.0',
            manifest: {
              name: 'demo',
              commands: [{ name: 'hello', content: 'hello v2' }],
            },
          }],
        }),
        'utf8',
      )
      io.stdout.value = ''
      await runSlashCommand({ command: '/plugin update demo', io, version: '1.4.0', cwd })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        status: 'updated',
        plugin: { version: '1.1.0' },
      })

      rmSync(pluginManifestPath, { force: true })
      io.stdout.value = ''
      await runSlashCommand({ command: '/plugin reload', io, version: '1.4.0', cwd })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        restored: ['demo'],
        loadedPlugins: ['demo'],
      })

      io.stdout.value = ''
      await runSlashCommand({ command: '/plugin run demo hello', io, version: '1.4.0', cwd })
      expect(io.stdout.value).toBe('hello v2\n')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('prints V0.7 task, background, agent, and worktree command surfaces', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-commands-'))
    const io = createTestIO()

    try {
      await runSlashCommand({
        command: '/tasks create write docs',
        io,
        version: '0.7.0',
        cwd,
      })
      const task = JSON.parse(io.stdout.value) as { id: string; title: string }
      expect(task.title).toBe('write docs')

      io.stdout.value = ''
      await runSlashCommand({
        command: `/tasks stop ${task.id}`,
        io,
        version: '0.7.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        id: task.id,
        status: 'stopped',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/background',
        io,
        version: '0.7.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toEqual({ background: [] })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/tasks runner environment slash-env',
        io,
        version: '0.7.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        kind: 'environment',
        status: 'completed',
        stdout: expect.stringContaining('environment-runner-ready'),
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/tasks runner self-hosted slash-self',
        io,
        version: '0.7.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        kind: 'self-hosted',
        status: 'completed',
        stdout: expect.stringContaining('self-hosted-runner-ready'),
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/tasks runner list',
        io,
        version: '0.7.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        profiles: [
          expect.objectContaining({ name: 'slash-env' }),
          expect.objectContaining({ name: 'slash-self' }),
        ],
        runs: [expect.any(Object), expect.any(Object)],
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/tasks template create smoke Run smoke checks',
        io,
        version: '0.7.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        name: 'smoke',
        title: 'Run smoke checks',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/tasks template run smoke',
        io,
        version: '0.7.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        title: 'Run smoke checks',
        status: 'pending',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: `/tasks workflow run slash-workflow ${process.execPath} -e console.log("slash-workflow-ready")`,
        io,
        version: '0.7.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        name: 'slash-workflow',
        status: 'completed',
        stdout: expect.stringContaining('slash-workflow-ready'),
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: `/monitor start slash-monitor ${process.execPath} -e console.log("slash-monitor-ready")`,
        io,
        version: '0.7.0',
        cwd,
      })
      const monitor = JSON.parse(io.stdout.value) as { id: string; name: string }
      expect(monitor.name).toBe('slash-monitor')

      await waitForSlashOutput({
        command: `/monitor output ${monitor.id}`,
        io,
        version: '0.7.0',
        cwd,
        expected: 'slash-monitor-ready',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/agents builtin',
        io,
        version: '0.7.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        builtInAgents: [
          expect.objectContaining({ name: 'explore' }),
          expect.objectContaining({ name: 'plan' }),
        ],
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/agents run explore inspect workflows',
        io,
        version: '0.7.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        description: 'built-in explore agent',
        allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/coordinator run coordinate parity task',
        io,
        version: '0.7.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        prompt: 'coordinate parity task',
        workerCount: 3,
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/ultraplan ship full parity',
        io,
        version: '0.9.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        prompt: 'ship full parity',
        phase: 'ready',
        plan: expect.stringContaining('Ultraplan'),
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/assistant proactive',
        io,
        version: '1.1.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        active: true,
        mode: 'proactive',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/brief create Daily -- Local summary ready',
        io,
        version: '1.1.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        title: 'Daily',
        body: 'Local summary ready',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/channels register local-updates local stdout',
        io,
        version: '1.1.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        name: 'local-updates',
        kind: 'local',
        target: 'stdout',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/weixin serve',
        io,
        version: '1.7.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        package: '@claude-code-best/weixin',
        status: 'serving',
        mcpServer: 'plugin:weixin:weixin',
        channel: {
          name: 'weixin',
          kind: 'weixin',
          target: 'plugin:weixin@builtin',
        },
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/push send Build -- Checks passed',
        io,
        version: '1.1.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        title: 'Build',
        body: 'Checks passed',
        status: 'queued',
        dispatch: expect.objectContaining({
          bodyHash: expect.any(String),
        }),
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/subscribe-pr owner/repo 42 comment review',
        io,
        version: '1.1.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        repo: 'owner/repo',
        pr_number: 42,
        events: ['comment', 'review'],
        subscribed: true,
        status: 'subscribed',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/proactive schedule check status later',
        io,
        version: '1.1.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        prompt: 'check status later',
        status: 'scheduled',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/worktree enter ../feature feature/v07',
        io,
        version: '0.7.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        active: {
          branch: 'feature/v07',
        },
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/agents',
        io,
        version: '0.7.0',
        cwd,
      })
      const agentsReport = JSON.parse(io.stdout.value) as {
        agents: Array<{ description: string }>
        builtInAgents: Array<{ name: string }>
      }
      expect(agentsReport.agents).toContainEqual(
        expect.objectContaining({ description: 'built-in explore agent' }),
      )
      expect(agentsReport.agents).toContainEqual(
        expect.objectContaining({ description: 'coordinator research worker' }),
      )
      expect(agentsReport.agents).toContainEqual(
        expect.objectContaining({ description: 'coordinator implementation worker' }),
      )
      expect(agentsReport.agents).toContainEqual(
        expect.objectContaining({ description: 'coordinator verification worker' }),
      )
      expect(agentsReport.builtInAgents).toContainEqual(
        expect.objectContaining({ name: 'explore' }),
      )
      expect(agentsReport.builtInAgents).toContainEqual(
        expect.objectContaining({ name: 'plan' }),
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('prints V0.8 daemon and remote command surfaces', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-commands-'))
    const io = createTestIO()

    try {
      await runSlashCommand({
        command: '/daemon start',
        io,
        version: '0.8.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        status: 'running',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/remote connect local .',
        io,
        version: '0.8.0',
        cwd,
      })
      const session = JSON.parse(io.stdout.value) as { id: string; status: string }
      expect(session.status).toBe('connected')

      io.stdout.value = ''
      await runSlashCommand({
        command: `/remote run ${session.id} ${process.execPath} -e console.log("slash-remote")`,
        io,
        version: '0.8.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        exitCode: 0,
        stdout: expect.stringContaining('slash-remote'),
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: `/detach ${session.id}`,
        io,
        version: '0.8.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        status: 'detached',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: `/attach ${session.id}`,
        io,
        version: '0.8.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        status: 'connected',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/peers',
        io,
        version: '0.8.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        peers: [expect.objectContaining({ id: session.id })],
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/remote setup slash-fixture',
        io,
        version: '0.8.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        status: 'ready',
        supportedTransports: expect.arrayContaining([
          'loopback',
          'ssh',
          'ssh-mock',
          'websocket-bridge',
          'sse-bridge',
          'hybrid-bridge',
          'pipe-ipc',
          'lan-pipe',
          'uds-inbox',
          'acp-jsonl',
        ]),
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/daemon heartbeat',
        io,
        version: '1.5.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        status: 'running',
        heartbeatAt: expect.any(String),
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/remote env REMOTE_TOKEN slash-secret',
        io,
        version: '1.5.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        name: 'REMOTE_TOKEN',
        valueHash: expect.any(String),
      })
      expect(io.stdout.value).not.toContain('slash-secret')

      io.stdout.value = ''
      await runSlashCommand({
        command: '/bridge-kick slash-test',
        io,
        version: '1.5.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        behaviorStatus: 'local-runtime',
        event: { type: 'bridge.kick' },
        daemon: { reconnectCount: 1 },
      })

      const sshFixture = join(cwd, 'ssh-fixture.mjs')
      writeFileSync(
        sshFixture,
        'const [, , host, command] = process.argv; console.log(JSON.stringify({ host, command }))',
        'utf8',
      )
      io.stdout.value = ''
      await runSlashCommand({
        command: `/remote ssh fixture.example . ${process.execPath} ${sshFixture}`,
        io,
        version: '1.5.0',
        cwd,
      })
      const sshSession = JSON.parse(io.stdout.value) as { id: string; transport: string }
      expect(sshSession.transport).toBe('ssh')

      io.stdout.value = ''
      await runSlashCommand({
        command: `/remote run ${sshSession.id} printf hello`,
        io,
        version: '1.5.0',
        cwd,
      })
      expect(JSON.parse(JSON.parse(io.stdout.value).stdout)).toMatchObject({
        host: 'fixture.example',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: `/remote pipe-register main master ${session.id}`,
        io,
        version: '0.8.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        name: 'main',
        role: 'master',
        status: 'attached',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/remote lan-register lan-main 192.0.2.30 4499 sub',
        io,
        version: '1.1.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        name: 'lan-main',
        address: 'tcp://192.0.2.30:4499',
        transport: 'lan',
        role: 'sub',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/remote send main hello from slash',
        io,
        version: '0.8.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        targetName: 'main',
        body: 'hello from slash',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/remote uds-start slash-inbox',
        io,
        version: '1.5.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        name: 'slash-inbox',
        status: 'listening',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/remote uds-send slash-inbox hello uds slash',
        io,
        version: '1.5.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        name: 'slash-inbox',
        status: 'sent',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/remote pipes',
        io,
        version: '0.8.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        pipes: expect.arrayContaining([
          expect.objectContaining({ name: 'main', messageCount: 1 }),
          expect.objectContaining({ name: 'lan-main', transport: 'lan' }),
        ]),
        udsInboxes: expect.arrayContaining([
          expect.objectContaining({ name: 'slash-inbox' }),
        ]),
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: `/remote run ${session.id} rm -rf .`,
        io,
        version: '0.8.0',
        cwd,
      })
      expect(io.stdout.value).toContain('Remote error:')
      expect(io.stdout.value).toContain('dangerous remote command requires confirmation')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('prints V1.1 local ecosystem parity command surfaces', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-commands-'))
    const io = createTestIO()

    try {
      await runSlashCommand({ command: '/acp link fixture-client', io, version: '1.1.0', cwd })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        client: 'fixture-client',
        transport: 'jsonl',
        status: 'connected',
        inboxPath: expect.stringContaining('fixture-client.inbox.jsonl'),
        outboxPath: expect.stringContaining('fixture-client.outbox.jsonl'),
      })
      const acpSessionId = JSON.parse(io.stdout.value).id

      io.stdout.value = ''
      await runSlashCommand({
        command: `/acp send ${acpSessionId} hello jsonl acp`,
        io,
        version: '1.1.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        sessionId: acpSessionId,
        status: 'sent',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/autofix-pr plan owner/repo fix failing tests',
        io,
        version: '1.1.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        repo: 'owner/repo',
        summary: 'fix failing tests',
        status: 'planned',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/buddy start review local parity',
        io,
        version: '1.1.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        objective: 'review local parity',
        status: 'active',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/chicago-mcp register local local://fixture',
        io,
        version: '1.1.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        name: 'local',
        endpoint: 'local://fixture',
      })

      io.stdout.value = ''
      await runSlashCommand({
        command: '/torch probe current-session',
        io,
        version: '1.1.0',
        cwd,
      })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        target: 'current-session',
        status: 'recorded',
      })

      io.stdout.value = ''
      await runSlashCommand({ command: '/voice on anthropic', io, version: '1.1.0', cwd })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        provider: 'anthropic',
        availability: expect.objectContaining({ backend: expect.any(String) }),
        stt: expect.objectContaining({ provider: 'anthropic' }),
      })

      io.stdout.value = ''
      await runSlashCommand({ command: '/voice on deepseek', io, version: '1.1.0', cwd })
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        enabled: false,
        provider: 'deepseek',
        stt: expect.objectContaining({
          available: false,
          provider: 'deepseek',
          reason: expect.stringContaining('does not expose a speech-to-text/audio transcription endpoint'),
        }),
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('returns merged additional directories for dynamic /add-dir', async () => {
    const io = createTestIO()
    const result = await runSlashCommand({
      command: '/add-dir ../shared,/tmp/work ../shared',
      io,
      version: '0.4.0',
      options: {
        additionalDirectories: ['../existing'],
      },
    })

    expect(result.additionalDirectories).toEqual([
      '../existing',
      '../shared',
      '/tmp/work',
    ])
    expect(io.stdout.value).toContain(
      'Additional directories: ../existing, ../shared, /tmp/work',
    )
  })

  it('resolves explicit resume context from the shared command module', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-commands-'))
    const transcriptPath = join(cwd, 'transcript.jsonl')

    try {
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          id: 'record_1',
          session_id: 'session_resume',
          created_at: new Date('2026-05-23T00:00:00.000Z').toISOString(),
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'text_delta',
              text: 'resume me',
            },
          },
        })}\n`,
        'utf8',
      )
      await recordSession({
        cwd,
        sessionId: 'session_resume',
        transcriptPath,
        prompt: 'previous',
      })

      const context = await resolveResumeContext({
        cwd,
        resume: 'session_resume',
      })
      const io = createTestIO()
      await runSlashCommand({
        command: '/resume session_resume',
        io,
        version: '0.4.0',
        cwd,
      })

      expect(context?.summary).toContain('resume me')
      expect(context?.session.id).toBe('session_resume')
      expect(io.stdout.value).toContain('resume me')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('prints session usage, prompt cache, token budget, and restore plan fields', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-commands-'))
    const transcriptPath = join(cwd, 'transcript.jsonl')
    const io = createTestIO()

    try {
      writeFileSync(
        transcriptPath,
        [
          usageRecord({
            type: 'message_start',
            message: {
              id: 'msg_1',
              role: 'assistant',
              usage: {
                input_tokens: 10,
                output_tokens: 0,
                cache_creation_input_tokens: 5,
                cache_read_input_tokens: 15,
              },
            },
          }),
          usageRecord({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_creation_input_tokens: 5,
              cache_read_input_tokens: 15,
            },
          }),
          usageRecord({ type: 'message_stop' }),
        ].join(''),
        'utf8',
      )
      await recordSession({
        cwd,
        sessionId: 'session_usage',
        transcriptPath,
        prompt: 'usage',
      })

      await runSlashCommand({
        command: '/context',
        io,
        version: '0.4.0',
        cwd,
      })
      await runSlashCommand({
        command: '/usage',
        io,
        version: '0.4.0',
        cwd,
      })
      await runSlashCommand({
        command: '/statusline',
        io,
        version: '0.4.0',
        cwd,
      })

      expect(io.stdout.value).toContain('"promptCache"')
      expect(io.stdout.value).toContain('"runtimeContext"')
      expect(io.stdout.value).toContain('"sections"')
      expect(io.stdout.value).toContain('"restorePlan"')
      expect(io.stdout.value).toContain('promptCacheReadTokens: 15')
      expect(io.stdout.value).toContain('tokenBudget: 50/200000')
      expect(io.stdout.value).toContain('tokens 50/200000')
      expect(io.stdout.value).toContain('cache 75%')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('writes a structured compact boundary through /compact', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-commands-'))
    const transcriptPath = join(cwd, 'transcript.jsonl')
    const io = createTestIO()

    try {
      writeFileSync(
        transcriptPath,
        [
          usageRecord({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'pre compact work' },
          }),
          usageRecord({ type: 'message_stop' }),
        ].join(''),
        'utf8',
      )
      const session = await recordSession({
        cwd,
        sessionId: 'session_compact',
        transcriptPath,
        prompt: 'compact',
      })

      await runSlashCommand({
        command: '/compact',
        io,
        version: '0.5.0',
        cwd,
      })

      expect(io.stdout.value).toContain('Compact:')
      expect(io.stdout.value).toContain('sessionId: session_compact')
      const replay = await replaySession(session)
      expect(replay.restorePlan.compactState).toMatchObject({
        status: 'restored',
        summaryChars: expect.any(Number),
      })
      expect(replay.summary).toContain('Restored compact summary')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('prints effective permission sources from merged settings', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-commands-'))
    const io = createTestIO()

    try {
      mkdirSync(join(cwd, '.my-claude-code'), { recursive: true })
      writeFileSync(
        join(cwd, '.my-claude-code', 'settings.json'),
        JSON.stringify({
          allowedTools: ['Read'],
          disallowedTools: ['Bash'],
        }),
        'utf8',
      )

      await runSlashCommand({
        command: '/permissions',
        io,
        version: '0.4.0',
        cwd,
      })

      expect(io.stdout.value).toContain('allowedTools: Read')
      expect(io.stdout.value).toContain('disallowedTools: Bash')
      expect(io.stdout.value).toContain('settingsSources: project')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('persists project theme through the shared command handler', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-commands-'))
    const io = createTestIO()

    try {
      await runSlashCommand({
        command: '/theme auto',
        io,
        version: '0.4.0',
        cwd,
      })

      expect(io.stdout.value).toContain('active: auto')
      expect(io.stdout.value).toContain('Saved project theme.')
      await expect(loadSettings(cwd)).resolves.toEqual({
        theme: 'auto',
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('persists project output style through the shared command handler', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-commands-'))
    const io = createTestIO()

    try {
      await runSlashCommand({
        command: '/output-style Learning',
        io,
        version: '0.4.0',
        cwd,
      })
      await runSlashCommand({
        command: '/output-style',
        io,
        version: '0.4.0',
        cwd,
      })

      expect(io.stdout.value).toContain('active: Learning')
      expect(io.stdout.value).toContain('available: default, Explanatory, Learning')
      expect(io.stdout.value).toContain('Saved project output style.')
      await expect(loadSettings(cwd)).resolves.toEqual({
        outputStyle: 'Learning',
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('prints available output styles for invalid project output style changes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-commands-'))
    const io = createTestIO()

    try {
      await runSlashCommand({
        command: '/output-style unknown',
        io,
        version: '0.4.0',
        cwd,
      })

      expect(io.stdout.value).toContain('Unknown output style: unknown')
      expect(io.stdout.value).toContain('Available output styles: default, Explanatory, Learning')
      await expect(loadSettings(cwd)).resolves.toEqual({})
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('persists vim mode through the shared command handler', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-commands-'))
    const io = createTestIO()

    try {
      await runSlashCommand({
        command: '/vim on',
        io,
        version: '0.4.0',
        cwd,
      })
      await runSlashCommand({
        command: '/vim',
        io,
        version: '0.4.0',
        cwd,
      })

      expect(io.stdout.value).toContain('vimMode: on')
      expect(io.stdout.value).toContain('Saved project vim mode.')
      await expect(loadSettings(cwd)).resolves.toEqual({
        vimMode: true,
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('forks and rewinds sessions through /resume actions', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-commands-'))
    const transcriptPath = join(cwd, 'transcript.jsonl')
    const filePath = join(cwd, 'hello.txt')
    const io = createTestIO()

    try {
      writeFileSync(filePath, 'before', 'utf8')
      writeFileSync(
        transcriptPath,
        [
          transcriptRecord('record_first', 'first'),
          toolStartRecord('record_edit', 'toolu_edit', 'hello.txt'),
          transcriptRecord('record_second', ' second'),
        ].join(''),
        'utf8',
      )
      await recordSession({
        cwd,
        sessionId: 'session_resume',
        transcriptPath,
        prompt: 'previous',
      })
      await recordFileSnapshot({
        cwd,
        sessionId: 'session_resume',
        toolUseId: 'toolu_edit',
        toolName: 'Edit',
        filePath: 'hello.txt',
        now: new Date('2026-05-23T00:00:00.000Z'),
      })
      writeFileSync(filePath, 'after', 'utf8')

      await runSlashCommand({
        command: '/resume session_resume --checkpoints',
        io,
        version: '0.4.0',
        cwd,
      })
      await runSlashCommand({
        command: '/resume session_resume --fork',
        io,
        version: '0.4.0',
        cwd,
      })
      await runSlashCommand({
        command: '/resume session_resume --rewind record_first',
        io,
        version: '0.4.0',
        cwd,
      })
      await runSlashCommand({
        command: '/resume session_resume --rewind-files record_first',
        io,
        version: '0.4.0',
        cwd,
      })

      expect(io.stdout.value).toContain('Checkpoints for session_resume:')
      expect(io.stdout.value).toContain('Forked session_resume -> session_')
      expect(io.stdout.value).toContain('Rewound session_resume at record_first -> session_')
      expect(io.stdout.value).toContain('Rewound files for session_resume at record_first.')
      expect(io.stdout.value).toContain('restoredFiles: hello.txt')
      expect(readFileSync(filePath, 'utf8')).toBe('before')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('runs V2.1 source inventory closure checks from /parity --strict --source-inventory', async () => {
    const io = createTestIO()

    await runSlashCommand({
      command: '/parity --strict --source-inventory',
      io,
      version: '2.1.0',
      cwd: process.cwd(),
    })
    const report = JSON.parse(io.stdout.value) as {
      mode: string
      status: string
      checks: Array<{ label: string; status: string; detail: string }>
    }

    expect(report.mode).toBe('strict')
    expect(['pass', 'fail']).toContain(report.status)
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        label: 'strict V2.1 source inventory closure',
        status: 'pass',
      }),
    )
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        label: 'strict V2.1 native package smoke',
        status: 'pass',
      }),
    )
  })
})

async function waitForSlashOutput(args: {
  command: string
  io: ReturnType<typeof createTestIO>
  version: string
  cwd: string
  expected: string
}) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    args.io.stdout.value = ''
    await runSlashCommand({
      command: args.command,
      io: args.io,
      version: args.version,
      cwd: args.cwd,
    })
    if (args.io.stdout.value.includes(args.expected)) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  expect(args.io.stdout.value).toContain(args.expected)
}

function transcriptRecord(id: string, text: string): string {
  return `${JSON.stringify({
    id,
    session_id: 'session_resume',
    created_at: new Date('2026-05-23T00:00:00.000Z').toISOString(),
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text,
      },
    },
  })}\n`
}

function usageRecord(event: unknown, id: string = crypto.randomUUID()): string {
  return `${JSON.stringify({
    id,
    session_id: 'session_usage',
    created_at: new Date('2026-05-23T00:00:00.000Z').toISOString(),
    event,
  })}\n`
}

function toolStartRecord(id: string, toolUseId: string, filePath: string): string {
  return `${JSON.stringify({
    id,
    session_id: 'session_resume',
    created_at: new Date('2026-05-23T00:00:00.000Z').toISOString(),
    event: {
      type: 'tool_execution_start',
      tool_use_id: toolUseId,
      name: 'Edit',
      input: {
        file_path: filePath,
      },
    },
  })}\n`
}
