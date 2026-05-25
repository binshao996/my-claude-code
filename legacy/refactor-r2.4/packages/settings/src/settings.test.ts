import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  appendProjectSettingsRule,
  loadSettingsWithSources,
  localProjectSettingsPath,
  loadSettings,
  managedSettingsPath,
  projectSettingsPath,
  saveProjectSettings,
  setProjectSetting,
  settingsSourceCandidates,
  userSettingsPath,
} from './settings.js'
import {
  defaultSettingsSyncPath,
  downloadUserSettingsSnapshot,
  uploadUserSettingsSnapshot,
} from './settingsSync.js'

describe('settings loader', () => {
  it('loads project settings without exposing secrets', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-settings-'))
    mkdirSync(join(cwd, '.claude'))
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'deepseek-v4-flash',
        permissionMode: 'acceptEdits',
        allowedTools: ['Read', 'Edit'],
      }),
      'utf8',
    )

    try {
      await expect(loadSettings(cwd)).resolves.toEqual({
        model: 'deepseek-v4-flash',
        permissionMode: 'acceptEdits',
        allowedTools: ['Read', 'Edit'],
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('writes only schema-supported project settings', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-settings-'))

    try {
      await saveProjectSettings(cwd, {
        model: 'deepseek-v4-flash',
        allowedTools: ['Read'],
        // @ts-expect-error verifies runtime sanitization for unknown keys.
        DEEPSEEK_API_KEY: 'secret',
      })

      const raw = readFileSync(projectSettingsPath(cwd), 'utf8')
      expect(raw).toContain('deepseek-v4-flash')
      expect(raw).not.toContain('secret')
      expect(await loadSettings(cwd)).toEqual({
        model: 'deepseek-v4-flash',
        allowedTools: ['Read'],
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('appends persistent rules without losing effective inherited rules', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-settings-'))
    mkdirSync(join(cwd, '.claude'))
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({
        allowedTools: ['Read'],
      }),
      'utf8',
    )

    try {
      await appendProjectSettingsRule(cwd, 'allowedTools', 'Write(hello.txt)')
      await appendProjectSettingsRule(cwd, 'allowedTools', 'Write(hello.txt)')

      expect(existsSync(projectSettingsPath(cwd))).toBe(true)
      expect(await loadSettings(cwd)).toEqual({
        allowedTools: ['Read', 'Write(hello.txt)'],
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('persists project theme as a schema-supported setting', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-settings-'))

    try {
      await setProjectSetting(cwd, 'theme', 'auto')

      expect(readFileSync(projectSettingsPath(cwd), 'utf8')).toContain('"theme": "auto"')
      expect(await loadSettings(cwd)).toEqual({
        theme: 'auto',
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('persists project output style as a schema-supported setting', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-settings-'))

    try {
      await setProjectSetting(cwd, 'outputStyle', 'Explanatory')

      expect(readFileSync(projectSettingsPath(cwd), 'utf8')).toContain(
        '"outputStyle": "Explanatory"',
      )
      expect(await loadSettings(cwd)).toEqual({
        outputStyle: 'Explanatory',
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('persists project vim mode as a schema-supported setting', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-settings-'))

    try {
      await setProjectSetting(cwd, 'vimMode', true)

      expect(readFileSync(projectSettingsPath(cwd), 'utf8')).toContain('"vimMode": true')
      expect(await loadSettings(cwd)).toEqual({
        vimMode: true,
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('merges user, project, local, and managed settings sources in precedence order', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-settings-'))
    const home = mkdtempSync(join(tmpdir(), 'my-claude-code-home-'))
    const managedPath = join(cwd, 'managed-policy.json')
    mkdirSync(join(home, '.my-claude-code'), { recursive: true })
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    mkdirSync(join(cwd, '.my-claude-code'), { recursive: true })

    writeFileSync(
      join(home, '.my-claude-code', 'settings.json'),
      JSON.stringify({
        model: 'user-model',
        permissionMode: 'default',
        outputStyle: 'default',
        allowedTools: ['Read'],
        disallowedTools: ['Bash(rm -rf)'],
      }),
      'utf8',
    )
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'claude-project-model',
        outputStyle: 'Explanatory',
        allowedTools: ['Grep'],
      }),
      'utf8',
    )
    writeFileSync(
      projectSettingsPath(cwd),
      JSON.stringify({
        theme: 'dark',
        allowedTools: ['Read', 'Write(src/index.ts)'],
      }),
      'utf8',
    )
    writeFileSync(
      localProjectSettingsPath(cwd),
      JSON.stringify({
        model: 'local-model',
        outputStyle: 'Learning',
        vimMode: true,
        disallowedTools: ['Write(secret.txt)'],
      }),
      'utf8',
    )
    writeFileSync(
      managedPath,
      JSON.stringify({
        permissionMode: 'plan',
        allowedTools: ['Glob'],
        disallowedTools: ['Bash(curl)'],
      }),
      'utf8',
    )

    try {
      const env = {
        HOME: home,
        MY_CLAUDE_CODE_MANAGED_SETTINGS_PATH: managedPath,
      }
      const loaded = await loadSettingsWithSources(cwd, env)

      expect(loaded.settings).toEqual({
        model: 'local-model',
        permissionMode: 'plan',
        outputStyle: 'Learning',
        allowedTools: ['Read', 'Grep', 'Write(src/index.ts)', 'Glob'],
        disallowedTools: ['Bash(rm -rf)', 'Write(secret.txt)', 'Bash(curl)'],
        theme: 'dark',
        vimMode: true,
      })
      expect(loaded.sources.filter(source => source.exists).map(source => source.kind))
        .toEqual(['user', 'claude-project', 'project', 'local', 'managed'])
      expect(settingsSourceCandidates(cwd, env).map(source => source.path)).toEqual([
        userSettingsPath(env) ?? '',
        join(cwd, '.claude', 'settings.json'),
        projectSettingsPath(cwd),
        localProjectSettingsPath(cwd),
        managedSettingsPath(env) ?? '',
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('uploads and downloads schema-safe settings sync snapshots', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-settings-'))
    const home = mkdtempSync(join(tmpdir(), 'my-claude-code-home-'))
    mkdirSync(join(home, '.my-claude-code'), { recursive: true })
    mkdirSync(join(cwd, '.claude'), { recursive: true })

    writeFileSync(
      join(home, '.my-claude-code', 'settings.json'),
      JSON.stringify({
        model: 'user-model',
        allowedTools: ['Read'],
        DEEPSEEK_API_KEY: 'secret',
      }),
      'utf8',
    )
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({
        outputStyle: 'Learning',
        allowedTools: ['Grep'],
      }),
      'utf8',
    )
    await saveProjectSettings(cwd, {
      theme: 'dark',
      allowedTools: ['Write(src/index.ts)'],
    })

    try {
      const env = { HOME: home }
      const upload = await uploadUserSettingsSnapshot({
        cwd,
        env,
        now: new Date('2026-05-24T00:00:00.000Z'),
      })

      expect(upload).toMatchObject({
        path: defaultSettingsSyncPath(cwd),
        entryCount: 3,
        entries: ['claude-project', 'project', 'user'],
      })
      const rawSnapshot = readFileSync(defaultSettingsSyncPath(cwd), 'utf8')
      expect(rawSnapshot).toContain('2026-05-24T00:00:00.000Z')
      expect(rawSnapshot).not.toContain('secret')

      rmSync(projectSettingsPath(cwd), { force: true })
      const download = await downloadUserSettingsSnapshot({ cwd })

      expect(download.settings).toEqual({
        model: 'user-model',
        outputStyle: 'Learning',
        theme: 'dark',
        allowedTools: ['Read', 'Grep', 'Write(src/index.ts)'],
      })
      expect((await loadSettingsWithSources(cwd, env)).settings).toMatchObject(
        download.settings ?? {},
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})
