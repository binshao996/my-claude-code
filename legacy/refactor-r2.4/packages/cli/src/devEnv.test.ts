import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { loadDevelopmentEnv, parseDotEnv } from './devEnv.js'

describe('development env loader', () => {
  it('parses simple dotenv content without exposing values', () => {
    expect(
      parseDotEnv(`
        # comment
        DEEPSEEK_API_KEY=local-key
        QUOTED="hello\\nworld"
        SINGLE='literal'
        WITH_COMMENT=value # comment
      `),
    ).toEqual({
      DEEPSEEK_API_KEY: 'local-key',
      QUOTED: 'hello\nworld',
      SINGLE: 'literal',
      WITH_COMMENT: 'value',
    })
  })

  it('loads .env and .env.local in development without overriding system env', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-env-'))
    try {
      writeFileSync(join(cwd, '.env'), 'DEEPSEEK_API_KEY=from-dot-env\nA=1\n')
      writeFileSync(
        join(cwd, '.env.local'),
        'DEEPSEEK_API_KEY=from-dot-env-local\nB=2\n',
      )

      const env = {
        DEEPSEEK_API_KEY: 'from-system',
      } as NodeJS.ProcessEnv

      const result = loadDevelopmentEnv({
        cwd,
        env,
        nodeEnv: 'development',
      })

      expect(result).toEqual({
        mode: 'development',
        files: ['.env', '.env.local'],
        keys: ['A', 'B'],
      })
      expect(env).toEqual({
        DEEPSEEK_API_KEY: 'from-system',
        A: '1',
        B: '2',
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('skips dotenv files in production', () => {
    const env = {} as NodeJS.ProcessEnv

    expect(
      loadDevelopmentEnv({
        env,
        nodeEnv: 'production',
      }),
    ).toEqual({
      mode: 'production',
      files: [],
      keys: [],
    })
    expect(env).toEqual({})
  })
})
