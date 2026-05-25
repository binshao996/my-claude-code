import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runToolUse } from './runner.js'
import {
  appendTaskOutput,
  createBrief,
  createTask,
  createTaskTemplate,
  createUltraplan,
  delegateAgentTask,
  enterWorktree,
  getWorkflowTools,
  listBuiltInAgents,
  readMonitors,
  readBackgroundPRSuggestions,
  readAssistantMode,
  readBackgroundOutput,
  readBriefs,
  readCoordinatorRuns,
  readGithubWebhookSubscriptions,
  readKairosChannels,
  readMonitorOutput,
  readProactiveTicks,
  readPushNotifications,
  readRunnerProfiles,
  readRunnerRuns,
  readTasks,
  readTaskTemplates,
  readUltraplans,
  readWorkflowScriptRuns,
  readWorktreeState,
  runEnvironmentRunner,
  runBuiltInAgent,
  runCoordinator,
  runSelfHostedRunner,
  runTaskTemplate,
  runWorkflowScript,
  queuePushNotification,
  registerKairosChannel,
  scheduleProactiveTick,
  setAssistantMode,
  suggestBackgroundPR,
  startMonitor,
  startBackgroundJob,
  subscribeGithubWebhook,
  stopMonitor,
  stopBackgroundJob,
  stopTask,
} from './workflows.js'

describe('V0.7 workflow tools', () => {
  const previousNotificationDisable = process.env.MY_CLAUDE_CODE_DISABLE_OS_NOTIFICATIONS

  beforeEach(() => {
    process.env.MY_CLAUDE_CODE_DISABLE_OS_NOTIFICATIONS = '1'
  })

  afterEach(() => {
    if (previousNotificationDisable === undefined) {
      delete process.env.MY_CLAUDE_CODE_DISABLE_OS_NOTIFICATIONS
    } else {
      process.env.MY_CLAUDE_CODE_DISABLE_OS_NOTIFICATIONS = previousNotificationDisable
    }
  })

  it('persists tasks across create, output, list, and stop operations', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v07-'))

    try {
      const task = await createTask(cwd, {
        title: 'Implement V0.7',
        prompt: 'subagent and background MVP',
      })
      await appendTaskOutput(cwd, {
        id: task.id,
        output: 'created task store',
      })
      await stopTask(cwd, task.id)

      expect(await readTasks(cwd)).toEqual([
        expect.objectContaining({
          id: task.id,
          title: 'Implement V0.7',
          status: 'stopped',
          output: ['created task store'],
        }),
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('records isolated subagent summaries and blocks tool escalation', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v07-'))

    try {
      const agent = await delegateAgentTask(
        cwd,
        {
          description: 'review docs',
          prompt: 'review V0.7 docs',
          allowedTools: ['Read'],
        },
        {
          cwd,
          permissionMode: 'default',
          allowedTools: ['Read'],
        },
      )

      expect(existsSync(agent.transcriptPath)).toBe(true)
      expect(readFileSync(agent.transcriptPath, 'utf8')).toContain('review docs')
      await expect(
        delegateAgentTask(
          cwd,
          {
            description: 'write files',
            prompt: 'change files',
            allowedTools: ['Write'],
          },
          {
            cwd,
            permissionMode: 'default',
            allowedTools: ['Read'],
          },
        ),
      ).rejects.toThrow('exceeds parent allowedTools')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('runs built-in Explore and Plan agents as local subagent records', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v11-'))

    try {
      expect(listBuiltInAgents()).toEqual([
        expect.objectContaining({ name: 'explore' }),
        expect.objectContaining({ name: 'plan' }),
      ])

      const explore = await runBuiltInAgent(
        cwd,
        {
          name: 'explore',
          prompt: 'find the workflow files',
        },
        {
          cwd,
          permissionMode: 'default',
        },
      )
      const plan = await runBuiltInAgent(
        cwd,
        {
          name: 'plan',
          prompt: 'plan the next parity task',
        },
        {
          cwd,
          permissionMode: 'default',
        },
      )

      expect(explore).toMatchObject({
        description: 'built-in explore agent',
        allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
      })
      expect(plan).toMatchObject({
        description: 'built-in plan agent',
        allowedTools: ['Read', 'Glob', 'Grep'],
      })
      expect(readFileSync(explore.transcriptPath, 'utf8')).toContain('built-in Explore agent')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('starts, logs, and stops a background job', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v07-'))

    try {
      const job = await startBackgroundJob(cwd, {
        name: 'fixture',
        command: process.execPath,
        args: ['-e', 'console.log("background-ready")'],
      })
      await waitFor(() => readBackgroundOutput(cwd, job.id), 'background-ready')
      expect(await readBackgroundOutput(cwd, job.id)).toContain('background-ready')
      await expect(stopBackgroundJob(cwd, job.id)).resolves.toMatchObject({
        id: job.id,
        status: 'stopped',
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('records active worktree session metadata', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v07-'))

    try {
      await enterWorktree(cwd, {
        path: 'feature-worktree',
        branch: 'feature/v07',
      })

      expect(await readWorktreeState(cwd)).toMatchObject({
        active: {
          path: join(cwd, 'feature-worktree'),
          branch: 'feature/v07',
        },
        history: [expect.objectContaining({ branch: 'feature/v07' })],
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('runs local environment and self-hosted runner smoke without persisting env values', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v07-'))

    try {
      await expect(
        runEnvironmentRunner(cwd, {
          name: 'byoc-fixture',
          env: { SECRET_TOKEN: 'do-not-persist' },
        }),
      ).resolves.toMatchObject({
        kind: 'environment',
        status: 'completed',
        stdout: expect.stringContaining('environment-runner-ready'),
      })
      await expect(
        runSelfHostedRunner(cwd, {
          name: 'self-hosted-fixture',
        }),
      ).resolves.toMatchObject({
        kind: 'self-hosted',
        status: 'completed',
        stdout: expect.stringContaining('self-hosted-runner-ready'),
      })

      expect(await readRunnerProfiles(cwd)).toEqual([
        expect.objectContaining({
          kind: 'environment',
          name: 'byoc-fixture',
          envKeys: ['SECRET_TOKEN'],
        }),
        expect.objectContaining({
          kind: 'self-hosted',
          name: 'self-hosted-fixture',
          envKeys: [],
        }),
      ])
      expect(JSON.stringify(await readRunnerProfiles(cwd))).not.toContain('do-not-persist')
      expect(await readRunnerRuns(cwd)).toHaveLength(2)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('creates task templates and workflow script run records without persisting env values', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v11-'))

    try {
      await createTaskTemplate(cwd, {
        name: 'release-check',
        title: 'Run release checks',
        prompt: 'test lint typecheck build',
      })
      const task = await runTaskTemplate(cwd, { name: 'release-check' })

      expect(await readTaskTemplates(cwd)).toEqual([
        expect.objectContaining({
          name: 'release-check',
          title: 'Run release checks',
        }),
      ])
      expect(task).toMatchObject({
        title: 'Run release checks',
        prompt: 'test lint typecheck build',
      })

      await expect(
        runWorkflowScript(cwd, {
          name: 'workflow-fixture',
          command: process.execPath,
          args: ['-e', 'console.log("workflow-ready")'],
          env: { WORKFLOW_TOKEN: 'do-not-persist' },
        }),
      ).resolves.toMatchObject({
        name: 'workflow-fixture',
        status: 'completed',
        stdout: expect.stringContaining('workflow-ready'),
        envKeys: ['WORKFLOW_TOKEN'],
      })
      expect(JSON.stringify(await readWorkflowScriptRuns(cwd))).not.toContain('do-not-persist')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('starts monitor records backed by background output', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v11-'))

    try {
      const monitor = await startMonitor(cwd, {
        name: 'monitor-fixture',
        command: process.execPath,
        args: ['-e', 'console.log("monitor-ready")'],
      })
      await waitFor(() => readMonitorOutput(cwd, monitor.id), 'monitor-ready')

      expect(await readMonitorOutput(cwd, monitor.id)).toContain('monitor-ready')
      expect(await readMonitors(cwd)).toEqual([
        expect.objectContaining({
          id: monitor.id,
          name: 'monitor-fixture',
          backgroundJobId: expect.stringMatching(/^bg_/),
        }),
      ])
      await expect(stopMonitor(cwd, monitor.id)).resolves.toMatchObject({
        id: monitor.id,
        status: 'stopped',
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('records coordinator workers and local ultraplan plans', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v11-'))

    try {
      await expect(
        runCoordinator(
          cwd,
          {
            prompt: 'close the next parity gap',
            workers: ['research', 'verify'],
          },
          {
            cwd,
            permissionMode: 'default',
          },
        ),
      ).resolves.toMatchObject({
        workerCount: 2,
        status: 'completed',
        summary: expect.stringContaining('close the next parity gap'),
      })
      expect(await readCoordinatorRuns(cwd)).toEqual([
        expect.objectContaining({
          workerCount: 2,
        }),
      ])

      await expect(
        createUltraplan(cwd, {
          prompt: 'ship V1.1 full parity',
        }),
      ).resolves.toMatchObject({
        prompt: 'ship V1.1 full parity',
        phase: 'ready',
        plan: expect.stringContaining('Ultraplan'),
      })
      expect(await readUltraplans(cwd)).toHaveLength(1)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('records local Kairos, brief, channel, push, webhook, and proactive state', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v11-'))

    try {
      await expect(setAssistantMode(cwd, { mode: 'assistant' })).resolves.toMatchObject({
        active: true,
        mode: 'assistant',
      })
      await expect(readAssistantMode(cwd)).resolves.toMatchObject({
        active: true,
        mode: 'assistant',
      })

      await expect(
        createBrief(cwd, {
          title: 'Daily brief',
          body: 'Summarize the latest local work.',
          channel: 'local',
        }),
      ).resolves.toMatchObject({
        title: 'Daily brief',
        channel: 'local',
      })
      expect(await readBriefs(cwd)).toHaveLength(1)

      await expect(
        registerKairosChannel(cwd, {
          name: 'local-updates',
          kind: 'local',
          target: 'stdout',
        }),
      ).resolves.toMatchObject({
        name: 'local-updates',
        kind: 'local',
      })
      expect(await readKairosChannels(cwd)).toHaveLength(1)

      await expect(
        queuePushNotification(cwd, {
          title: 'Build finished',
          body: 'All checks passed.',
          channel: 'local-updates',
        }),
      ).resolves.toMatchObject({
        status: 'queued',
        title: 'Build finished',
        dispatch: expect.objectContaining({
          status: 'unavailable',
          bodyHash: expect.any(String),
        }),
      })
      expect(await readPushNotifications(cwd)).toHaveLength(1)

      await expect(
        subscribeGithubWebhook(cwd, {
          repo: 'owner/repo',
          pr_number: 42,
          events: ['comment'],
        }),
      ).resolves.toMatchObject({
        repo: 'owner/repo',
        pr_number: 42,
        events: ['comment'],
        subscribed: true,
        status: 'subscribed',
      })
      expect(await readGithubWebhookSubscriptions(cwd)).toHaveLength(1)

      await expect(
        suggestBackgroundPR(cwd, {
          title: 'Extract PR cleanup',
          description: 'Move PR helpers into a focused module.',
        }),
      ).resolves.toMatchObject({
        title: 'Extract PR cleanup',
        suggested: true,
        status: 'suggested',
      })
      expect(await readBackgroundPRSuggestions(cwd)).toHaveLength(1)

      await expect(
        scheduleProactiveTick(cwd, {
          prompt: 'check status later',
          delaySeconds: 0,
        }),
      ).resolves.toMatchObject({
        prompt: 'check status later',
        status: 'scheduled',
      })
      expect(await readProactiveTicks(cwd)).toHaveLength(1)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('registers V0.7 tools in the shared runner', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-v07-'))

    try {
      const result = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_task',
          name: 'TaskCreate',
          input: { title: 'runner task' },
        },
        getWorkflowTools(),
        {
          cwd,
          permissionMode: 'default',
        },
      )

      expect(result.is_error).toBeUndefined()
      expect(result.content).toContain('runner task')

      const envRunner = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_env_runner',
          name: 'EnvironmentRunner',
          input: { name: 'tool-env' },
        },
        getWorkflowTools(),
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(envRunner.content).toContain('environment-runner-ready')

      const template = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_template',
          name: 'TaskTemplateCreate',
          input: { name: 'tool-template', title: 'Tool template task' },
        },
        getWorkflowTools(),
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(template.content).toContain('tool-template')

      const workflow = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_workflow',
          name: 'WorkflowScriptRun',
          input: {
            name: 'tool-workflow',
            command: process.execPath,
            args: ['-e', 'console.log("tool-workflow-ready")'],
          },
        },
        getWorkflowTools(),
        {
          cwd,
          permissionMode: 'bypassPermissions',
        },
      )
      expect(workflow.content).toContain('tool-workflow-ready')

      const coordinator = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_coordinator',
          name: 'CoordinatorRun',
          input: { prompt: 'coordinate tool smoke', workers: ['research'] },
        },
        getWorkflowTools(),
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(coordinator.content).toContain('coordinate tool smoke')

      const ultraplan = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_ultraplan',
          name: 'UltraplanCreate',
          input: { prompt: 'plan tool smoke' },
        },
        getWorkflowTools(),
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(ultraplan.content).toContain('plan tool smoke')

      const assistant = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_assistant',
          name: 'AssistantMode',
          input: { mode: 'proactive' },
        },
        getWorkflowTools(),
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(assistant.content).toContain('proactive')

      const push = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_push',
          name: 'PushNotification',
          input: { title: 'Tool push', body: 'queued locally' },
        },
        getWorkflowTools(),
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(push.content).toContain('queued')

      const subscription = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_subscribe_pr',
          name: 'SubscribePR',
          input: { repo: 'owner/repo', pr_number: 7, events: ['review'] },
        },
        getWorkflowTools(),
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(subscription.content).toContain('"subscribed": true')

      const suggestion = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_suggest_background_pr',
          name: 'SuggestBackgroundPR',
          input: {
            title: 'Follow-up cleanup',
            description: 'Run background cleanup as a separate PR.',
            branch: 'background/follow-up-cleanup',
          },
        },
        getWorkflowTools(),
        {
          cwd,
          permissionMode: 'default',
        },
      )
      expect(suggestion.content).toContain('"suggested": true')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

async function waitFor(
  read: () => Promise<string>,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if ((await read()).includes(expected)) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${expected}`)
}
