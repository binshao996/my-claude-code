import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getEcosystemTools,
  linkAcpSession,
  planAutofixPr,
  readAcpSessions,
  readAutofixPrPlans,
  readBuddySessions,
  readChicagoMcpProfiles,
  readTorchProbes,
  readVoiceMode,
  checkVoiceRuntime,
  registerChicagoMcpProfile,
  recordTorchProbe,
  sendAcpMessage,
  setVoiceMode,
  startBuddySession,
} from './ecosystem.js'
import { runToolUse } from './runner.js'

describe('V1.1 ecosystem parity tools', () => {
  it('records external ecosystem equivalents locally without side effects', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-ecosystem-'))

    try {
      await expect(linkAcpSession(cwd, { client: 'fixture' })).resolves.toMatchObject({
        client: 'fixture',
        transport: 'jsonl',
        status: 'connected',
        inboxPath: expect.stringContaining('fixture.inbox.jsonl'),
        outboxPath: expect.stringContaining('fixture.outbox.jsonl'),
      })
      await expect(
        planAutofixPr(cwd, {
          repo: 'owner/repo',
          branch: 'fix/local',
          summary: 'Fix failing test',
        }),
      ).resolves.toMatchObject({
        repo: 'owner/repo',
        status: 'planned',
      })
      await expect(startBuddySession(cwd, { name: 'pair', objective: 'Review plan' }))
        .resolves.toMatchObject({ name: 'pair', status: 'active' })
      await expect(registerChicagoMcpProfile(cwd, {
        name: 'local',
        endpoint: 'local://mcp',
      })).resolves.toMatchObject({ name: 'local', status: 'registered' })
      await expect(recordTorchProbe(cwd, { target: 'session' }))
        .resolves.toMatchObject({ target: 'session', status: 'recorded' })
      await expect(setVoiceMode(cwd, { enabled: false, provider: 'anthropic' })).resolves.toMatchObject({
        enabled: false,
        provider: 'anthropic',
        status: 'disabled',
      })

      await expect(readAutofixPrPlans(cwd)).resolves.toHaveLength(1)
      await expect(readBuddySessions(cwd)).resolves.toHaveLength(1)
      await expect(readChicagoMcpProfiles(cwd)).resolves.toHaveLength(1)
      await expect(readTorchProbes(cwd)).resolves.toHaveLength(1)
      await expect(readVoiceMode(cwd)).resolves.toMatchObject({ enabled: false })
      await expect(checkVoiceRuntime()).resolves.toMatchObject({
        availability: expect.objectContaining({ backend: expect.any(String) }),
        stt: expect.objectContaining({ provider: expect.any(String) }),
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('sends ACP messages through real JSONL queues', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-ecosystem-'))

    try {
      const session = await linkAcpSession(cwd, { client: 'fixture' })
      await expect(sendAcpMessage(cwd, {
        sessionId: session.id,
        body: 'client hello',
      })).resolves.toMatchObject({
        sessionId: session.id,
        status: 'sent',
      })
      await expect(sendAcpMessage(cwd, {
        sessionId: session.id,
        role: 'server',
        body: 'server hello',
      })).resolves.toMatchObject({
        bodyChars: 'server hello'.length,
      })

      expect(existsSync(session.outboxPath)).toBe(true)
      expect(existsSync(session.inboxPath)).toBe(true)
      expect(readFileSync(session.outboxPath, 'utf8')).toContain('client hello')
      expect(readFileSync(session.inboxPath, 'utf8')).toContain('server hello')
      expect(await readAcpSessions(cwd)).toEqual([
        expect.objectContaining({
          id: session.id,
          messageCount: 2,
        }),
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('exposes ecosystem records through shared tools', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-ecosystem-'))

    try {
      const result = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_buddy_start',
          name: 'BuddyStart',
          input: { objective: 'Help with parity' },
        },
        getEcosystemTools(),
        { cwd, permissionMode: 'default' },
      )
      expect(result.content).toContain('"status": "active"')

      const voice = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_voice',
          name: 'VoiceModeSet',
          input: { enabled: false, provider: 'anthropic' },
        },
        getEcosystemTools(),
        { cwd, permissionMode: 'default' },
      )
      expect(voice.content).toContain('"provider": "anthropic"')

      const deepseekVoice = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_voice_deepseek',
          name: 'VoiceModeSet',
          input: { enabled: true, provider: 'deepseek' },
        },
        getEcosystemTools(),
        { cwd, permissionMode: 'default' },
      )
      expect(deepseekVoice.content).toContain('"provider": "deepseek"')
      expect(deepseekVoice.content).toContain('does not expose a speech-to-text/audio transcription endpoint')

      const check = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_voice_check',
          name: 'VoiceCheck',
          input: {},
        },
        getEcosystemTools(),
        { cwd, permissionMode: 'default' },
      )
      expect(check.content).toContain('"availability"')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
