import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAG_MATRIX,
  MessageSchema,
  QueryEventSchema,
  SDKControlRequestSchema,
  SDKMcpServerConfigSchema,
  SandboxPermissionRequestSchema,
  TerminalEventSchema,
  ToolExecutionEventSchema,
  TranscriptRecordSchema,
  buildNativeClientMetadata,
  buildObservabilityEvents,
  buildPerfettoTraceEvent,
  getFeatureFlagRecord,
  parseSDKStdinMessage,
  parseSDKStdoutMessage,
  parseFeatureFlagList,
  scanFeatureCallsFromText,
  shouldSkipUpdateDetection,
  summarizeFeatureFlags,
  validateFeatureFlagMatrix,
} from './index.js'

describe('core protocol schemas', () => {
  it('accepts Claude-compatible tool use blocks', () => {
    const message = MessageSchema.parse({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'Bash',
          input: { command: 'pwd' },
        },
      ],
    })

    expect(message.content).toHaveLength(1)
  })

  it('accepts Claude-compatible image blocks', () => {
    const message = MessageSchema.parse({
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: Buffer.from('png').toString('base64'),
          },
        },
      ],
    })

    expect(message.content).toHaveLength(1)
  })

  it('accepts streaming query events', () => {
    const event = QueryEventSchema.parse({
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: 'hello',
      },
    })

    expect(event.type).toBe('content_block_delta')
  })

  it('accepts Claude-compatible thinking blocks and deltas', () => {
    const startEvent = QueryEventSchema.parse({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'thinking',
        thinking: '',
        signature: '',
      },
    })
    const deltaEvent = QueryEventSchema.parse({
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'thinking_delta',
        thinking: 'reasoning',
      },
    })

    expect(startEvent.type).toBe('content_block_start')
    expect(deltaEvent.type).toBe('content_block_delta')
  })

  it('validates transcript records as JSONL-ready objects', () => {
    const record = TranscriptRecordSchema.parse({
      id: 'rec_01',
      session_id: 'session_01',
      created_at: '2026-05-22T00:00:00.000Z',
      event: {
        type: 'message_stop',
      },
    })

    expect(record.session_id).toBe('session_01')
  })

  it('accepts terminal states used by the query loop', () => {
    expect(
      TerminalEventSchema.parse({
        type: 'terminal',
        status: 'completed',
        exitCode: 0,
      }),
    ).toEqual({
      type: 'terminal',
      status: 'completed',
      exitCode: 0,
    })
  })

  it('accepts tool_error terminal state for denied tool execution', () => {
    expect(
      TerminalEventSchema.parse({
        type: 'terminal',
        status: 'tool_error',
        exitCode: 1,
        reason: 'Write was denied',
      }),
    ).toMatchObject({
      status: 'tool_error',
      exitCode: 1,
    })
  })

  it('accepts hook_blocked terminal state for Stop hooks', () => {
    expect(
      TerminalEventSchema.parse({
        type: 'terminal',
        status: 'hook_blocked',
        exitCode: 1,
        reason: 'blocked by Stop hook',
      }),
    ).toMatchObject({
      status: 'hook_blocked',
      exitCode: 1,
    })
  })

  it('accepts tool execution events used by the V0.3 tool loop', () => {
    expect(
      ToolExecutionEventSchema.parse({
        type: 'tool_execution_result',
        tool_use_id: 'toolu_1',
        name: 'Read',
        content: 'file content',
      }),
    ).toEqual({
      type: 'tool_execution_result',
      tool_use_id: 'toolu_1',
      name: 'Read',
      content: 'file content',
      is_error: false,
    })
  })

  it('accepts SDK control, MCP config, and sandbox protocol schemas', () => {
    const control = SDKControlRequestSchema.parse({
      type: 'control_request',
      request_id: 'req_1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Read',
        input: { file_path: 'README.md' },
        tool_use_id: 'toolu_1',
      },
    })

    expect(control.request.subtype).toBe('can_use_tool')
    expect(parseSDKStdoutMessage(control)).toMatchObject({ request_id: 'req_1' })
    expect(
      parseSDKStdinMessage({
        type: 'control_response',
        request_id: 'req_1',
        response: { behavior: 'allow' },
      }),
    ).toMatchObject({ request_id: 'req_1' })
    expect(
      SDKMcpServerConfigSchema.parse({
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
      }),
    ).toMatchObject({ command: 'node' })
    expect(
      SandboxPermissionRequestSchema.parse({
        type: 'sandbox_permission_request',
        id: 'sandbox_1',
        network: true,
      }),
    ).toMatchObject({ network: true })
  })

  it('parses comma-separated feature flags', () => {
    expect([...parseFeatureFlagList('A, B,,C')]).toEqual(['A', 'B', 'C'])
  })

  it('closes the V0.9 feature flag matrix without unregistered source calls', () => {
    const source = [
      "feature('BUDDY')",
      "feature('BRIDGE_MODE')",
      'feature("PROMPT_CACHE_BREAK_DETECTION")',
      "feature('TREE_SITTER_BASH_SHADOW')",
    ].join('\n')
    const discovered = scanFeatureCallsFromText(source)
    const audit = validateFeatureFlagMatrix(discovered)

    expect(discovered).toEqual([
      'BRIDGE_MODE',
      'BUDDY',
      'PROMPT_CACHE_BREAK_DETECTION',
      'TREE_SITTER_BASH_SHADOW',
    ])
    expect(audit).toEqual({
      missing: [],
      missingDefaultBuildFeatures: [],
      invalidRuntimeDefaults: [],
      nonSecretSafeDefaults: [],
    })
  })

  it('registers every feature call found in the vendored Claude Code source tree', () => {
    const root = join(process.cwd(), 'claude-code')
    if (!existsSync(root)) {
      return
    }

    const discovered = new Set<string>()
    for (const file of listSourceFiles(root)) {
      for (const feature of scanFeatureCallsFromText(readFileSync(file, 'utf8'))) {
        discovered.add(feature)
      }
    }

    expect(discovered.size).toBeGreaterThan(0)
    expect(validateFeatureFlagMatrix([...discovered]).missing).toEqual([])
  })

  it('keeps default runtime flags limited to covered and secret-safe features', () => {
    const enabledByDefault = FEATURE_FLAG_MATRIX.filter(record => record.runtimeDefault)

    expect(enabledByDefault.length).toBeGreaterThan(0)
    expect(
      enabledByDefault.every(record => record.parityState === 'Covered'),
    ).toBe(true)
    expect(
      enabledByDefault.every(record => record.secretSafeDefault),
    ).toBe(true)
    expect([...DEFAULT_FEATURE_FLAGS].sort()).toEqual(
      enabledByDefault.map(record => record.name).sort(),
    )
  })

  it('marks strict feature parity records as covered with safe runtime defaults', () => {
    expect(getFeatureFlagRecord('TEAMMEM')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: false,
      userVisible: false,
    })
    expect(getFeatureFlagRecord('CONTEXT_COLLAPSE')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: false,
      targetVersion: 'V1.4',
    })
    expect(getFeatureFlagRecord('WEB_BROWSER_TOOL')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.1',
    })
    expect(getFeatureFlagRecord('BUILDING_CLAUDE_APPS')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.1',
    })
    expect(getFeatureFlagRecord('WORKFLOW_SCRIPTS')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.1',
    })
    expect(getFeatureFlagRecord('MONITOR_TOOL')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.1',
    })
    expect(getFeatureFlagRecord('TEMPLATES')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.1',
    })
    expect(getFeatureFlagRecord('BUILTIN_EXPLORE_PLAN_AGENTS')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.1',
    })
    expect(getFeatureFlagRecord('COORDINATOR_MODE')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.1',
    })
    expect(getFeatureFlagRecord('ULTRAPLAN')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.1',
    })
    expect(getFeatureFlagRecord('KAIROS')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.1',
    })
    expect(getFeatureFlagRecord('KAIROS_BRIEF')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.1',
    })
    expect(getFeatureFlagRecord('KAIROS_CHANNELS')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.1',
    })
    expect(getFeatureFlagRecord('KAIROS_GITHUB_WEBHOOKS')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.1',
    })
    expect(getFeatureFlagRecord('KAIROS_PUSH_NOTIFICATION')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.1',
    })
    expect(getFeatureFlagRecord('PROACTIVE')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.1',
    })
    expect(getFeatureFlagRecord('RUN_SKILL_GENERATOR')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.1',
    })
    expect(getFeatureFlagRecord('SKILL_LEARNING')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.1',
    })
    expect(getFeatureFlagRecord('LAN_PIPES')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.5',
    })
    expect(getFeatureFlagRecord('UDS_INBOX')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.5',
    })
    expect(getFeatureFlagRecord('OVERFLOW_TEST_TOOL')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.1',
    })
    expect(getFeatureFlagRecord('ACP')).toMatchObject({
      parityState: 'Covered',
      runtimeDefault: true,
      targetVersion: 'V1.5',
    })
    for (const feature of [
      'AUTOFIX_PR',
      'BUDDY',
      'CHICAGO_MCP',
      'TORCH',
      'VOICE_MODE',
    ] as const) {
      expect(getFeatureFlagRecord(feature)).toMatchObject({
        parityState: 'Covered',
        runtimeDefault: true,
        targetVersion: 'V1.1',
      })
    }
  })

  it('reports env-enabled flags without changing the static matrix', () => {
    expect(summarizeFeatureFlags('TEAMMEM,CONTEXT_COLLAPSE')).toContainEqual(
      expect.objectContaining({
        name: 'TEAMMEM',
        enabled: true,
        enabledBy: 'env',
      }),
    )
    expect(summarizeFeatureFlags()).toContainEqual(
      expect.objectContaining({
        name: 'TEAMMEM',
        enabled: false,
        enabledBy: 'off',
      }),
    )
  })

  it('builds secret-safe local observability events for telemetry and tracing flags', () => {
    const events = buildObservabilityEvents({
      envValue: [
        'COWORKER_TYPE_TELEMETRY',
        'ENHANCED_TELEMETRY_BETA',
        'MEMORY_SHAPE_TELEMETRY',
        'PERFETTO_TRACING',
        'SLOW_OPERATION_LOGGING',
      ].join(','),
      attributes: {
        coworkerType: 'local',
        token: 'sk-ant-secret',
        nested: { shape: 'summary' },
      },
    })

    expect(events).toContainEqual(
      expect.objectContaining({
        name: 'coworker_type',
        enabled: true,
        enabledBy: 'default',
        attributes: expect.objectContaining({
          coworkerType: 'local',
          token: '[redacted]',
          nested: '{"shape":"summary"}',
        }),
        redactedKeys: ['token'],
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        name: 'perfetto_trace',
        enabled: true,
      }),
    )
  })

  it('models update detection, native attestation, and Perfetto events locally', () => {
    expect(
      shouldSkipUpdateDetection({
        autoUpdatesDisabled: true,
        envValue: 'SKIP_DETECTION_WHEN_AUTOUPDATES_DISABLED',
      }),
    ).toBe(true)
    expect(
      shouldSkipUpdateDetection({
        autoUpdatesDisabled: false,
      }),
    ).toBe(false)
    expect(
      buildNativeClientMetadata({
        version: '1.0.0',
        envValue: 'NATIVE_CLIENT_ATTESTATION',
      }),
    ).toBe('my-claude-code/1.0.0; cch=00000;')
    expect(
      buildPerfettoTraceEvent({
        name: 'provider_request',
        startedAtMicros: 1.8,
        durationMicros: 20.2,
        args: { authorization: 'Bearer token', status: 'ok' },
      }),
    ).toEqual({
      name: 'provider_request',
      ph: 'X',
      ts: 1,
      dur: 20,
      pid: 0,
      tid: 0,
      args: {
        authorization: '[redacted]',
        status: 'ok',
      },
    })
  })
})

function listSourceFiles(root: string): string[] {
  const files: string[] = []
  const ignored = new Set(['node_modules', '.git', 'dist', 'build', 'coverage'])
  for (const entry of readdirSync(root)) {
    if (ignored.has(entry)) {
      continue
    }
    const path = join(root, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(path))
      continue
    }
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) {
      files.push(path)
    }
  }
  return files
}
