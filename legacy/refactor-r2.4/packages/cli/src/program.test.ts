import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { recordSession } from '@my-claude-code/session'
import { loadSettings } from '@my-claude-code/settings'
import { runCli } from './index.js'

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

describe('CLI fast paths', () => {
  it('prints version', async () => {
    const io = createTestIO()
    const exitCode = await runCli(['node', 'claude', '--version'], io)

    expect(exitCode).toBe(0)
    expect(io.stdout.value).toContain('1.0.0 (my-claude-code)')
  })

  it('prints help', async () => {
    const io = createTestIO()
    const exitCode = await runCli(['node', 'claude', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdout.value).toContain('Usage: claude')
    expect(io.stdout.value).toContain('--continue')
    expect(io.stdout.value).toContain('--resume')
    expect(io.stdout.value).toContain('--session-id')
    expect(io.stdout.value).toContain('--output-format')
    expect(io.stdout.value).toContain('--system-prompt')
    expect(io.stdout.value).toContain('--system-prompt-file')
    expect(io.stdout.value).toContain('--append-system-prompt')
    expect(io.stdout.value).toContain('--append-system-prompt-file')
    expect(io.stdout.value).toContain('--vim')
    expect(io.stdout.value).toContain('--fork')
    expect(io.stdout.value).toContain('--rewind')
    expect(io.stdout.value).toContain('--rewind-files')
    expect(io.stdout.value).toContain('--checkpoints')
    expect(io.stdout.value).toContain('--tui')
    expect(io.stdout.value).toContain('--voice')
    expect(io.stdout.value).toContain('--add-dir')
    expect(io.stdout.value).toContain('--mcp')
    expect(io.stdout.value).toContain('--compatibility-spike')
    expect(io.stdout.value).toContain('--compatibility-spike-live')
  })

  it('prints compatibility spike result', async () => {
    const io = createTestIO()
    const exitCode = await runCli(['node', 'claude', '--compatibility-spike'], io)

    expect(exitCode).toBe(0)
    expect(JSON.parse(io.stdout.value)).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    })
  })

  it('accepts doctor as a top-level command alias', async () => {
    const io = createTestIO()
    const exitCode = await runCli(['node', 'claude', 'doctor'], io)

    expect(exitCode).toBe(0)
    expect(io.stdout.value).toContain('Doctor:')
    expect(io.stdout.value).toContain('check cwd readable:')
  })

  it('uses a stable error prefix and non-zero exit code', async () => {
    const io = createTestIO()
    const exitCode = await runCli(['node', 'claude', '--unknown'], io)

    expect(exitCode).toBe(1)
    expect(io.stderr.value).toContain('error:')
  })

  it('streams print mode text deltas to stdout', async () => {
    const io = createTestIO()
    const exitCode = await runCli(['node', 'claude', '-p', 'hello'], io, {
      query: async function* (options) {
        expect(options.prompt).toBe('hello')
        yield {
          type: 'message_start',
          message: {
            id: 'msg_1',
            role: 'assistant',
            model: 'deepseek-v4-flash',
          },
        }
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hi' },
        }
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: ' there' },
        }
        yield {
          type: 'terminal',
          status: 'completed',
          exitCode: 0,
        }
      },
    })

    expect(exitCode).toBe(0)
    expect(io.stdout.value).toBe('hi there\n')
  })

  it('prints JSON output format in print mode', async () => {
    const io = createTestIO()
    const exitCode = await runCli(
      ['node', 'claude', '-p', 'hello', '--output-format', 'json'],
      io,
      {
        query: async function* () {
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'json answer' },
          }
          yield {
            type: 'terminal',
            status: 'completed',
            exitCode: 0,
          }
        },
      },
    )

    expect(exitCode).toBe(0)
    expect(JSON.parse(io.stdout.value)).toEqual({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'json answer',
    })
  })

  it('prints stream-json partial messages and final result', async () => {
    const io = createTestIO()
    const exitCode = await runCli(
      [
        'node',
        'claude',
        '-p',
        'hello',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
      ],
      io,
      {
        query: async function* () {
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'hi' },
          }
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: ' there' },
          }
          yield {
            type: 'terminal',
            status: 'completed',
            exitCode: 0,
          }
        },
      },
    )

    expect(exitCode).toBe(0)
    expect(io.stdout.value.trim().split('\n').map(line => JSON.parse(line))).toEqual([
      {
        type: 'assistant_delta',
        delta: 'hi',
      },
      {
        type: 'assistant_delta',
        delta: ' there',
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'hi there',
      },
    ])
  })

  it('validates json-schema output in print mode', async () => {
    const io = createTestIO()
    const exitCode = await runCli(
      [
        'node',
        'claude',
        '-p',
        'json',
        '--output-format',
        'json',
        '--json-schema',
        '{"type":"object","required":["answer"],"properties":{"answer":{"type":"string"}}}',
      ],
      io,
      {
        query: async function* () {
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: '{"answer":"ok"}' },
          }
          yield {
            type: 'terminal',
            status: 'completed',
            exitCode: 0,
          }
        },
      },
    )

    expect(exitCode).toBe(0)
    expect(JSON.parse(io.stdout.value)).toEqual({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: {
        answer: 'ok',
      },
      json_schema_validation: {
        valid: true,
        errors: [],
      },
    })
  })

  it('prints simplified status', async () => {
    const io = createTestIO()
    const exitCode = await runCli(['node', 'claude', '/status'], io)

    expect(exitCode).toBe(0)
    expect(JSON.parse(io.stdout.value)).toMatchObject({
      version: '1.0.0',
      model: 'deepseek-v4-flash',
      permissionMode: 'default',
    })
  })

  it('prints simplified permissions', async () => {
    const io = createTestIO()
    const exitCode = await runCli(
      [
        'node',
        'claude',
        '/permissions',
        '--allowed-tools',
        'Read,Write(README.md)',
        '--disallowed-tools',
        'Bash',
      ],
      io,
    )

    expect(exitCode).toBe(0)
    expect(io.stdout.value).toContain('allowedTools: Read, Write(README.md)')
    expect(io.stdout.value).toContain('disallowedTools: Bash')
    expect(io.stdout.value).toContain('registeredTools:')
  })

  it('passes CLI tool filters to print mode query options', async () => {
    const io = createTestIO()
    const exitCode = await runCli(
      [
        'node',
        'claude',
        '-p',
        'hello',
        '--tools',
        'Read,Write(README.md)',
        '--disallowed-tools',
        'Bash',
      ],
      io,
      {
        query: async function* (options) {
          expect(options.allowedTools).toEqual(['Read', 'Write(README.md)'])
          expect(options.disallowedTools).toEqual(['Bash'])
          yield {
            type: 'terminal',
            status: 'completed',
            exitCode: 0,
          }
        },
      },
    )

    expect(exitCode).toBe(0)
  })

  it('prints V0.4 slash command help', async () => {
    const io = createTestIO()
    const exitCode = await runCli(['node', 'claude', '/help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdout.value).toContain('/compact')
    expect(io.stdout.value).toContain('/context')
    expect(io.stdout.value).toContain('/resume')
  })

  it('prints selected model through /model', async () => {
    const io = createTestIO()
    const exitCode = await runCli(
      ['node', 'claude', '/model', '--model', 'deepseek-v4-flash'],
      io,
    )

    expect(exitCode).toBe(0)
    expect(io.stdout.value).toBe('deepseek-v4-flash\n')
  })

  it('passes session id and additional directories to print mode query options', async () => {
    const io = createTestIO()
    const exitCode = await runCli(
      [
        'node',
        'claude',
        '-p',
        'hello',
        '--session-id',
        'session_custom',
        '--add-dir',
        '../shared,/tmp/work',
      ],
      io,
      {
        query: async function* (options) {
          expect(options.sessionId).toBe('session_custom')
          expect(options.additionalDirectories).toEqual(['../shared', '/tmp/work'])
          yield {
            type: 'terminal',
            status: 'completed',
            exitCode: 0,
          }
        },
      },
    )

    expect(exitCode).toBe(0)
  })

  it('passes system prompt flags to print mode query options', async () => {
    const io = createTestIO()
    const exitCode = await runCli(
      [
        'node',
        'claude',
        '-p',
        'hello',
        '--system-prompt',
        'custom system',
        '--append-system-prompt',
        'extra rules',
      ],
      io,
      {
        query: async function* (options) {
          expect(options.systemPrompt).toBe('custom system')
          expect(options.appendSystemPrompt).toBe('extra rules')
          yield {
            type: 'terminal',
            status: 'completed',
            exitCode: 0,
          }
        },
      },
    )

    expect(exitCode).toBe(0)
  })

  it('loads system prompt flags from files', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-cli-'))
    const previousCwd = process.cwd()
    const systemPromptPath = join(cwd, 'system.txt')
    const appendPromptPath = join(cwd, 'append.txt')
    const io = createTestIO()

    try {
      writeFileSync(systemPromptPath, 'file system', 'utf8')
      writeFileSync(appendPromptPath, 'file append', 'utf8')
      process.chdir(cwd)

      const exitCode = await runCli(
        [
          'node',
          'claude',
          '-p',
          'hello',
          '--system-prompt-file',
          systemPromptPath,
          '--append-system-prompt',
          'inline append',
          '--append-system-prompt-file',
          appendPromptPath,
        ],
        io,
        {
          query: async function* (options) {
            expect(options.systemPrompt).toBe('file system')
            expect(options.appendSystemPrompt).toBe('inline append\n\nfile append')
            yield {
              type: 'terminal',
              status: 'completed',
              exitCode: 0,
            }
          },
        },
      )

      expect(exitCode).toBe(0)
    } finally {
      process.chdir(previousCwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('dumps the effective system prompt without calling the model', async () => {
    const io = createTestIO()
    let queryCalled = false
    const exitCode = await runCli(
      [
        'node',
        'claude',
        '--dump-system-prompt',
        '--system-prompt',
        'custom system',
        '--append-system-prompt',
        'extra rules',
      ],
      io,
      {
        query: async function* () {
          queryCalled = true
          yield { type: 'terminal', status: 'completed', exitCode: 0 }
        },
      },
    )

    expect(exitCode).toBe(0)
    expect(io.stdout.value).toBe('custom system\n\nextra rules\n')
    expect(io.stderr.value).toBe('')
    expect(queryCalled).toBe(false)
  })

  it('continues the latest session by replaying transcript context', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-cli-'))
    const previousCwd = process.cwd()
    const transcriptPath = join(cwd, 'transcript.jsonl')
    const io = createTestIO()

    try {
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          id: 'record_1',
          session_id: 'session_continue',
          created_at: new Date('2026-05-23T00:00:00.000Z').toISOString(),
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'text_delta',
              text: 'previous assistant answer',
            },
          },
        })}\n`,
        'utf8',
      )
      await recordSession({
        cwd,
        sessionId: 'session_continue',
        transcriptPath,
        prompt: 'previous prompt',
        now: new Date('2026-05-23T00:00:00.000Z'),
      })
      process.chdir(cwd)

      const exitCode = await runCli(
        ['node', 'claude', '-p', 'next prompt', '--continue'],
        io,
        {
          query: async function* (options) {
            expect(options.sessionId).toBe('session_continue')
            expect(options.transcriptPath).toBe(transcriptPath)
            expect(options.userContext).toContain('previous assistant answer')
            yield {
              type: 'terminal',
              status: 'completed',
              exitCode: 0,
            }
          },
        },
      )

      expect(exitCode).toBe(0)
    } finally {
      process.chdir(previousCwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('resumes an explicit session id by replaying transcript context', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-cli-'))
    const previousCwd = process.cwd()
    const transcriptPath = join(cwd, 'resume-transcript.jsonl')
    const io = createTestIO()

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
              text: 'explicit resume answer',
            },
          },
        })}\n`,
        'utf8',
      )
      await recordSession({
        cwd,
        sessionId: 'session_resume',
        transcriptPath,
        prompt: 'resume prompt',
        now: new Date('2026-05-23T00:00:00.000Z'),
      })
      process.chdir(cwd)

      const exitCode = await runCli(
        ['node', 'claude', '-p', 'next prompt', '--resume', 'session_resume'],
        io,
        {
          query: async function* (options) {
            expect(options.sessionId).toBe('session_resume')
            expect(options.transcriptPath).toBe(transcriptPath)
            expect(options.userContext).toContain('explicit resume answer')
            expect(options.messages).toEqual([
              {
                role: 'assistant',
                content: [
                  {
                    type: 'text',
                    text: 'explicit resume answer',
                  },
                ],
              },
            ])
            yield {
              type: 'terminal',
              status: 'completed',
              exitCode: 0,
            }
          },
        },
      )

      expect(exitCode).toBe(0)
    } finally {
      process.chdir(previousCwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('prints an empty resume list in a workspace without sessions', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-cli-'))
    const previousCwd = process.cwd()
    const io = createTestIO()

    try {
      process.chdir(cwd)
      const exitCode = await runCli(['node', 'claude', '/resume'], io)

      expect(exitCode).toBe(0)
      expect(io.stdout.value).toContain('Resume:')
      expect(io.stdout.value).toContain('No sessions found.')
    } finally {
      process.chdir(previousCwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('accepts slash commands with positional arguments', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-cli-'))
    const previousCwd = process.cwd()
    const io = createTestIO()

    try {
      process.chdir(cwd)
      const exitCode = await runCli(['node', 'claude', '/theme', 'dark'], io)

      expect(exitCode).toBe(0)
      expect(io.stdout.value).toContain('active: dark')
      await expect(loadSettings(cwd)).resolves.toEqual({
        theme: 'dark',
      })
    } finally {
      process.chdir(previousCwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('routes the top-level weixin command to the builtin Weixin channel surface', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-cli-'))
    const previousCwd = process.cwd()
    const io = createTestIO()

    try {
      process.chdir(cwd)
      const exitCode = await runCli(['node', 'claude', 'weixin', 'serve'], io)

      expect(exitCode).toBe(0)
      expect(JSON.parse(io.stdout.value)).toMatchObject({
        package: '@claude-code-best/weixin',
        status: 'serving',
        mcpServer: 'plugin:weixin:weixin',
      })
    } finally {
      process.chdir(previousCwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('forwards full ecosystem parity flags to /parity', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-cli-'))
    const previousCwd = process.cwd()
    const io = createTestIO()

    try {
      process.chdir(cwd)
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

      const exitCode = await runCli(['node', 'claude', '/parity', '--full'], io)
      const report = JSON.parse(io.stdout.value) as { mode: string; status: string }

      expect(exitCode).toBe(0)
      expect(report.mode).toBe('full-ecosystem')
      expect(report.status).toBe('fail')
    } finally {
      process.chdir(previousCwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('forwards strict parity flags to /parity', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-cli-'))
    const previousCwd = process.cwd()
    const io = createTestIO()

    try {
      process.chdir(cwd)
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

      const exitCode = await runCli(['node', 'claude', '/parity', '--strict', '--tui', '--platform', '--voice'], io)
      const report = JSON.parse(io.stdout.value) as {
        mode: string
        status: string
        checks: Array<{ label: string }>
      }

      expect(exitCode).toBe(0)
      expect(report.mode).toBe('strict')
      expect(report.status).toBe('fail')
      expect(report.checks).toContainEqual(
        expect.objectContaining({ label: 'strict TUI Ink internals' }),
      )
      expect(report.checks).toContainEqual(
        expect.objectContaining({ label: 'strict platform browser runtime' }),
      )
      expect(report.checks).toContainEqual(
        expect.objectContaining({ label: 'strict voice runtime' }),
      )
    } finally {
      process.chdir(previousCwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('accepts vim slash command and CLI vim flag', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-cli-'))
    const previousCwd = process.cwd()
    const io = createTestIO()

    try {
      process.chdir(cwd)
      const exitCode = await runCli(['node', 'claude', '/vim', '--vim'], io)

      expect(exitCode).toBe(0)
      expect(io.stdout.value).toContain('vimMode: on')
    } finally {
      process.chdir(previousCwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('accepts /resume slash command action flags after positional args', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-cli-'))
    const previousCwd = process.cwd()
    const transcriptPath = join(cwd, 'resume-transcript.jsonl')
    const io = createTestIO()

    try {
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          id: 'record_first',
          session_id: 'session_resume',
          created_at: new Date('2026-05-23T00:00:00.000Z').toISOString(),
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'text_delta',
              text: 'checkpoint text',
            },
          },
        })}\n`,
        'utf8',
      )
      await recordSession({
        cwd,
        sessionId: 'session_resume',
        transcriptPath,
        prompt: 'resume prompt',
      })
      process.chdir(cwd)

      const exitCode = await runCli([
        'node',
        'claude',
        '/resume',
        'session_resume',
        '--checkpoints',
      ], io)

      expect(exitCode).toBe(0)
      expect(io.stdout.value).toContain('Checkpoints for session_resume:')
      expect(io.stdout.value).toContain('record_first')
    } finally {
      process.chdir(previousCwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
