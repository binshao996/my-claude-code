import { describe, expect, it } from 'bun:test'
import {
  appendPromptInput,
  applyPromptVimKey,
  applyPromptCompletion,
  completeSlashCommandBuffer,
  completeSlashCommand,
  deletePromptInputBackward,
  deletePromptInputForward,
  deletePromptLineBackward,
  deletePromptLineForward,
  deletePromptSelection,
  deletePromptWordBackward,
  insertPromptInput,
  insertPromptNewlineBuffer,
  insertPromptNewline,
  isBackspaceInput,
  isDeleteInput,
  isTerminalControlInput,
  movePromptCursor,
  normalizePromptInput,
  movePromptCompletionSelection,
  parseSgrMouseEvent,
  promptCompletionMenu,
  promptCompletionPayloads,
  promptCompletionSourceFooter,
  promptCursorFromMouseColumn,
  promptDeletionDirection,
  promptSelectionRange,
  renderPromptWithCursor,
  replacePromptSelection,
  renderPromptWithSelection,
  sanitizeTerminalControlInput,
  searchPromptHistory,
  selectedPromptText,
  selectedPromptCompletion,
  slashCommandCandidates,
} from './promptEditing.js'

describe('PromptInput editing helpers', () => {
  it('normalizes pasted multiline input', () => {
    expect(normalizePromptInput('a\r\nb\rc')).toBe('a\nb\nc')
    expect(appendPromptInput('>', 'a\r\nb')).toBe('>a\nb')
  })

  it('completes unique slash commands only', () => {
    expect(completeSlashCommand('/doct')).toBe('/doctor')
    expect(completeSlashCommand('/st')).toBe('/st')
    expect(completeSlashCommand('hello')).toBe('hello')
    expect(slashCommandCandidates('/do')).toEqual(['/doctor'])
    expect(slashCommandCandidates('hello')).toEqual([])
  })

  it('inserts prompt newlines for multiline editing', () => {
    expect(insertPromptNewline('line 1')).toBe('line 1\n')
  })

  it('edits text at the cursor', () => {
    expect(insertPromptInput({ value: 'ab', cursor: 1 }, 'X')).toEqual({
      value: 'aXb',
      cursor: 2,
    })
    expect(deletePromptInputBackward({ value: 'aXb', cursor: 2 })).toEqual({
      value: 'ab',
      cursor: 1,
    })
    expect(deletePromptInputForward({ value: 'aXb', cursor: 1 })).toEqual({
      value: 'ab',
      cursor: 1,
    })
    expect(insertPromptInput({ value: '', cursor: 0 }, 'abc\x7F')).toEqual({
      value: 'ab',
      cursor: 2,
    })
    expect(isBackspaceInput('\x7F')).toBe(true)
    expect(isBackspaceInput('\b')).toBe(true)
    expect(isBackspaceInput('x')).toBe(false)
    expect(isDeleteInput('\x1B[3~')).toBe(true)
    expect(isDeleteInput('[3~')).toBe(true)
    expect(isDeleteInput('\x1B[3;1:1~')).toBe(true)
    expect(promptDeletionDirection('', { delete: true })).toBe('backward')
    expect(promptDeletionDirection('\x1B[3~', { delete: true })).toBe('forward')
    expect(promptDeletionDirection('', { backspace: true })).toBe('backward')
  })

  it('moves and renders the cursor', () => {
    expect(movePromptCursor({ value: 'abc', cursor: 1 }, 'left')).toEqual({
      value: 'abc',
      cursor: 0,
    })
    expect(movePromptCursor({ value: 'abc', cursor: 1 }, 'end')).toEqual({
      value: 'abc',
      cursor: 3,
    })
    expect(movePromptCursor({ value: 'one two', cursor: 7 }, 'wordLeft')).toEqual({
      value: 'one two',
      cursor: 4,
    })
    expect(movePromptCursor({ value: 'one two', cursor: 0 }, 'wordRight')).toEqual({
      value: 'one two',
      cursor: 4,
    })
    expect(movePromptCursor({ value: 'one\ntwo', cursor: 6 }, 'lineStart')).toEqual({
      value: 'one\ntwo',
      cursor: 4,
    })
    expect(renderPromptWithCursor({ value: 'abc', cursor: 1 })).toEqual({
      before: 'a',
      cursor: 'b',
      after: 'c',
    })
  })

  it('updates cursor after newline and slash completion', () => {
    expect(insertPromptNewlineBuffer({ value: 'a', cursor: 1 })).toEqual({
      value: 'a\n',
      cursor: 2,
    })
    expect(completeSlashCommandBuffer({ value: '/doct', cursor: 2 })).toEqual({
      value: '/doctor',
      cursor: 7,
    })
  })

  it('supports a selectable slash completion menu', () => {
    const menu = promptCompletionMenu('/s')
    expect(menu.candidates).toEqual([
      '/settings',
      '/skills',
      '/sandbox',
      '/schedule',
      '/status',
      '/statusline',
    ])
    expect(menu.selectedIndex).toBe(0)
    expect(selectedPromptCompletion(menu)).toEqual({
      value: '/settings',
      description: 'Show structured settings sources and effective values',
      source: 'slash-command',
    })

    const moved = movePromptCompletionSelection(menu, 'next')
    expect(moved.selectedIndex).toBe(1)
    expect(
      applyPromptCompletion({ value: '/s', cursor: 2 }, moved.candidates[moved.selectedIndex]),
    ).toEqual({
      value: '/skills',
      cursor: '/skills'.length,
    })
  })

  it('supports slash argument and project file completions', () => {
    expect(promptCompletionMenu('/resume --r').details).toEqual([
      {
        value: '--rewind',
        description: 'Fork a session at a transcript checkpoint',
        source: 'slash-argument',
        replacement: '/resume --rewind',
      },
      {
        value: '--rewind-files',
        description: 'Restore file snapshots at a checkpoint',
        source: 'slash-argument',
        replacement: '/resume --rewind-files',
      },
    ])

    const menu = promptCompletionMenu('read @src/', 0, 6, {
      filePaths: ['README.md', 'src/app.ts', 'src/index.ts'],
    })
    expect(menu.details.map(detail => detail.value)).toEqual([
      '@src/app.ts',
      '@src/index.ts',
    ])
    expect(applyPromptCompletion(
      { value: 'read @src/', cursor: 'read @src/'.length },
      menu.details[0],
    )).toEqual({
      value: 'read @src/app.ts',
      cursor: 'read @src/app.ts'.length,
    })
  })

  it('supports prompt suggestion and MCP resource completions', () => {
    expect(promptCompletionMenu('review', 0, 6, {
      promptSuggestions: ['review the current git diff'],
    }).details).toEqual([
      {
        value: 'review the current git diff',
        description: 'Prompt suggestion',
        source: 'prompt-suggestion',
        replacement: 'review the current git diff',
      },
    ])

    expect(promptCompletionMenu('load @mcp:repo', 0, 6, {
      mcpResources: ['repo://readme'],
    }).details).toEqual([
      {
        value: '@mcp:repo://readme',
        description: 'MCP resource',
        source: 'mcp-resource',
        replacement: '@mcp:repo://readme',
        replaceStart: 'load '.length,
        replaceEnd: 'load @mcp:repo'.length,
      },
    ])
  })

  it('supports agent and queued command completions', () => {
    expect(promptCompletionMenu('ask @agent:rev', 0, 6, {
      agents: ['reviewer'],
    }).details).toEqual([
      {
        value: '@agent:reviewer',
        description: 'Agent',
        source: 'agent',
        replacement: '@agent:reviewer',
        replaceStart: 'ask '.length,
        replaceEnd: 'ask @agent:rev'.length,
      },
    ])

    expect(promptCompletionMenu('!ty', 0, 6, {
      queuedCommands: ['typecheck'],
    }).details).toEqual([
      {
        value: '!typecheck',
        description: 'Queued command',
        source: 'queued-command',
        replacement: '!typecheck',
        replaceStart: 0,
        replaceEnd: '!ty'.length,
      },
    ])
  })

  it('supports Slack, IDE, image, and voice completion payloads', () => {
    expect(promptCompletionMenu('ask #dev', 0, 6, {
      slackChannels: ['dev-chat'],
    }).details).toEqual([
      {
        value: '#dev-chat',
        description: 'Slack channel',
        source: 'slack-channel',
        replacement: '#dev-chat',
        replaceStart: 'ask '.length,
        replaceEnd: 'ask #dev'.length,
      },
    ])

    expect(promptCompletionMenu('use @ide:diag', 0, 6, {
      ideMentions: ['diagnostics'],
    }).details).toEqual([
      {
        value: '@ide:diagnostics',
        description: 'IDE context',
        source: 'ide-mention',
        replacement: '@ide:diagnostics',
        replaceStart: 'use '.length,
        replaceEnd: 'use @ide:diag'.length,
      },
    ])

    expect(promptCompletionPayloads('attach @image:clip', 6, {
      imageAttachments: ['clipboard'],
      voiceActions: ['dictate'],
    })).toEqual([
      {
        value: '@image:clipboard',
        label: '@image:clipboard',
        description: 'Image attachment',
        source: 'image-attachment',
        replacement: '@image:clipboard',
        replaceStart: 'attach '.length,
        replaceEnd: 'attach @image:clip'.length,
      },
    ])
    expect(promptCompletionPayloads('start @voice:dic', 6, {
      voiceActions: ['dictate'],
    })[0]).toMatchObject({
      source: 'voice-action',
      replacement: '@voice:dictate',
    })
    expect(promptCompletionSourceFooter({
      slackChannels: ['dev'],
      ideMentions: ['current-file'],
      imageAttachments: ['clipboard'],
      voiceActions: ['dictate'],
    })).toBe('  completions:#slack,@ide,@image,@voice')
  })

  it('supports readline-style deletion helpers', () => {
    expect(deletePromptWordBackward({ value: 'one two three', cursor: 13 })).toEqual({
      value: 'one two ',
      cursor: 8,
    })
    expect(deletePromptLineBackward({ value: 'one\ntwo three', cursor: 9 })).toEqual({
      value: 'one\nhree',
      cursor: 4,
    })
    expect(deletePromptLineForward({ value: 'one\ntwo three', cursor: 6 })).toEqual({
      value: 'one\ntw',
      cursor: 6,
    })
  })

  it('searches prompt history from newest to oldest', () => {
    const history = [
      'create readme',
      'run tests',
      'fix readme typo',
    ]

    expect(searchPromptHistory(history, 'readme')).toEqual({
      index: 2,
      value: 'fix readme typo',
    })
    expect(searchPromptHistory(history, 'readme', 1)).toEqual({
      index: 0,
      value: 'create readme',
    })
    expect(searchPromptHistory(history, 'readme', 1, { wrap: true })).toEqual({
      index: 0,
      value: 'create readme',
    })
    expect(searchPromptHistory(history, 'run', 0, { wrap: true })).toEqual({
      index: 1,
      value: 'run tests',
    })
    expect(searchPromptHistory(history, 'missing')).toBeUndefined()
  })

  it('applies Vim prompt normal-mode editing keys', () => {
    expect(applyPromptVimKey({
      buffer: { value: 'abc', cursor: 3 },
      mode: 'insert',
      keyName: 'escape',
    })).toEqual({
      buffer: { value: 'abc', cursor: 2 },
      mode: 'normal',
      handled: true,
    })
    expect(applyPromptVimKey({
      buffer: { value: 'one two', cursor: 0 },
      mode: 'normal',
      keyName: 'w',
    })).toMatchObject({
      buffer: { value: 'one two', cursor: 4 },
      mode: 'normal',
      handled: true,
    })
    expect(applyPromptVimKey({
      buffer: { value: 'one\ntwo\nthree', cursor: 5 },
      mode: 'normal',
      pendingOperator: 'd',
      keyName: 'd',
    })).toMatchObject({
      buffer: { value: 'one\nthree', cursor: 4 },
      mode: 'normal',
      handled: true,
    })
    expect(applyPromptVimKey({
      buffer: { value: 'abc', cursor: 1 },
      mode: 'normal',
      keyName: 'enter',
    })).toMatchObject({
      submit: true,
      handled: true,
    })
  })

  it('tracks selection ranges and replaces selected text', () => {
    const selection = { anchor: 1, focus: 4 }

    expect(promptSelectionRange('abcdef', selection)).toEqual({
      start: 1,
      end: 4,
    })
    expect(selectedPromptText('abcdef', selection)).toBe('bcd')
    expect(renderPromptWithSelection(
      { value: 'abcdef', cursor: 4 },
      selection,
    )).toEqual({
      before: 'a',
      selected: 'bcd',
      after: 'ef',
    })
    expect(replacePromptSelection(
      { value: 'abcdef', cursor: 4 },
      selection,
      'X',
    )).toEqual({
      value: 'aXef',
      cursor: 2,
    })
    expect(deletePromptSelection(
      { value: 'abcdef', cursor: 4 },
      selection,
    )).toEqual({
      value: 'aef',
      cursor: 1,
    })
  })

  it('parses SGR mouse events for prompt selection', () => {
    expect(parseSgrMouseEvent('\x1B[<0;6;20M')).toEqual({
      type: 'press',
      column: 6,
      row: 20,
    })
    expect(parseSgrMouseEvent('[<65;75;11M')).toEqual({
      type: 'wheelDown',
      column: 75,
      row: 11,
    })
    expect(parseSgrMouseEvent('[<64;75;11M')).toEqual({
      type: 'wheelUp',
      column: 75,
      row: 11,
    })
    expect(parseSgrMouseEvent('[<65;75;11Mgood')).toBeUndefined()
    expect(parseSgrMouseEvent('\x1B[<32;8;20M')).toEqual({
      type: 'drag',
      column: 8,
      row: 20,
    })
    expect(parseSgrMouseEvent('\x1B[<0;8;20m')).toEqual({
      type: 'release',
      column: 8,
      row: 20,
    })
    expect(promptCursorFromMouseColumn('abcdef', 5)).toBe(2)
    expect(promptCursorFromMouseColumn('abcdef', 80)).toBe(6)
    expect(sanitizeTerminalControlInput('[<65;75;11Mgood')).toBe('good')
    expect(sanitizeTerminalControlInput('\x1B[?1006hgood')).toBe('good')
    expect(isTerminalControlInput('[<65;75;11M')).toBe(true)
    expect(isTerminalControlInput('\x1B[?1006h')).toBe(true)
    expect(isTerminalControlInput('[A')).toBe(true)
    expect(isTerminalControlInput('hello')).toBe(false)
  })
})
