import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { query } from '@my-claude-code/agent-runtime'
import { loadSettings } from '@my-claude-code/settings'
import { readSessionIndex, recordSession } from '@my-claude-code/session'
import { runTerminalApp } from './terminalApp.js'
import { buildPromptContent, parseTuiResumePrompt } from './TuiApp.js'
import { DEFAULT_INTERACTIVE_MAX_TURNS } from './tuiTypes.js'

describe('terminal app launcher', () => {
  it('falls back to the line shell for non-TTY streams', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.on('data', chunk => {
      text += chunk.toString()
    })

    const app = runTerminalApp({ input, output })
    input.write('/doctor\n')
    input.write('/exit\n')
    await app

    expect(text).toContain('interactive shell')
    expect(text).toContain('Doctor:')
    expect(text).toContain('bye')
  })

  it('can launch the Ink TUI on TTY-like streams', async () => {
    const input = createTtyInput()
    const output = createTtyOutput()
    let text = ''
    output.on('data', chunk => {
      text += chunk.toString()
    })

    const app = runTerminalApp({ input, output, forceInk: true })
    await delay(20)
    input.write('\u0004')

    await Promise.race([
      app,
      delay(1000).then(() => {
        throw new Error('Ink TUI did not exit after Ctrl+D')
      }),
    ])

    expect(stripAnsi(text)).toContain('my-claude-code')
    expect(stripAnsi(text)).toContain('SessionStart:startup')
  })

  it('keeps the prompt visible after a streamed answer', async () => {
    const input = createTtyInput()
    const output = createTtyOutput()
    let text = ''
    output.on('data', chunk => {
      text += chunk.toString()
    })

    const app = runTerminalApp({
      input,
      output,
      forceInk: true,
      queryRuntime: fakeQuery('short answer') as typeof query,
    })
    await delay(20)
    input.write('hello')
    await delay(20)
    input.write('\r')
    await delay(80)
    input.write('\u0004')

    await Promise.race([
      app,
      delay(1000).then(() => {
        throw new Error('Ink TUI did not exit after streamed answer')
      }),
    ])

    const rendered = stripAnsi(text)
    expect(rendered).toContain('● short answer')
    expect(rendered.lastIndexOf('>')).toBeGreaterThan(
      rendered.lastIndexOf('● short answer'),
    )
  })

  it('uses a larger default maxTurns budget for interactive chat', async () => {
    const input = createTtyInput()
    const output = createTtyOutput()
    let observedMaxTurns: number | undefined

    const app = runTerminalApp({
      input,
      output,
      forceInk: true,
      queryRuntime: (async function* (options: { maxTurns?: number }) {
        observedMaxTurns = options.maxTurns
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: 'turn budget ok',
          },
        } as const
        yield { type: 'message_stop' } as const
      }) as typeof query,
    })
    await delay(20)
    input.write('needs tools')
    await delay(20)
    input.write('\r')
    await delay(80)
    input.write('\u0004')

    await Promise.race([
      app,
      delay(1000).then(() => {
        throw new Error('Ink TUI did not exit after maxTurns capture')
      }),
    ])

    expect(observedMaxTurns).toBe(DEFAULT_INTERACTIVE_MAX_TURNS)
  })

  it('lets explicit maxTurns override the interactive default', async () => {
    const input = createTtyInput()
    const output = createTtyOutput()
    let observedMaxTurns: number | undefined

    const app = runTerminalApp({
      input,
      output,
      forceInk: true,
      maxTurns: 3,
      queryRuntime: (async function* (options: { maxTurns?: number }) {
        observedMaxTurns = options.maxTurns
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: 'explicit turn budget ok',
          },
        } as const
        yield { type: 'message_stop' } as const
      }) as typeof query,
    })
    await delay(20)
    input.write('limited tools')
    await delay(20)
    input.write('\r')
    await delay(80)
    input.write('\u0004')

    await Promise.race([
      app,
      delay(1000).then(() => {
        throw new Error('Ink TUI did not exit after explicit maxTurns capture')
      }),
    ])

    expect(observedMaxTurns).toBe(3)
  })

  it('keeps streamed assistant text before terminal max_turns errors', async () => {
    const input = createTtyInput()
    const output = createTtyOutput()
    let text = ''
    output.on('data', chunk => {
      text += chunk.toString()
    })

    const app = runTerminalApp({
      input,
      output,
      forceInk: true,
      queryRuntime: (async function* () {
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: 'Let me search first.',
          },
        } as const
        yield {
          type: 'terminal',
          status: 'max_turns',
          exitCode: 1,
          reason: 'model requested tool use, but maxTurns does not allow another model turn',
        } as const
      }) as typeof query,
    })
    await delay(20)
    input.write('low turn budget')
    await delay(20)
    input.write('\r')
    await delay(100)
    input.write('\u0004')

    await Promise.race([
      app,
      delay(1000).then(() => {
        throw new Error('Ink TUI did not exit after terminal error ordering check')
      }),
    ])

    const rendered = stripAnsi(text)
    expect(rendered.indexOf('● Let me search first.')).toBeGreaterThan(-1)
    expect(rendered.indexOf('Error: model requested tool use')).toBeGreaterThan(
      rendered.indexOf('● Let me search first.'),
    )
  })

  it('keeps tool progress events out of the chat transcript', async () => {
    const input = createTtyInput()
    const output = createTtyOutput()
    let text = ''
    output.on('data', chunk => {
      text += chunk.toString()
    })

    const app = runTerminalApp({
      input,
      output,
      forceInk: true,
      queryRuntime: fakeToolProgressThenAnswerQuery() as typeof query,
    })
    await delay(20)
    input.write('who is Trump?')
    await delay(20)
    input.write('\r')
    await delay(120)
    input.write('\u0004')

    await Promise.race([
      app,
      delay(1000).then(() => {
        throw new Error('Ink TUI did not exit after tool progress events')
      }),
    ])

    const rendered = stripAnsi(text)
    expect(rendered).toContain('answer still renders')
    expect(rendered).not.toContain('WebSearch running')
    expect(rendered).not.toContain('WebSearch done')
    expect(rendered).not.toContain('Grep running')
    expect(rendered).not.toContain('Grep done')
    expect(rendered).not.toContain('Glob running')
    expect(rendered).not.toContain('Glob failed: path is outside the current workspace')
  })

  it('shows a waiting indicator before the first streamed text arrives', async () => {
    const input = createTtyInput()
    const output = createTtyOutput()
    let text = ''
    output.on('data', chunk => {
      text += chunk.toString()
    })

    const app = runTerminalApp({
      input,
      output,
      forceInk: true,
      queryRuntime: fakeDelayedAnswerQuery() as typeof query,
    })
    await delay(20)
    input.write('slow question')
    await delay(20)
    input.write('\r')
    await delay(170)
    input.write('\u0004')

    await Promise.race([
      app,
      delay(1000).then(() => {
        throw new Error('Ink TUI did not exit after delayed answer')
      }),
    ])

    const rendered = stripAnsi(text)
    expect(rendered).toContain('Thinking')
    expect(rendered).toContain('delayed answer')
  })

  it('parses mouse wheel input without leaking SGR bytes into the prompt', async () => {
    const input = createTtyInput()
    const output = createTtyOutput()
    let text = ''
    output.on('data', chunk => {
      text += chunk.toString()
    })

    const app = runTerminalApp({
      input,
      output,
      forceInk: true,
      queryRuntime: fakeQuery('short answer') as typeof query,
    })
    await delay(20)
    input.write('hello')
    await delay(20)
    input.write('\r')
    await delay(80)
    input.write('\x1B[<64;20;10M')
    await delay(20)
    input.write('\u0004')

    await Promise.race([
      app,
      delay(1000).then(() => {
        throw new Error('Ink TUI did not exit after wheel input')
      }),
    ])

    expect(stripAnsi(text)).not.toContain('[<64;20;10M')
  })

  it('opens V1.6 command surfaces as Ink overlays', async () => {
    const input = createTtyInput()
    const output = createTtyOutput()
    let text = ''
    output.on('data', chunk => {
      text += chunk.toString()
    })

    const app = runTerminalApp({ input, output, forceInk: true })
    await delay(20)
    input.write('/settings')
    await delay(20)
    input.write('\r')
    await delay(80)
    input.write('\u001b')
    await delay(20)
    input.write('\u0004')

    await Promise.race([
      app,
      delay(1000).then(() => {
        throw new Error('Ink TUI did not exit after V1.6 overlay')
      }),
    ])

    const rendered = stripAnsi(text)
    expect(rendered).toContain('permissionMode')
  })

  it('keeps the tail of a chunked growing answer visible', async () => {
    const input = createTtyInput()
    const output = createTtyOutput()
    let text = ''
    output.on('data', chunk => {
      text += chunk.toString()
    })

    const app = runTerminalApp({
      input,
      output,
      forceInk: true,
      queryRuntime: fakeChunkedQuery([
        'start',
        ` ${'middle '.repeat(40)}FINAL_TAIL_VISIBLE`,
      ]) as typeof query,
    })
    await delay(20)
    input.write('hello')
    await delay(20)
    input.write('\r')
    await delay(140)
    input.write('\u0004')

    await Promise.race([
      app,
      delay(1000).then(() => {
        throw new Error('Ink TUI did not exit after chunked streamed answer')
      }),
    ])

    expect(stripAnsi(text)).toContain('FINAL_TAIL_VISIBLE')
    expect(stripAnsi(text)).toContain('█')
  })

  it('keeps a committed previous answer visible while a follow-up streams', async () => {
    const input = createTtyInput()
    const output = createTtyOutput()
    output.rows = 30
    let text = ''
    output.on('data', chunk => {
      text += chunk.toString()
    })

    const app = runTerminalApp({
      input,
      output,
      forceInk: true,
      queryRuntime: fakePromptQuery({
        first: ['first answer\nfirst detail\n'],
        second: ['second answer starts\n', 'second answer final'],
      }) as typeof query,
    })
    await delay(20)
    input.write('first')
    await delay(20)
    input.write('\r')
    await delay(120)
    input.write('second')
    await delay(20)
    input.write('\r')
    await delay(180)
    input.write('\u0004')

    await Promise.race([
      app,
      delay(1200).then(() => {
        throw new Error('Ink TUI did not exit after follow-up stream')
      }),
    ])

    const rendered = stripAnsi(text)
    expect(rendered).toContain('● first answer')
    expect(rendered).toContain('  first detail')
    expect(rendered).toContain('› second')
    expect(rendered).toContain('● second answer starts')
    expect(rendered).toContain('second answer final')
  })

  it('parses TUI resume actions without folding options into the id', () => {
    expect(parseTuiResumePrompt('/resume session_a --fork')).toEqual({
      sessionId: 'session_a',
      action: 'fork',
      recordId: undefined,
    })
    expect(parseTuiResumePrompt('/resume session_a --rewind record_1')).toEqual({
      sessionId: 'session_a',
      action: 'rewind',
      recordId: 'record_1',
    })
    expect(parseTuiResumePrompt('/resume session_a --checkpoints')).toEqual({
      sessionId: 'session_a',
      action: 'checkpoints',
      recordId: undefined,
    })
  })

  it('builds native image prompt content for clipboard image references', () => {
    expect(buildPromptContent('describe @image:clipboard', {
      mediaType: 'image/png',
      dataBase64: Buffer.from('png').toString('base64'),
      byteLength: 3,
    })).toEqual([
      { type: 'text', text: 'describe @image:clipboard' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from('png').toString('base64'),
        },
      },
    ])
    expect(buildPromptContent('describe text only', undefined)).toBeUndefined()
  })

  it('handles /resume <id> --fork inside the Ink TUI', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-tui-'))
    const transcriptPath = join(cwd, 'transcript.jsonl')
    const input = createTtyInput()
    const output = createTtyOutput()
    let text = ''
    output.on('data', chunk => {
      text += chunk.toString()
    })

    try {
      writeFileSync(transcriptPath, '', 'utf8')
      await recordSession({
        cwd,
        sessionId: 'session_resume',
        transcriptPath,
        prompt: 'previous prompt',
      })

      const app = runTerminalApp({ input, output, cwd, forceInk: true })
      await delay(20)
      input.write('/resume session_resume --fork')
      await delay(20)
      input.write('\r')
      await delay(120)
      input.write('\u0004')

      await Promise.race([
        app,
        delay(1000).then(() => {
          throw new Error('Ink TUI did not exit after resume fork')
        }),
      ])

      const rendered = stripAnsi(text)
      expect(rendered).toContain('Forked session_resume -> session_')
      expect(rendered).not.toContain('No session found: session_resume --fork')
      expect((await readSessionIndex(cwd)).sessions.some(session =>
        session.parentSessionId === 'session_resume' &&
        session.forkReason === 'fork',
      )).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('handles /resume <id> --rewind <record> inside the Ink TUI', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-tui-'))
    const transcriptPath = join(cwd, 'transcript.jsonl')
    const input = createTtyInput()
    const output = createTtyOutput()
    let text = ''
    output.on('data', chunk => {
      text += chunk.toString()
    })

    try {
      writeFileSync(
        transcriptPath,
        [
          transcriptRecord('record_first', 'first'),
          transcriptRecord('record_second', 'second'),
        ].join(''),
        'utf8',
      )
      await recordSession({
        cwd,
        sessionId: 'session_resume',
        transcriptPath,
        prompt: 'previous prompt',
      })

      const app = runTerminalApp({ input, output, cwd, forceInk: true })
      await delay(20)
      input.write('/resume session_resume --rewind record_first')
      await delay(20)
      input.write('\r')
      await delay(120)
      input.write('\u0004')

      await Promise.race([
        app,
        delay(1000).then(() => {
          throw new Error('Ink TUI did not exit after resume rewind')
        }),
      ])

      const rendered = stripAnsi(text)
      expect(rendered).toContain('Rewound session_resume at record_first ->')
      expect(rendered).toMatch(/session_[0-9a-f-]{36}/)
      expect(rendered).not.toContain(
        'No session found: session_resume --rewind record_first',
      )
      expect((await readSessionIndex(cwd)).sessions.some(session =>
        session.parentSessionId === 'session_resume' &&
        session.forkReason === 'rewind' &&
        session.rewindRecordId === 'record_first',
      )).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('refreshes TUI theme state after /theme uses the shared handler', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-tui-'))
    const input = createTtyInput()
    const output = createTtyOutput()
    let text = ''
    output.on('data', chunk => {
      text += chunk.toString()
    })

    try {
      const app = runTerminalApp({ input, output, cwd, forceInk: true })
      await delay(20)
      input.write('/theme dark')
      await delay(20)
      input.write('\r')
      await delay(120)
      input.write('\u001B')
      await delay(20)
      input.write('\u0004')

      await Promise.race([
        app,
        delay(1000).then(() => {
          throw new Error('Ink TUI did not exit after theme update')
        }),
      ])

      expect(await loadSettings(cwd)).toMatchObject({ theme: 'dark' })
      expect(stripAnsi(text)).toContain('active: dark')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

function fakeQuery(text: string) {
  return async function* () {
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text,
      },
    } as const
    yield {
      type: 'message_stop',
    } as const
  }
}

function fakeChunkedQuery(chunks: string[]) {
  return async function* () {
    for (const text of chunks) {
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text,
        },
      } as const
      await delay(20)
    }
    yield {
      type: 'message_stop',
    } as const
  }
}

function fakeToolProgressThenAnswerQuery() {
  return async function* () {
    yield {
      type: 'tool_execution_start',
      tool_use_id: 'toolu_websearch',
      name: 'WebSearch',
      input: { query: 'who is kebin' },
    } as const
    yield {
      type: 'tool_execution_result',
      tool_use_id: 'toolu_websearch',
      name: 'WebSearch',
      content: '[]',
      is_error: false,
    } as const
    yield {
      type: 'tool_execution_start',
      tool_use_id: 'toolu_grep',
      name: 'Grep',
      input: { pattern: 'kebin' },
    } as const
    yield {
      type: 'tool_execution_result',
      tool_use_id: 'toolu_grep',
      name: 'Grep',
      content: 'no matches',
      is_error: false,
    } as const
    yield {
      type: 'tool_execution_start',
      tool_use_id: 'toolu_glob',
      name: 'Glob',
      input: { pattern: '**/*', path: '/' },
    } as const
    yield {
      type: 'tool_execution_result',
      tool_use_id: 'toolu_glob',
      name: 'Glob',
      content: 'path is outside the current workspace: /',
      is_error: true,
    } as const
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: 'answer still renders',
      },
    } as const
    yield {
      type: 'message_stop',
    } as const
  }
}

function fakeDelayedAnswerQuery() {
  return async function* () {
    await delay(140)
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: 'delayed answer',
      },
    } as const
    yield {
      type: 'message_stop',
    } as const
  }
}

function fakePromptQuery(responses: Record<string, string[]>) {
  return async function* (options: { prompt: string }) {
    for (const text of responses[options.prompt] ?? [`answer for ${options.prompt}`]) {
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text,
        },
      } as const
      await delay(20)
    }
    yield {
      type: 'message_stop',
    } as const
  }
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

function createTtyInput(): NodeJS.ReadStream {
  const input = new PassThrough() as PassThrough & {
    isTTY: true
    setRawMode(enabled: boolean): PassThrough
    ref(): PassThrough
    unref(): PassThrough
  }
  input.isTTY = true
  input.setRawMode = () => input
  input.ref = () => input
  input.unref = () => input
  return input as unknown as NodeJS.ReadStream
}

function createTtyOutput(): NodeJS.WriteStream {
  const output = new PassThrough() as PassThrough & {
    isTTY: true
    columns: number
    rows: number
    getColorDepth(): number
    hasColors(): boolean
  }
  output.isTTY = true
  output.columns = 80
  output.rows = 24
  output.getColorDepth = () => 8
  output.hasColors = () => true
  return output as unknown as NodeJS.WriteStream
}

function stripAnsi(value: string): string {
  const esc = String.fromCharCode(27)
  return value.replace(new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]`, 'g'), '')
}
