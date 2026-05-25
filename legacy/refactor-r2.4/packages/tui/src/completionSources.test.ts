import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  collectPromptCompletionAgents,
  collectPromptCompletionFilePaths,
  collectPromptCompletionMcpResources,
  collectPromptPlatformCompletionSources,
  DEFAULT_IDE_MENTION_COMPLETIONS,
  DEFAULT_IMAGE_ATTACHMENT_COMPLETIONS,
  DEFAULT_QUEUED_COMMAND_COMPLETIONS,
  DEFAULT_SLACK_CHANNEL_COMPLETIONS,
  DEFAULT_VOICE_ACTION_COMPLETIONS,
} from './completionSources.js'

describe('PromptInput completion sources', () => {
  it('collects project file paths while skipping heavy internal directories', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-completion-'))

    try {
      mkdirSync(join(cwd, 'src'), { recursive: true })
      mkdirSync(join(cwd, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(cwd, 'README.md'), 'hello', 'utf8')
      writeFileSync(join(cwd, 'src', 'app.ts'), 'export {}', 'utf8')
      writeFileSync(join(cwd, 'node_modules', 'pkg', 'index.js'), '', 'utf8')

      await expect(collectPromptCompletionFilePaths(cwd)).resolves.toEqual([
        'README.md',
        'src/app.ts',
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('collects MCP resource and agent completions from project files', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-completion-'))

    try {
      mkdirSync(join(cwd, '.mcp'), { recursive: true })
      mkdirSync(join(cwd, '.my-claude-code', 'agents'), { recursive: true })
      mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
      writeFileSync(
        join(cwd, '.mcp', 'resources.json'),
        JSON.stringify({
          resources: [
            { uri: 'repo://readme' },
            'docs://roadmap',
          ],
        }),
        'utf8',
      )
      writeFileSync(join(cwd, '.my-claude-code', 'agents', 'reviewer.md'), '', 'utf8')
      writeFileSync(join(cwd, '.claude', 'agents', 'builder.json'), '{}', 'utf8')

      await expect(collectPromptCompletionMcpResources(cwd)).resolves.toEqual([
        'docs://roadmap',
        'repo://readme',
      ])
      await expect(collectPromptCompletionAgents(cwd)).resolves.toEqual([
        'builder',
        'reviewer',
      ])
      expect(DEFAULT_QUEUED_COMMAND_COMPLETIONS).toContain('test')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('collects Slack, IDE, image, and voice completion sources', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-completion-'))

    try {
      mkdirSync(join(cwd, '.my-claude-code'), { recursive: true })
      writeFileSync(
        join(cwd, '.my-claude-code', 'completions.json'),
        JSON.stringify({
          slackChannels: [{ name: 'release-room' }],
          ideMentions: ['workspace-symbols'],
          imageAttachments: [{ id: 'clipboard' }, 'screenshot'],
          voiceActions: [{ label: 'dictate' }],
        }),
        'utf8',
      )

      await expect(collectPromptPlatformCompletionSources(cwd)).resolves.toEqual({
        slackChannels: sortedUnique([
          ...DEFAULT_SLACK_CHANNEL_COMPLETIONS,
          'release-room',
        ]),
        ideMentions: sortedUnique([
          ...DEFAULT_IDE_MENTION_COMPLETIONS,
          'workspace-symbols',
        ]),
        imageAttachments: sortedUnique([
          ...DEFAULT_IMAGE_ATTACHMENT_COMPLETIONS,
          'clipboard',
          'screenshot',
        ]),
        voiceActions: sortedUnique([
          ...DEFAULT_VOICE_ACTION_COMPLETIONS,
          'dictate',
        ]),
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}
