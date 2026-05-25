import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyWorkflowJob,
  readAgentWorkflowState,
  recordMessageAction,
  recordReviewArtifactMutation,
  recordWorkflowEvent,
  runDueCronWorkflows,
  runVerificationAgent,
  scheduleCronWorkflow,
} from './agentWorkflows.js'

describe('V2.0 agent workflow runtime', () => {
  it('records actions, verification workers, review mutations, job classification, schedules, and events', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-agent-workflows-'))

    try {
      const action = await recordMessageAction(cwd, {
        messageId: 'msg_1',
        action: 'retry',
        reason: 'transient provider error',
      })
      expect(action).toMatchObject({ messageId: 'msg_1', action: 'retry' })

      const verification = await runVerificationAgent(cwd, {
        objective: 'Verify V2.0 workflow gate',
        planSummary: 'Add runtime and tests.',
        checks: ['bun test packages/tools/src/services/agentWorkflows.test.ts'],
      })
      expect(verification.workerPhases).toHaveLength(3)
      expect(existsSync(verification.workerPhases[0].transcriptPath)).toBe(true)

      writeFileSync(join(cwd, 'artifact.txt'), 'before\n', 'utf8')
      const review = await recordReviewArtifactMutation(cwd, {
        artifact: 'before\n',
        title: 'artifact.txt',
        targetPath: 'artifact.txt',
        replacement: 'after\n',
        apply: true,
        annotations: [{ line: 1, severity: 'suggestion', message: 'replace value' }],
      })
      expect(review).toMatchObject({ mutationApplied: true, annotationCount: 1 })
      expect(readFileSync(join(cwd, 'artifact.txt'), 'utf8')).toBe('after\n')
      expect(review.backupPath && existsSync(review.backupPath)).toBe(true)

      const classification = await classifyWorkflowJob(cwd, {
        prompt: 'review the pull request',
      })
      expect(classification.kind).toBe('review')

      const schedule = await scheduleCronWorkflow(cwd, {
        name: 'no-command',
        prompt: 'check later',
      })
      expect(schedule.status).toBe('scheduled')
      const runs = await runDueCronWorkflows(cwd)
      expect(runs).toEqual([])

      const event = await recordWorkflowEvent(cwd, {
        kind: 'bughunter',
        summary: 'Investigate flaky workflow.',
        payload: { issue: 1 },
      })
      expect(event).toMatchObject({ kind: 'bughunter', status: 'recorded' })

      const state = await readAgentWorkflowState(cwd)
      expect(state.messageActions).toHaveLength(1)
      expect(state.verificationAgents).toHaveLength(1)
      expect(state.reviewArtifacts).toHaveLength(1)
      expect(state.jobClassifications).toHaveLength(1)
      expect(state.cronSchedules).toHaveLength(1)
      expect(state.events).toHaveLength(1)
      expect(JSON.stringify(state)).not.toContain('do-not-persist-secret')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
