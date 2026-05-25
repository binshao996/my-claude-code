import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  buildHelpV2Screen,
  buildNativeImagePasteScreen,
  buildOnboardingScreen,
  buildResumePreviewRows,
  buildDoctorScreen,
  buildResumeScreen,
  buildThemeScreen,
  buildWizardScreen,
  collectDoctorScreen,
  collectSandboxScreen,
  collectSettingsScreen,
  collectTrustScreen,
  filterResumeSessions,
  formatCommandScreen,
} from './screens.js'

describe('command screen models', () => {
  it('builds and formats a doctor screen', () => {
    const screen = buildDoctorScreen({
      cwd: '/repo',
      version: '0.4.0',
      model: 'deepseek-v4-flash',
      permissionMode: 'default',
      toolCount: 12,
    })

    expect(screen.rows).toEqual(
      expect.arrayContaining([
        { label: 'status', value: 'ok' },
        { label: 'toolCount', value: '12' },
      ]),
    )
    expect(formatCommandScreen(screen)).toContain('Doctor:')
    expect(formatCommandScreen(screen)).toContain('model: deepseek-v4-flash')
  })

  it('builds theme and resume screens', () => {
    expect(buildThemeScreen('dark').items).toContain('* dark')
    expect(formatCommandScreen(buildThemeScreen('auto'))).toContain(
      'preview: follow terminal color capability',
    )
    expect(formatCommandScreen(buildThemeScreen('auto'))).toContain(
      'preview detector: $COLORFGBG / terminal color capability',
    )
    expect(buildResumeScreen([]).items).toEqual(['No sessions found.'])
  })

  it('builds V1.6 upstream TUI surface screens', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-tui-surfaces-'))
    mkdirSync(join(cwd, '.git'), { recursive: true })
    mkdirSync(join(cwd, '.my-claude-code'), { recursive: true })
    writeFileSync(
      join(cwd, '.my-claude-code', 'settings.json'),
      JSON.stringify({
        model: 'deepseek-v4-flash',
        permissionMode: 'default',
        theme: 'dark',
        allowedTools: ['Read'],
      }),
      'utf8',
    )

    try {
      expect(formatCommandScreen(buildHelpV2Screen({
        commandNames: ['/help', '/settings'],
        descriptions: {
          '/help': 'Show help',
          '/settings': 'Show settings',
        },
      }))).toContain('/settings')
      expect(formatCommandScreen(await collectSettingsScreen({ cwd }))).toContain('theme: dark')
      expect(formatCommandScreen(await collectTrustScreen(cwd))).toContain('Trust:')
      expect(formatCommandScreen(buildOnboardingScreen(cwd))).toContain('project trust')
      expect(formatCommandScreen(buildWizardScreen())).toContain('/permissions')
      expect(formatCommandScreen(await collectSandboxScreen(cwd))).toContain('permissionMode: default')
      expect(formatCommandScreen(buildNativeImagePasteScreen({
        supported: true,
      }))).toContain('@image:clipboard')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('collects doctor environment checks without exposing secret values', async () => {
    const screen = await collectDoctorScreen({
      cwd: process.cwd(),
      version: '0.4.0',
      env: {
        DEEPSEEK_API_KEY: 'secret-value',
      },
    })
    const formatted = formatCommandScreen(screen)

    expect(formatted).toContain('check cwd readable: ok')
    expect(formatted).toContain('check installation type:')
    expect(formatted).toContain('check package manager:')
    expect(formatted).toContain('check ripgrep:')
    expect(formatted).toContain('check DEEPSEEK_API_KEY: ok - configured')
    expect(formatted).toContain('check settings source project:')
    expect(formatted).toContain('check permission rule coverage:')
    expect(formatted).toContain('check context files:')
    expect(formatted).toContain('check mcp config:')
    expect(formatted).toContain('check provider environment:')
    expect(formatted).not.toContain('secret-value')
  })

  it('reports invalid settings sources without leaking values', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-doctor-'))
    mkdirSync(join(cwd, '.my-claude-code'), { recursive: true })
    writeFileSync(
      join(cwd, '.my-claude-code', 'settings.json'),
      JSON.stringify({
        theme: 'dark',
        allowedTools: ['Read', 'Read(file.txt)'],
        DEEPSEEK_API_KEY: 'secret-value',
      }),
      'utf8',
    )

    try {
      const formatted = formatCommandScreen(await collectDoctorScreen({
        cwd,
        version: '0.4.0',
        env: {
          DEEPSEEK_API_KEY: 'configured',
          COLORFGBG: '15;0',
        },
      }))

      expect(formatted).toContain('check settings source project: ok')
      expect(formatted).toContain('check permission rule coverage: warning')
      expect(formatted).not.toContain('secret-value')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('builds resume preview rows for a selected session', () => {
    expect(
      buildResumePreviewRows({
        id: 's1',
        cwd: '/repo',
        transcriptPath: '/repo/t.jsonl',
        createdAt: '2026-05-23T00:00:00.000Z',
        updatedAt: '2026-05-23T00:01:00.000Z',
        promptCount: 2,
        model: 'deepseek-v4-flash',
        permissionMode: 'default',
        lastPrompt: 'continue',
      }),
    ).toEqual(
      expect.arrayContaining([
        { label: 'selected', value: 's1' },
        { label: 'lastPrompt', value: 'continue' },
      ]),
    )
  })

  it('filters resume sessions by id, model, prompt, and path fields', () => {
    const sessions = [
      {
        id: 'session_alpha',
        cwd: '/repo',
        transcriptPath: '/repo/a.jsonl',
        createdAt: '2026-05-23T00:00:00.000Z',
        updatedAt: '2026-05-23T00:01:00.000Z',
        promptCount: 1,
        model: 'deepseek-v4-flash',
        permissionMode: 'default',
        lastPrompt: 'create README',
      },
      {
        id: 'session_beta',
        cwd: '/work',
        transcriptPath: '/work/b.jsonl',
        createdAt: '2026-05-23T00:00:00.000Z',
        updatedAt: '2026-05-23T00:02:00.000Z',
        promptCount: 2,
        model: 'deepseek-r1',
        permissionMode: 'acceptEdits',
        lastPrompt: 'fix tests',
      },
    ]

    expect(filterResumeSessions(sessions, 'readme')).toEqual([sessions[0]])
    expect(filterResumeSessions(sessions, 'accept')).toEqual([sessions[1]])
    expect(buildResumeScreen(sessions, 'missing').items).toEqual([
      'No sessions match: missing',
    ])
  })
})
