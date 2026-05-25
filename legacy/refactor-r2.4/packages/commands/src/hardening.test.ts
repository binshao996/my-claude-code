import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { collectHardeningReport } from './hardening.js'

describe('V1.0 hardening report', () => {
  it('collects release health checks without leaking secret values', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-hardening-'))

    try {
      mkdirSync(join(cwd, 'docs'), { recursive: true })
      mkdirSync(join(cwd, 'dist'), { recursive: true })
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
        join(cwd, 'dist', 'cli.js'),
        `console.log('1.0.0')\n// ${'x'.repeat(100_000)}\n`,
        'utf8',
      )
      writeFileSync(
        join(cwd, 'package.json'),
        JSON.stringify({
          name: 'fixture',
          scripts: { build: 'bun build' },
        }),
        'utf8',
      )

      const report = await collectHardeningReport({
        cwd,
        version: '1.0.0',
        slashCommandCount: 3,
        env: {
          DEEPSEEK_API_KEY: 'secret-value',
        },
      })
      const serialized = JSON.stringify(report)

      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'coverage ledger',
          status: 'pass',
        }),
      )
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'production smoke',
          status: 'pass',
        }),
      )
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'secret safety',
          status: 'pass',
        }),
      )
      expect(serialized).toContain('secret env var(s) detected by name only')
      expect(serialized).not.toContain('secret-value')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reports coverage ledger blockers as V1.0 release failures', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-hardening-'))

    try {
      mkdirSync(join(cwd, 'docs'), { recursive: true })
      writeFileSync(
        join(cwd, 'docs', '10-source-coverage-ledger.md'),
        [
          '| Item ID | Item Type | Target Version | State | Owner | Evidence | Parity Case | Last Updated |',
          '| --- | --- | --- | --- | --- | --- | --- | --- |',
          '| `SRC:blocker` | source | V1.0 | In Progress | Test | fixture | PC-000 | 2026-05-23 |',
        ].join('\n'),
        'utf8',
      )

      const report = await collectHardeningReport({
        cwd,
        version: '1.0.0',
      })

      expect(report.status).toBe('fail')
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'coverage ledger',
          status: 'fail',
          detail: expect.stringContaining('In Progress=1'),
        }),
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reports V1.1 full ecosystem blockers separately from release health', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-hardening-'))

    try {
      mkdirSync(join(cwd, 'docs'), { recursive: true })
      mkdirSync(join(cwd, 'claude-code', 'src'), { recursive: true })
      writeFileSync(
        join(cwd, 'docs', '10-source-coverage-ledger.md'),
        [
          '| Item ID | Item Type | Target Version | State | Owner | Evidence | Parity Case | Last Updated |',
          '| --- | --- | --- | --- | --- | --- | --- | --- |',
          '| `SRC:fixture` | source | V1.0 | Covered | Test | Covered for MVP: fixture; browser work is deferred | PC-000 | 2026-05-23 |',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(join(cwd, 'claude-code', 'src', 'unmapped.ts'), 'export {}\n', 'utf8')

      const report = await collectHardeningReport({
        cwd,
        version: '1.0.0',
        mode: 'full-ecosystem',
      })

      expect(report.mode).toBe('full-ecosystem')
      expect(report.status).toBe('fail')
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'full ecosystem feature parity',
          status: 'pass',
          detail: expect.stringContaining('no planned'),
        }),
      )
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'full ecosystem ledger',
          status: 'fail',
          detail: expect.stringContaining('Covered for MVP'),
        }),
      )
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'source inventory diff',
          status: 'fail',
          detail: expect.stringContaining('claude-code/src/unmapped.ts'),
        }),
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('runs V1.2 strict parity gates against command, package, manifest, feature, and shim inventory', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-hardening-'))

    try {
      mkdirSync(join(cwd, 'docs'), { recursive: true })
      mkdirSync(join(cwd, 'claude-code', 'src', 'commands', 'known'), { recursive: true })
      mkdirSync(join(cwd, 'claude-code', 'src', 'commands', 'missing'), { recursive: true })
      mkdirSync(join(cwd, 'claude-code', 'src', 'entrypoints', 'sdk'), { recursive: true })
      mkdirSync(join(cwd, 'claude-code', 'src', 'cli', 'transports'), { recursive: true })
      mkdirSync(join(cwd, 'claude-code', 'src', 'cli', 'bg'), { recursive: true })
      mkdirSync(join(cwd, 'claude-code', 'src', 'cli', 'handlers'), { recursive: true })
      mkdirSync(join(cwd, 'claude-code', 'src', 'types'), { recursive: true })
      mkdirSync(join(cwd, 'claude-code', 'src', 'schemas'), { recursive: true })
      mkdirSync(join(cwd, 'claude-code', 'packages', 'builtin-tools', 'src', 'tools', 'FileReadTool'), { recursive: true })
      mkdirSync(join(cwd, 'claude-code', 'packages', 'builtin-tools', 'src', 'tools', 'MissingTool'), { recursive: true })
      mkdirSync(join(cwd, 'claude-code', 'packages', 'known'), { recursive: true })
      mkdirSync(join(cwd, 'claude-code', 'packages', 'missing'), { recursive: true })
      mkdirSync(join(cwd, 'packages', 'known'), { recursive: true })

      writeFileSync(
        join(cwd, 'docs', '10-source-coverage-ledger.md'),
        [
          '| Item ID | Item Type | Target Version | State | Owner | Evidence | Parity Case | Last Updated |',
          '| --- | --- | --- | --- | --- | --- | --- | --- |',
          '| `SRC:fixture` | source | V1.0 | Covered | Test | local-stub fixture | PC-000 | 2026-05-23 |',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(
        join(cwd, 'docs', 'strict-parity-manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          commandAliases: {},
          packageMappings: {},
          sourceMappings: {
            'claude-code/src/commands/': 'packages/commands/src/slashCommands.ts',
          },
          toolAliases: {
            FileReadTool: 'Read',
          },
          entrypointMappings: {},
          cliTransportMappings: {},
          schemaMappings: {},
        }),
        'utf8',
      )
      writeFileSync(join(cwd, 'claude-code', 'src', 'entrypoints', 'cli.tsx'), 'export {}\n', 'utf8')
      writeFileSync(join(cwd, 'claude-code', 'src', 'entrypoints', 'mcp.ts'), 'export {}\n', 'utf8')
      writeFileSync(join(cwd, 'claude-code', 'src', 'entrypoints', 'agentSdkTypes.ts'), 'export {}\n', 'utf8')
      writeFileSync(join(cwd, 'claude-code', 'src', 'entrypoints', 'sandboxTypes.ts'), 'export {}\n', 'utf8')
      writeFileSync(join(cwd, 'claude-code', 'src', 'cli', 'print.ts'), 'export {}\n', 'utf8')
      writeFileSync(join(cwd, 'claude-code', 'src', 'cli', 'structuredIO.ts'), 'export {}\n', 'utf8')
      writeFileSync(join(cwd, 'claude-code', 'src', 'cli', 'remoteIO.ts'), 'export {}\n', 'utf8')
      writeFileSync(join(cwd, 'claude-code', 'src', 'cli', 'transports', 'SSETransport.ts'), 'export {}\n', 'utf8')
      writeFileSync(join(cwd, 'claude-code', 'src', 'cli', 'transports', 'WebSocketTransport.ts'), 'export {}\n', 'utf8')
      writeFileSync(join(cwd, 'claude-code', 'src', 'cli', 'transports', 'HybridTransport.ts'), 'export {}\n', 'utf8')
      writeFileSync(join(cwd, 'claude-code', 'src', 'cli', 'transports', 'SerialBatchEventUploader.ts'), 'export {}\n', 'utf8')
      writeFileSync(join(cwd, 'claude-code', 'src', 'cli', 'transports', 'WorkerStateUploader.ts'), 'export {}\n', 'utf8')
      writeFileSync(join(cwd, 'claude-code', 'src', 'entrypoints', 'sdk', 'coreSchemas.ts'), 'export {}\n', 'utf8')
      writeFileSync(join(cwd, 'claude-code', 'src', 'entrypoints', 'sdk', 'controlSchemas.ts'), 'export {}\n', 'utf8')
      writeFileSync(join(cwd, 'claude-code', 'src', 'entrypoints', 'sdk', 'coreTypes.ts'), 'export {}\n', 'utf8')
      writeFileSync(join(cwd, 'claude-code', 'src', 'entrypoints', 'sdk', 'runtimeTypes.ts'), 'export {}\n', 'utf8')
      writeFileSync(join(cwd, 'claude-code', 'src', 'entrypoints', 'sdk', 'toolTypes.ts'), 'export {}\n', 'utf8')

      const report = await collectHardeningReport({
        cwd,
        version: '1.0.0',
        mode: 'strict',
        slashCommandNames: ['/known'],
      })

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
          detail: expect.stringContaining('missing'),
        }),
      )
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'strict package inventory',
          status: 'fail',
          detail: expect.stringContaining('missing'),
        }),
      )
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'strict tool inventory',
          status: 'fail',
          detail: expect.stringContaining('MissingTool'),
        }),
      )
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'strict feature parity',
          status: 'pass',
          detail: expect.stringContaining('feature(s) fully covered'),
        }),
      )
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'strict shim detector',
          status: 'fail',
          detail: expect.stringContaining('local-stub'),
        }),
      )
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'strict entrypoint inventory',
          status: 'fail',
          detail: expect.stringContaining('entrypoints/mcp.ts'),
        }),
      )
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'strict CLI transport inventory',
          status: 'fail',
          detail: expect.stringContaining('SSETransport.ts'),
        }),
      )
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          label: 'strict schema inventory',
          status: 'fail',
          detail: expect.stringContaining('coreSchemas.ts'),
        }),
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
