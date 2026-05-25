import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  writeFile,
} from 'node:fs/promises'
import {
  dirname,
  join,
  resolve,
} from 'node:path'
import { z } from 'zod/v4'
import {
  isPatternToolRule,
  matchesToolNameRule,
} from './permissions.js'
import {
  dispatchLocalNotification,
  type NotificationDispatchResult,
} from './services/notifications.js'
import type {
  Tool,
  ToolExecutionContext,
} from './types.js'

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'stopped'

export type TaskRecord = {
  id: string
  title: string
  prompt?: string
  status: TaskStatus
  summary?: string
  output: string[]
  createdAt: string
  updatedAt: string
}

export type AgentRecord = {
  id: string
  description: string
  prompt: string
  allowedTools?: string[]
  disallowedTools?: string[]
  transcriptPath: string
  summary: string
  createdAt: string
}

export type BuiltInAgentName = 'explore' | 'plan'

export type BuiltInAgentDescriptor = {
  name: BuiltInAgentName
  description: string
  allowedTools: string[]
  prompt: string
}

export type BackgroundJobStatus =
  | 'running'
  | 'stopped'
  | 'unknown'

export type BackgroundJobRecord = {
  id: string
  name: string
  command: string
  args: string[]
  pid?: number
  status: BackgroundJobStatus
  logPath: string
  createdAt: string
  updatedAt: string
}

export type WorktreeState = {
  active?: {
    path: string
    branch?: string
    enteredAt: string
  }
  history: Array<{
    path: string
    branch?: string
    enteredAt: string
    exitedAt?: string
  }>
}

export type RunnerKind = 'environment' | 'self-hosted'

export type RunnerProfile = {
  id: string
  kind: RunnerKind
  name: string
  cwd: string
  command: string
  args: string[]
  envKeys: string[]
  status: 'ready' | 'failed'
  createdAt: string
  updatedAt: string
}

export type RunnerRunRecord = {
  id: string
  profileId: string
  kind: RunnerKind
  status: 'completed' | 'failed'
  exitCode: number
  stdout: string
  stderr: string
  startedAt: string
  completedAt: string
}

export type TaskTemplateRecord = {
  id: string
  name: string
  title: string
  prompt?: string
  createdAt: string
  updatedAt: string
}

export type WorkflowScriptRunRecord = {
  id: string
  name: string
  cwd: string
  command: string
  args: string[]
  envKeys: string[]
  status: 'completed' | 'failed'
  exitCode: number
  stdout: string
  stderr: string
  startedAt: string
  completedAt: string
}

export type MonitorRecord = {
  id: string
  name: string
  command: string
  args: string[]
  backgroundJobId: string
  status: BackgroundJobStatus
  logPath: string
  createdAt: string
  updatedAt: string
}

export type CoordinatorRunRecord = {
  id: string
  prompt: string
  workerCount: number
  workerIds: string[]
  status: 'completed'
  summary: string
  createdAt: string
}

export type UltraplanRecord = {
  id: string
  prompt: string
  seedPlan?: string
  plan: string
  phase: 'ready'
  createdAt: string
  updatedAt: string
}

export type AssistantModeState = {
  active: boolean
  mode: 'focused' | 'assistant' | 'proactive'
  updatedAt: string
}

export type BriefRecord = {
  id: string
  title: string
  body: string
  channel?: string
  createdAt: string
}

export type KairosChannelRecord = {
  id: string
  name: string
  kind: 'local' | 'github' | 'push' | 'weixin'
  target?: string
  createdAt: string
}

export type PushNotificationRecord = {
  id: string
  title: string
  body: string
  channel?: string
  status: 'queued'
  dispatch: NotificationDispatchResult
  createdAt: string
}

export type GithubWebhookSubscriptionRecord = {
  id: string
  subscription_id: string
  repo: string
  pr_number: number
  events: string[]
  subscribed: true
  status: 'subscribed'
  createdAt: string
}

export type BackgroundPRSuggestionRecord = {
  id: string
  suggestion_id: string
  title: string
  description: string
  branch: string
  suggested: true
  status: 'suggested'
  createdAt: string
}

export type ProactiveTickRecord = {
  id: string
  prompt: string
  nextTickAt: string
  status: 'scheduled'
  createdAt: string
}

const TaskCreateInputSchema = z.object({
  title: z.string().min(1),
  prompt: z.string().optional(),
})

const TaskUpdateInputSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'stopped']).optional(),
  summary: z.string().optional(),
})

const TaskIdInputSchema = z.object({
  id: z.string().min(1),
})

const TaskOutputInputSchema = z.object({
  id: z.string().min(1),
  output: z.string().min(1),
})

const AgentInputSchema = z.object({
  description: z.string().min(1),
  prompt: z.string().min(1),
  allowedTools: z.array(z.string().min(1)).optional(),
})

const BuiltInAgentRunInputSchema = z.object({
  name: z.enum(['explore', 'plan']),
  prompt: z.string().min(1),
})

const BackgroundStartInputSchema = z.object({
  name: z.string().min(1).optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
})

const BackgroundIdInputSchema = z.object({
  id: z.string().min(1),
})

const EnterWorktreeInputSchema = z.object({
  path: z.string().min(1),
  branch: z.string().min(1).optional(),
})

const RunnerInputSchema = z.object({
  name: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().min(1).optional(),
})

const TaskTemplateCreateInputSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().optional(),
})

const TaskTemplateRunInputSchema = z.object({
  name: z.string().min(1),
})

const WorkflowScriptRunInputSchema = z.object({
  name: z.string().min(1).optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().min(1).optional(),
})

const MonitorStartInputSchema = z.object({
  name: z.string().min(1).optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
})

const MonitorIdInputSchema = z.object({
  id: z.string().min(1),
})

const CoordinatorRunInputSchema = z.object({
  prompt: z.string().min(1),
  workers: z.array(z.string().min(1)).optional(),
})

const UltraplanCreateInputSchema = z.object({
  prompt: z.string().min(1),
  seedPlan: z.string().optional(),
})

const AssistantModeInputSchema = z.object({
  mode: z.enum(['focused', 'assistant', 'proactive']),
})

const BriefCreateInputSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  channel: z.string().min(1).optional(),
})

const KairosChannelRegisterInputSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['local', 'github', 'push', 'weixin']).optional(),
  target: z.string().optional(),
})

const PushNotificationInputSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  channel: z.string().min(1).optional(),
})

const GithubWebhookSubscribeInputSchema = z.object({
  repo: z.string().min(1),
  pr_number: z.number().int().positive(),
  events: z.array(z.enum(['comment', 'review', 'ci', 'merge', 'close'])).optional(),
})

const SuggestBackgroundPRInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  branch: z.string().min(1).optional(),
})

const ProactiveScheduleInputSchema = z.object({
  prompt: z.string().min(1),
  delaySeconds: z.number().int().min(0).optional(),
})

export function getWorkflowTools(): Tool[] {
  return [
    agentTool,
    builtInAgentListTool,
    builtInAgentRunTool,
    taskCreateTool,
    taskUpdateTool,
    taskListTool,
    taskGetTool,
    taskOutputTool,
    taskStopTool,
    backgroundStartTool,
    backgroundListTool,
    backgroundOutputTool,
    backgroundStopTool,
    enterWorktreeTool,
    exitWorktreeTool,
    worktreeStatusTool,
    environmentRunnerTool,
    selfHostedRunnerTool,
    taskTemplateCreateTool,
    taskTemplateListTool,
    taskTemplateRunTool,
    workflowScriptRunTool,
    workflowScriptListTool,
    monitorStartTool,
    monitorListTool,
    monitorOutputTool,
    monitorStopTool,
    coordinatorRunTool,
    coordinatorListTool,
    ultraplanCreateTool,
    ultraplanListTool,
    assistantModeTool,
    assistantStateTool,
    briefCreateTool,
    briefListTool,
    kairosChannelRegisterTool,
    kairosChannelListTool,
    pushNotificationTool,
    pushNotificationListTool,
    githubWebhookSubscribeTool,
    githubWebhookListTool,
    suggestBackgroundPRTool,
    suggestBackgroundPRListTool,
    proactiveScheduleTool,
    proactiveListTool,
  ]
}

export async function createTask(
  cwd: string,
  input: z.infer<typeof TaskCreateInputSchema>,
): Promise<TaskRecord> {
  const tasks = await readTasks(cwd)
  const now = new Date().toISOString()
  const task: TaskRecord = {
    id: `task_${randomUUID()}`,
    title: input.title,
    prompt: input.prompt,
    status: 'pending',
    output: [],
    createdAt: now,
    updatedAt: now,
  }
  await writeTasks(cwd, [...tasks, task])
  return task
}

export async function updateTask(
  cwd: string,
  input: z.infer<typeof TaskUpdateInputSchema>,
): Promise<TaskRecord> {
  const tasks = await readTasks(cwd)
  const index = tasks.findIndex(task => task.id === input.id)
  if (index === -1) {
    throw new Error(`task not found: ${input.id}`)
  }
  const next = {
    ...tasks[index],
    ...(input.title ? { title: input.title } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    updatedAt: new Date().toISOString(),
  }
  const updated = [...tasks]
  updated[index] = next
  await writeTasks(cwd, updated)
  return next
}

export async function appendTaskOutput(
  cwd: string,
  input: z.infer<typeof TaskOutputInputSchema>,
): Promise<TaskRecord> {
  const tasks = await readTasks(cwd)
  const index = tasks.findIndex(task => task.id === input.id)
  if (index === -1) {
    throw new Error(`task not found: ${input.id}`)
  }
  const next = {
    ...tasks[index],
    output: [...tasks[index].output, input.output],
    updatedAt: new Date().toISOString(),
  }
  const updated = [...tasks]
  updated[index] = next
  await writeTasks(cwd, updated)
  return next
}

export async function stopTask(cwd: string, id: string): Promise<TaskRecord> {
  return updateTask(cwd, { id, status: 'stopped' })
}

export async function readTasks(cwd: string): Promise<TaskRecord[]> {
  return readJsonFile<TaskRecord[]>(tasksPath(cwd), [])
}

export async function getTask(cwd: string, id: string): Promise<TaskRecord> {
  const task = (await readTasks(cwd)).find(candidate => candidate.id === id)
  if (!task) {
    throw new Error(`task not found: ${id}`)
  }
  return task
}

export async function delegateAgentTask(
  cwd: string,
  input: z.infer<typeof AgentInputSchema>,
  context: ToolExecutionContext,
): Promise<AgentRecord> {
  ensureSubagentToolsDoNotExceedParent(input.allowedTools, context)
  const now = new Date().toISOString()
  const id = `agent_${randomUUID()}`
  const transcriptPath = join(cwd, '.my-claude-code', 'agents', `${id}.json`)
  const record: AgentRecord = {
    id,
    description: input.description,
    prompt: input.prompt,
    allowedTools: input.allowedTools,
    disallowedTools: context.disallowedTools,
    transcriptPath,
    summary: [
      `Delegated subagent task: ${input.description}`,
      `Prompt: ${input.prompt}`,
      `Allowed tools: ${input.allowedTools?.join(', ') ?? '(inherits parent)'}`,
      `Disallowed tools: ${context.disallowedTools?.join(', ') ?? '(none)'}`,
    ].join('\n'),
    createdAt: now,
  }
  await writeJsonFile(transcriptPath, record)
  return record
}

export function listBuiltInAgents(): BuiltInAgentDescriptor[] {
  return BUILT_IN_AGENTS
}

export async function runBuiltInAgent(
  cwd: string,
  input: z.infer<typeof BuiltInAgentRunInputSchema>,
  context: ToolExecutionContext,
): Promise<AgentRecord> {
  const agent = getBuiltInAgent(input.name)
  return delegateAgentTask(
    cwd,
    {
      description: `built-in ${agent.name} agent`,
      prompt: [
        agent.prompt,
        '',
        'User task:',
        input.prompt,
      ].join('\n'),
      allowedTools: agent.allowedTools,
    },
    context,
  )
}

export async function listAgents(cwd: string): Promise<AgentRecord[]> {
  const directory = join(cwd, '.my-claude-code', 'agents')
  try {
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(directory)
    const agents = await Promise.all(
      files
        .filter(file => file.endsWith('.json'))
        .map(file => readJsonFile<AgentRecord | undefined>(join(directory, file), undefined)),
    )
    return agents
      .filter((agent): agent is AgentRecord => Boolean(agent))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  } catch {
    return []
  }
}

export async function startBackgroundJob(
  cwd: string,
  input: z.infer<typeof BackgroundStartInputSchema>,
): Promise<BackgroundJobRecord> {
  const id = `bg_${randomUUID()}`
  const now = new Date().toISOString()
  const logPath = join(cwd, '.my-claude-code', 'background', `${id}.log`)
  await mkdir(dirname(logPath), { recursive: true })
  const logHandle = await open(logPath, 'a')
  const child = spawn(input.command, input.args ?? [], {
    cwd,
    detached: true,
    stdio: ['ignore', logHandle.fd, logHandle.fd],
  })
  child.unref()
  await logHandle.close()

  const record: BackgroundJobRecord = {
    id,
    name: input.name ?? input.command,
    command: input.command,
    args: input.args ?? [],
    pid: child.pid,
    status: 'running',
    logPath,
    createdAt: now,
    updatedAt: now,
  }
  await writeBackgroundJobs(cwd, [...(await readBackgroundJobs(cwd)), record])
  return record
}

export async function readBackgroundJobs(cwd: string): Promise<BackgroundJobRecord[]> {
  return readJsonFile<BackgroundJobRecord[]>(backgroundJobsPath(cwd), [])
}

export async function readBackgroundOutput(cwd: string, id: string): Promise<string> {
  const job = await getBackgroundJob(cwd, id)
  try {
    return await readFile(job.logPath, 'utf8')
  } catch {
    return ''
  }
}

export async function stopBackgroundJob(cwd: string, id: string): Promise<BackgroundJobRecord> {
  const jobs = await readBackgroundJobs(cwd)
  const index = jobs.findIndex(job => job.id === id)
  if (index === -1) {
    throw new Error(`background job not found: ${id}`)
  }
  const job = jobs[index]
  if (job.pid) {
    try {
      process.kill(job.pid)
    } catch {
    }
  }
  const next = {
    ...job,
    status: 'stopped' as const,
    updatedAt: new Date().toISOString(),
  }
  const updated = [...jobs]
  updated[index] = next
  await writeBackgroundJobs(cwd, updated)
  return next
}

export async function enterWorktree(
  cwd: string,
  input: z.infer<typeof EnterWorktreeInputSchema>,
): Promise<WorktreeState> {
  const target = resolve(cwd, input.path)
  const state = await readWorktreeState(cwd)
  const enteredAt = new Date().toISOString()
  const entry = {
    path: target,
    branch: input.branch,
    enteredAt,
  }
  const next: WorktreeState = {
    active: entry,
    history: [...state.history, entry],
  }
  await writeJsonFile(worktreeStatePath(cwd), next)
  return next
}

export async function exitWorktree(cwd: string): Promise<WorktreeState> {
  const state = await readWorktreeState(cwd)
  if (!state.active) {
    return state
  }
  const exitedAt = new Date().toISOString()
  const next: WorktreeState = {
    active: undefined,
    history: state.history.map((entry, index) =>
      index === state.history.length - 1 ? { ...entry, exitedAt } : entry,
    ),
  }
  await writeJsonFile(worktreeStatePath(cwd), next)
  return next
}

export async function readWorktreeState(cwd: string): Promise<WorktreeState> {
  return readJsonFile<WorktreeState>(worktreeStatePath(cwd), { history: [] })
}

export async function runEnvironmentRunner(
  cwd: string,
  input: z.infer<typeof RunnerInputSchema> = {},
): Promise<RunnerRunRecord> {
  return runHeadlessRunner(cwd, 'environment', input)
}

export async function runSelfHostedRunner(
  cwd: string,
  input: z.infer<typeof RunnerInputSchema> = {},
): Promise<RunnerRunRecord> {
  return runHeadlessRunner(cwd, 'self-hosted', input)
}

export async function readRunnerProfiles(cwd: string): Promise<RunnerProfile[]> {
  return readJsonFile<RunnerProfile[]>(runnerProfilesPath(cwd), [])
}

export async function readRunnerRuns(cwd: string): Promise<RunnerRunRecord[]> {
  return readJsonFile<RunnerRunRecord[]>(runnerRunsPath(cwd), [])
}

export async function createTaskTemplate(
  cwd: string,
  input: z.infer<typeof TaskTemplateCreateInputSchema>,
): Promise<TaskTemplateRecord> {
  const templates = await readTaskTemplates(cwd)
  const now = new Date().toISOString()
  const existingIndex = templates.findIndex(template => template.name === input.name)
  const record: TaskTemplateRecord = {
    id: existingIndex === -1 ? `template_${randomUUID()}` : templates[existingIndex].id,
    name: input.name,
    title: input.title,
    prompt: input.prompt,
    createdAt: existingIndex === -1 ? now : templates[existingIndex].createdAt,
    updatedAt: now,
  }
  const next = existingIndex === -1 ? [...templates, record] : [...templates]
  if (existingIndex !== -1) {
    next[existingIndex] = record
  }
  await writeJsonFile(taskTemplatesPath(cwd), next)
  return record
}

export async function readTaskTemplates(cwd: string): Promise<TaskTemplateRecord[]> {
  return readJsonFile<TaskTemplateRecord[]>(taskTemplatesPath(cwd), [])
}

export async function runTaskTemplate(
  cwd: string,
  input: z.infer<typeof TaskTemplateRunInputSchema>,
): Promise<TaskRecord> {
  const template = (await readTaskTemplates(cwd)).find(
    candidate => candidate.name === input.name || candidate.id === input.name,
  )
  if (!template) {
    throw new Error(`task template not found: ${input.name}`)
  }
  return createTask(cwd, {
    title: template.title,
    prompt: template.prompt,
  })
}

export async function runWorkflowScript(
  cwd: string,
  input: z.infer<typeof WorkflowScriptRunInputSchema>,
): Promise<WorkflowScriptRunRecord> {
  const startedAt = new Date().toISOString()
  const runCwd = resolve(cwd, input.cwd ?? '.')
  const result = await runRunnerProcess(
    runCwd,
    input.command,
    input.args ?? [],
    input.env,
  )
  const completedAt = new Date().toISOString()
  const record: WorkflowScriptRunRecord = {
    id: `workflow_${randomUUID()}`,
    name: input.name ?? input.command,
    cwd: runCwd,
    command: input.command,
    args: input.args ?? [],
    envKeys: Object.keys(input.env ?? {}).sort(),
    status: result.exitCode === 0 ? 'completed' : 'failed',
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    startedAt,
    completedAt,
  }
  await writeJsonFile(workflowRunsPath(cwd), [
    ...(await readWorkflowScriptRuns(cwd)),
    record,
  ])
  return record
}

export async function readWorkflowScriptRuns(
  cwd: string,
): Promise<WorkflowScriptRunRecord[]> {
  return readJsonFile<WorkflowScriptRunRecord[]>(workflowRunsPath(cwd), [])
}

export async function startMonitor(
  cwd: string,
  input: z.infer<typeof MonitorStartInputSchema>,
): Promise<MonitorRecord> {
  const job = await startBackgroundJob(cwd, {
    name: input.name ?? input.command,
    command: input.command,
    args: input.args,
  })
  const record: MonitorRecord = {
    id: `monitor_${randomUUID()}`,
    name: input.name ?? job.name,
    command: job.command,
    args: job.args,
    backgroundJobId: job.id,
    status: job.status,
    logPath: job.logPath,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
  await writeJsonFile(monitorsPath(cwd), [...(await readMonitors(cwd)), record])
  return record
}

export async function readMonitors(cwd: string): Promise<MonitorRecord[]> {
  return readJsonFile<MonitorRecord[]>(monitorsPath(cwd), [])
}

export async function readMonitorOutput(cwd: string, id: string): Promise<string> {
  const monitor = await getMonitor(cwd, id)
  return readBackgroundOutput(cwd, monitor.backgroundJobId)
}

export async function stopMonitor(cwd: string, id: string): Promise<MonitorRecord> {
  const monitors = await readMonitors(cwd)
  const index = monitors.findIndex(monitor => monitor.id === id)
  if (index === -1) {
    throw new Error(`monitor not found: ${id}`)
  }
  const stopped = await stopBackgroundJob(cwd, monitors[index].backgroundJobId)
  const next = {
    ...monitors[index],
    status: stopped.status,
    updatedAt: stopped.updatedAt,
  }
  const updated = [...monitors]
  updated[index] = next
  await writeJsonFile(monitorsPath(cwd), updated)
  return next
}

export async function runCoordinator(
  cwd: string,
  input: z.infer<typeof CoordinatorRunInputSchema>,
  context: ToolExecutionContext,
): Promise<CoordinatorRunRecord> {
  const workerNames = input.workers?.length
    ? input.workers
    : ['research', 'implementation', 'verification']
  const workers = await Promise.all(
    workerNames.map(worker =>
      delegateAgentTask(
        cwd,
        {
          description: `coordinator ${worker} worker`,
          prompt: [
            'You are a coordinator worker. Complete this phase independently and report concise findings.',
            `Phase: ${worker}`,
            `Coordinator task: ${input.prompt}`,
          ].join('\n'),
        },
        context,
      ),
    ),
  )
  const record: CoordinatorRunRecord = {
    id: `coordinator_${randomUUID()}`,
    prompt: input.prompt,
    workerCount: workers.length,
    workerIds: workers.map(worker => worker.id),
    status: 'completed',
    summary: `Launched ${workers.length} local coordinator worker records for: ${input.prompt}`,
    createdAt: new Date().toISOString(),
  }
  await writeJsonFile(coordinatorRunsPath(cwd), [
    ...(await readCoordinatorRuns(cwd)),
    record,
  ])
  return record
}

export async function readCoordinatorRuns(cwd: string): Promise<CoordinatorRunRecord[]> {
  return readJsonFile<CoordinatorRunRecord[]>(coordinatorRunsPath(cwd), [])
}

export async function createUltraplan(
  cwd: string,
  input: z.infer<typeof UltraplanCreateInputSchema>,
): Promise<UltraplanRecord> {
  const now = new Date().toISOString()
  const plan = input.seedPlan?.trim() || [
    `# Ultraplan: ${input.prompt}`,
    '',
    '1. Explore the current code and constraints.',
    '2. Split the work into research, implementation, and verification phases.',
    '3. Implement the smallest coherent change set.',
    '4. Run targeted checks first, then full validation.',
    '5. Summarize residual parity gaps with concrete next steps.',
  ].join('\n')
  const record: UltraplanRecord = {
    id: `ultraplan_${randomUUID()}`,
    prompt: input.prompt,
    seedPlan: input.seedPlan,
    plan,
    phase: 'ready',
    createdAt: now,
    updatedAt: now,
  }
  await writeJsonFile(ultraplansPath(cwd), [
    ...(await readUltraplans(cwd)),
    record,
  ])
  return record
}

export async function readUltraplans(cwd: string): Promise<UltraplanRecord[]> {
  return readJsonFile<UltraplanRecord[]>(ultraplansPath(cwd), [])
}

export async function setAssistantMode(
  cwd: string,
  input: z.infer<typeof AssistantModeInputSchema>,
): Promise<AssistantModeState> {
  const state: AssistantModeState = {
    active: input.mode !== 'focused',
    mode: input.mode,
    updatedAt: new Date().toISOString(),
  }
  await writeJsonFile(assistantStatePath(cwd), state)
  return state
}

export async function readAssistantMode(cwd: string): Promise<AssistantModeState> {
  return readJsonFile<AssistantModeState>(assistantStatePath(cwd), {
    active: false,
    mode: 'focused',
    updatedAt: '',
  })
}

export async function createBrief(
  cwd: string,
  input: z.infer<typeof BriefCreateInputSchema>,
): Promise<BriefRecord> {
  const record: BriefRecord = {
    id: `brief_${randomUUID()}`,
    title: input.title,
    body: input.body,
    channel: input.channel,
    createdAt: new Date().toISOString(),
  }
  await writeJsonFile(briefsPath(cwd), [...(await readBriefs(cwd)), record])
  return record
}

export async function readBriefs(cwd: string): Promise<BriefRecord[]> {
  return readJsonFile<BriefRecord[]>(briefsPath(cwd), [])
}

export async function registerKairosChannel(
  cwd: string,
  input: z.infer<typeof KairosChannelRegisterInputSchema>,
): Promise<KairosChannelRecord> {
  const channels = await readKairosChannels(cwd)
  const existingIndex = channels.findIndex(channel => channel.name === input.name)
  const record: KairosChannelRecord = {
    id: existingIndex === -1 ? `channel_${randomUUID()}` : channels[existingIndex].id,
    name: input.name,
    kind: input.kind ?? 'local',
    target: input.target,
    createdAt: existingIndex === -1 ? new Date().toISOString() : channels[existingIndex].createdAt,
  }
  const next = existingIndex === -1 ? [...channels, record] : [...channels]
  if (existingIndex !== -1) {
    next[existingIndex] = record
  }
  await writeJsonFile(kairosChannelsPath(cwd), next)
  return record
}

export async function readKairosChannels(cwd: string): Promise<KairosChannelRecord[]> {
  return readJsonFile<KairosChannelRecord[]>(kairosChannelsPath(cwd), [])
}

export async function queuePushNotification(
  cwd: string,
  input: z.infer<typeof PushNotificationInputSchema>,
): Promise<PushNotificationRecord> {
  const dispatch = await dispatchLocalNotification({
    title: input.title,
    body: input.body,
  })
  const record: PushNotificationRecord = {
    id: `push_${randomUUID()}`,
    title: input.title,
    body: input.body,
    channel: input.channel,
    status: 'queued',
    dispatch,
    createdAt: new Date().toISOString(),
  }
  await writeJsonFile(pushNotificationsPath(cwd), [
    ...(await readPushNotifications(cwd)),
    record,
  ])
  return record
}

export async function readPushNotifications(
  cwd: string,
): Promise<PushNotificationRecord[]> {
  return readJsonFile<PushNotificationRecord[]>(pushNotificationsPath(cwd), [])
}

export async function subscribeGithubWebhook(
  cwd: string,
  input: z.infer<typeof GithubWebhookSubscribeInputSchema>,
): Promise<GithubWebhookSubscriptionRecord> {
  const id = `github_webhook_${randomUUID()}`
  const record: GithubWebhookSubscriptionRecord = {
    id,
    subscription_id: id,
    repo: input.repo,
    pr_number: input.pr_number,
    events: input.events?.length
      ? input.events
      : ['comment', 'review', 'ci', 'merge', 'close'],
    subscribed: true,
    status: 'subscribed',
    createdAt: new Date().toISOString(),
  }
  await writeJsonFile(githubWebhookSubscriptionsPath(cwd), [
    ...(await readGithubWebhookSubscriptions(cwd)),
    record,
  ])
  return record
}

export async function readGithubWebhookSubscriptions(
  cwd: string,
): Promise<GithubWebhookSubscriptionRecord[]> {
  return readJsonFile<GithubWebhookSubscriptionRecord[]>(
    githubWebhookSubscriptionsPath(cwd),
    [],
  )
}

export async function suggestBackgroundPR(
  cwd: string,
  input: z.infer<typeof SuggestBackgroundPRInputSchema>,
): Promise<BackgroundPRSuggestionRecord> {
  const id = `background_pr_${randomUUID()}`
  const record: BackgroundPRSuggestionRecord = {
    id,
    suggestion_id: id,
    title: input.title,
    description: input.description,
    branch: input.branch ?? defaultBackgroundPRBranch(input.title, id),
    suggested: true,
    status: 'suggested',
    createdAt: new Date().toISOString(),
  }
  await writeJsonFile(backgroundPRSuggestionsPath(cwd), [
    ...(await readBackgroundPRSuggestions(cwd)),
    record,
  ])
  return record
}

export async function readBackgroundPRSuggestions(
  cwd: string,
): Promise<BackgroundPRSuggestionRecord[]> {
  return readJsonFile<BackgroundPRSuggestionRecord[]>(
    backgroundPRSuggestionsPath(cwd),
    [],
  )
}

export async function scheduleProactiveTick(
  cwd: string,
  input: z.infer<typeof ProactiveScheduleInputSchema>,
): Promise<ProactiveTickRecord> {
  const now = Date.now()
  const delayMs = (input.delaySeconds ?? 60) * 1000
  const record: ProactiveTickRecord = {
    id: `proactive_${randomUUID()}`,
    prompt: input.prompt,
    nextTickAt: new Date(now + delayMs).toISOString(),
    status: 'scheduled',
    createdAt: new Date(now).toISOString(),
  }
  await writeJsonFile(proactiveTicksPath(cwd), [
    ...(await readProactiveTicks(cwd)),
    record,
  ])
  return record
}

export async function readProactiveTicks(cwd: string): Promise<ProactiveTickRecord[]> {
  return readJsonFile<ProactiveTickRecord[]>(proactiveTicksPath(cwd), [])
}

const agentTool: Tool<z.infer<typeof AgentInputSchema>> = {
  name: 'Agent',
  description: 'Delegate a task to an isolated local subagent record and return a result summary.',
  inputSchema: AgentInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      description: { type: 'string' },
      prompt: { type: 'string' },
      allowedTools: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['description', 'prompt'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    const record = await delegateAgentTask(context.cwd, input, context)
    return JSON.stringify(record, null, 2)
  },
}

const builtInAgentListTool: Tool = {
  name: 'BuiltinAgentList',
  description: 'List bundled Explore and Plan agent personas.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute() {
    return JSON.stringify(listBuiltInAgents(), null, 2)
  },
}

const builtInAgentRunTool: Tool<z.infer<typeof BuiltInAgentRunInputSchema>> = {
  name: 'BuiltinAgentRun',
  description: 'Run a bundled Explore or Plan agent persona as a local subagent record.',
  inputSchema: BuiltInAgentRunInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', enum: ['explore', 'plan'] },
      prompt: { type: 'string' },
    },
    required: ['name', 'prompt'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await runBuiltInAgent(context.cwd, input, context), null, 2)
  },
}

const taskCreateTool: Tool<z.infer<typeof TaskCreateInputSchema>> = {
  name: 'TaskCreate',
  description: 'Create a persistent task record for a long-running workflow.',
  inputSchema: TaskCreateInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      prompt: { type: 'string' },
    },
    required: ['title'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await createTask(context.cwd, input), null, 2)
  },
}

const taskUpdateTool: Tool<z.infer<typeof TaskUpdateInputSchema>> = {
  name: 'TaskUpdate',
  description: 'Update title, status, or summary for a persistent task.',
  inputSchema: TaskUpdateInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed', 'stopped'] },
      summary: { type: 'string' },
    },
    required: ['id'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await updateTask(context.cwd, input), null, 2)
  },
}

const taskListTool: Tool = {
  name: 'TaskList',
  description: 'List persistent workflow tasks.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await readTasks(context.cwd), null, 2)
  },
}

const taskGetTool: Tool<z.infer<typeof TaskIdInputSchema>> = {
  name: 'TaskGet',
  description: 'Get one persistent task by id.',
  inputSchema: TaskIdInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await getTask(context.cwd, input.id), null, 2)
  },
}

const taskOutputTool: Tool<z.infer<typeof TaskOutputInputSchema>> = {
  name: 'TaskOutput',
  description: 'Append output text to a persistent task.',
  inputSchema: TaskOutputInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      output: { type: 'string' },
    },
    required: ['id', 'output'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await appendTaskOutput(context.cwd, input), null, 2)
  },
}

const taskStopTool: Tool<z.infer<typeof TaskIdInputSchema>> = {
  name: 'TaskStop',
  description: 'Mark a persistent task as stopped.',
  inputSchema: TaskIdInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await stopTask(context.cwd, input.id), null, 2)
  },
}

const backgroundStartTool: Tool<z.infer<typeof BackgroundStartInputSchema>> = {
  name: 'BackgroundStart',
  description: 'Start a detached local background process and record its log path.',
  inputSchema: BackgroundStartInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      command: { type: 'string' },
      args: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['command'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: (_, context) =>
    context.permissionMode === 'bypassPermissions'
      ? { decision: 'allow' }
      : {
          decision: 'ask',
          reason: 'BackgroundStart launches a local process',
        },
  async execute(input, context) {
    return JSON.stringify(await startBackgroundJob(context.cwd, input), null, 2)
  },
}

const backgroundListTool: Tool = {
  name: 'BackgroundList',
  description: 'List recorded background jobs.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await readBackgroundJobs(context.cwd), null, 2)
  },
}

const backgroundOutputTool: Tool<z.infer<typeof BackgroundIdInputSchema>> = {
  name: 'BackgroundOutput',
  description: 'Read log output for a recorded background job.',
  inputSchema: BackgroundIdInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return readBackgroundOutput(context.cwd, input.id)
  },
}

const backgroundStopTool: Tool<z.infer<typeof BackgroundIdInputSchema>> = {
  name: 'BackgroundStop',
  description: 'Stop a recorded background job by pid and mark it stopped.',
  inputSchema: BackgroundIdInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await stopBackgroundJob(context.cwd, input.id), null, 2)
  },
}

const enterWorktreeTool: Tool<z.infer<typeof EnterWorktreeInputSchema>> = {
  name: 'EnterWorktree',
  description: 'Record the active worktree path for this workspace session.',
  inputSchema: EnterWorktreeInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      branch: { type: 'string' },
    },
    required: ['path'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await enterWorktree(context.cwd, input), null, 2)
  },
}

const exitWorktreeTool: Tool = {
  name: 'ExitWorktree',
  description: 'Clear the active worktree session metadata.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await exitWorktree(context.cwd), null, 2)
  },
}

const worktreeStatusTool: Tool = {
  name: 'WorktreeStatus',
  description: 'Read active worktree session metadata.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await readWorktreeState(context.cwd), null, 2)
  },
}

const environmentRunnerTool: Tool<z.infer<typeof RunnerInputSchema>> = {
  name: 'EnvironmentRunner',
  description: 'Run a local BYOC environment-runner smoke with a schema-safe profile record.',
  inputSchema: RunnerInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      command: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
      env: { type: 'object' },
      cwd: { type: 'string' },
    },
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await runEnvironmentRunner(context.cwd, input), null, 2)
  },
}

const selfHostedRunnerTool: Tool<z.infer<typeof RunnerInputSchema>> = {
  name: 'SelfHostedRunner',
  description: 'Run a local self-hosted-runner smoke with a schema-safe profile record.',
  inputSchema: RunnerInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      command: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
      env: { type: 'object' },
      cwd: { type: 'string' },
    },
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await runSelfHostedRunner(context.cwd, input), null, 2)
  },
}

const taskTemplateCreateTool: Tool<z.infer<typeof TaskTemplateCreateInputSchema>> = {
  name: 'TaskTemplateCreate',
  description: 'Create or update a reusable local task template.',
  inputSchema: TaskTemplateCreateInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      title: { type: 'string' },
      prompt: { type: 'string' },
    },
    required: ['name', 'title'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await createTaskTemplate(context.cwd, input), null, 2)
  },
}

const taskTemplateListTool: Tool = {
  name: 'TaskTemplateList',
  description: 'List reusable local task templates.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await readTaskTemplates(context.cwd), null, 2)
  },
}

const taskTemplateRunTool: Tool<z.infer<typeof TaskTemplateRunInputSchema>> = {
  name: 'TaskTemplateRun',
  description: 'Create a task from a reusable local task template.',
  inputSchema: TaskTemplateRunInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
    },
    required: ['name'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await runTaskTemplate(context.cwd, input), null, 2)
  },
}

const workflowScriptRunTool: Tool<z.infer<typeof WorkflowScriptRunInputSchema>> = {
  name: 'WorkflowScriptRun',
  description: 'Run a local workflow script and persist a secret-safe run record.',
  inputSchema: WorkflowScriptRunInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      command: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
      env: { type: 'object' },
      cwd: { type: 'string' },
    },
    required: ['command'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: (_, context) =>
    context.permissionMode === 'bypassPermissions'
      ? { decision: 'allow' }
      : {
          decision: 'ask',
          reason: 'WorkflowScriptRun launches a local process',
        },
  async execute(input, context) {
    return JSON.stringify(await runWorkflowScript(context.cwd, input), null, 2)
  },
}

const workflowScriptListTool: Tool = {
  name: 'WorkflowScriptList',
  description: 'List persisted local workflow script runs.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await readWorkflowScriptRuns(context.cwd), null, 2)
  },
}

const monitorStartTool: Tool<z.infer<typeof MonitorStartInputSchema>> = {
  name: 'MonitorStart',
  description: 'Start a long-running monitor command and persist a monitor record.',
  inputSchema: MonitorStartInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      command: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
    },
    required: ['command'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: (_, context) =>
    context.permissionMode === 'bypassPermissions'
      ? { decision: 'allow' }
      : {
          decision: 'ask',
          reason: 'MonitorStart launches a local process',
        },
  async execute(input, context) {
    return JSON.stringify(await startMonitor(context.cwd, input), null, 2)
  },
}

const monitorListTool: Tool = {
  name: 'MonitorList',
  description: 'List persisted local monitor records.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await readMonitors(context.cwd), null, 2)
  },
}

const monitorOutputTool: Tool<z.infer<typeof MonitorIdInputSchema>> = {
  name: 'MonitorOutput',
  description: 'Read log output for a persisted monitor record.',
  inputSchema: MonitorIdInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return readMonitorOutput(context.cwd, input.id)
  },
}

const monitorStopTool: Tool<z.infer<typeof MonitorIdInputSchema>> = {
  name: 'MonitorStop',
  description: 'Stop a persisted monitor by its background job.',
  inputSchema: MonitorIdInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await stopMonitor(context.cwd, input.id), null, 2)
  },
}

const coordinatorRunTool: Tool<z.infer<typeof CoordinatorRunInputSchema>> = {
  name: 'CoordinatorRun',
  description: 'Launch local coordinator worker records for research, implementation, and verification phases.',
  inputSchema: CoordinatorRunInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      workers: { type: 'array', items: { type: 'string' } },
    },
    required: ['prompt'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await runCoordinator(context.cwd, input, context), null, 2)
  },
}

const coordinatorListTool: Tool = {
  name: 'CoordinatorList',
  description: 'List local coordinator run records.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await readCoordinatorRuns(context.cwd), null, 2)
  },
}

const ultraplanCreateTool: Tool<z.infer<typeof UltraplanCreateInputSchema>> = {
  name: 'UltraplanCreate',
  description: 'Create a local ultraplan record with a ready-to-review plan.',
  inputSchema: UltraplanCreateInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      seedPlan: { type: 'string' },
    },
    required: ['prompt'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await createUltraplan(context.cwd, input), null, 2)
  },
}

const ultraplanListTool: Tool = {
  name: 'UltraplanList',
  description: 'List local ultraplan records.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await readUltraplans(context.cwd), null, 2)
  },
}

const assistantModeTool: Tool<z.infer<typeof AssistantModeInputSchema>> = {
  name: 'AssistantMode',
  description: 'Set local assistant/Kairos mode state without external network calls.',
  inputSchema: AssistantModeInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['focused', 'assistant', 'proactive'] },
    },
    required: ['mode'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await setAssistantMode(context.cwd, input), null, 2)
  },
}

const assistantStateTool: Tool = {
  name: 'AssistantState',
  description: 'Read local assistant/Kairos mode state.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await readAssistantMode(context.cwd), null, 2)
  },
}

const briefCreateTool: Tool<z.infer<typeof BriefCreateInputSchema>> = {
  name: 'BriefCreate',
  description: 'Create a local Kairos brief record.',
  inputSchema: BriefCreateInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      body: { type: 'string' },
      channel: { type: 'string' },
    },
    required: ['title', 'body'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await createBrief(context.cwd, input), null, 2)
  },
}

const briefListTool: Tool = {
  name: 'BriefList',
  description: 'List local Kairos brief records.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await readBriefs(context.cwd), null, 2)
  },
}

const kairosChannelRegisterTool: Tool<z.infer<typeof KairosChannelRegisterInputSchema>> = {
  name: 'KairosChannelRegister',
  description: 'Register a local Kairos channel endpoint.',
  inputSchema: KairosChannelRegisterInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      kind: { type: 'string', enum: ['local', 'github', 'push', 'weixin'] },
      target: { type: 'string' },
    },
    required: ['name'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await registerKairosChannel(context.cwd, input), null, 2)
  },
}

const kairosChannelListTool: Tool = {
  name: 'KairosChannelList',
  description: 'List local Kairos channels.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await readKairosChannels(context.cwd), null, 2)
  },
}

const pushNotificationTool: Tool<z.infer<typeof PushNotificationInputSchema>> = {
  name: 'PushNotification',
  description: 'Queue a local push-notification record without contacting a push service.',
  inputSchema: PushNotificationInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      body: { type: 'string' },
      channel: { type: 'string' },
    },
    required: ['title', 'body'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await queuePushNotification(context.cwd, input), null, 2)
  },
}

const pushNotificationListTool: Tool = {
  name: 'PushNotificationList',
  description: 'List queued local push-notification records.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await readPushNotifications(context.cwd), null, 2)
  },
}

const githubWebhookSubscribeTool: Tool<z.infer<typeof GithubWebhookSubscribeInputSchema>> = {
  name: 'SubscribePR',
  description: 'Subscribe to pull request events via a local GitHub webhook subscription record.',
  inputSchema: GithubWebhookSubscribeInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string' },
      pr_number: { type: 'number' },
      events: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['comment', 'review', 'ci', 'merge', 'close'],
        },
      },
    },
    required: ['repo', 'pr_number'],
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await subscribeGithubWebhook(context.cwd, input), null, 2)
  },
}

const githubWebhookListTool: Tool = {
  name: 'SubscribePRList',
  description: 'List local GitHub PR webhook subscriptions.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await readGithubWebhookSubscriptions(context.cwd), null, 2)
  },
}

const suggestBackgroundPRTool: Tool<z.infer<typeof SuggestBackgroundPRInputSchema>> = {
  name: 'SuggestBackgroundPR',
  description: 'Suggest creating a background PR for follow-up changes.',
  inputSchema: SuggestBackgroundPRInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      branch: { type: 'string' },
    },
    required: ['title', 'description'],
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await suggestBackgroundPR(context.cwd, input), null, 2)
  },
}

const suggestBackgroundPRListTool: Tool = {
  name: 'SuggestBackgroundPRList',
  description: 'List local background PR suggestions.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await readBackgroundPRSuggestions(context.cwd), null, 2)
  },
}

const proactiveScheduleTool: Tool<z.infer<typeof ProactiveScheduleInputSchema>> = {
  name: 'ProactiveSchedule',
  description: 'Schedule a local proactive tick record.',
  inputSchema: ProactiveScheduleInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      delaySeconds: { type: 'number' },
    },
    required: ['prompt'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await scheduleProactiveTick(context.cwd, input), null, 2)
  },
}

const proactiveListTool: Tool = {
  name: 'ProactiveList',
  description: 'List local proactive tick records.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(_, context) {
    return JSON.stringify(await readProactiveTicks(context.cwd), null, 2)
  },
}

function ensureSubagentToolsDoNotExceedParent(
  requestedTools: string[] | undefined,
  context: ToolExecutionContext,
): void {
  if (!requestedTools?.length || !context.allowedTools?.length) {
    return
  }
  const restrictiveRules = context.allowedTools.filter(rule => !isPatternToolRule(rule))
  if (restrictiveRules.length === 0) {
    return
  }
  const invalid = requestedTools.find(
    requested => !restrictiveRules.some(rule => matchesToolNameRule(requested, rule)),
  )
  if (invalid) {
    throw new Error(`subagent tool ${invalid} exceeds parent allowedTools`)
  }
}

async function getBackgroundJob(
  cwd: string,
  id: string,
): Promise<BackgroundJobRecord> {
  const job = (await readBackgroundJobs(cwd)).find(candidate => candidate.id === id)
  if (!job) {
    throw new Error(`background job not found: ${id}`)
  }
  return job
}

async function getMonitor(cwd: string, id: string): Promise<MonitorRecord> {
  const monitor = (await readMonitors(cwd)).find(candidate => candidate.id === id)
  if (!monitor) {
    throw new Error(`monitor not found: ${id}`)
  }
  return monitor
}

function getBuiltInAgent(name: BuiltInAgentName): BuiltInAgentDescriptor {
  return BUILT_IN_AGENTS.find(agent => agent.name === name) ?? BUILT_IN_AGENTS[0]
}

async function runHeadlessRunner(
  cwd: string,
  kind: RunnerKind,
  input: z.infer<typeof RunnerInputSchema>,
): Promise<RunnerRunRecord> {
  const startedAt = new Date().toISOString()
  const id = `runner_${randomUUID()}`
  const runCwd = resolve(cwd, input.cwd ?? '.')
  const command = input.command ?? process.execPath
  const args = input.args ?? [
    '-e',
    `console.log("${kind === 'environment' ? 'environment-runner-ready' : 'self-hosted-runner-ready'}")`,
  ]
  const profile: RunnerProfile = {
    id,
    kind,
    name: input.name ?? `${kind}-runner`,
    cwd: runCwd,
    command,
    args,
    envKeys: Object.keys(input.env ?? {}).sort(),
    status: 'ready',
    createdAt: startedAt,
    updatedAt: startedAt,
  }

  const result = await runRunnerProcess(runCwd, command, args, input.env)
  const completedAt = new Date().toISOString()
  const run: RunnerRunRecord = {
    id: `run_${randomUUID()}`,
    profileId: profile.id,
    kind,
    status: result.exitCode === 0 ? 'completed' : 'failed',
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    startedAt,
    completedAt,
  }
  profile.status = run.status === 'completed' ? 'ready' : 'failed'
  profile.updatedAt = completedAt

  await writeJsonFile(runnerProfilesPath(cwd), [
    ...(await readRunnerProfiles(cwd)),
    profile,
  ])
  await writeJsonFile(runnerRunsPath(cwd), [
    ...(await readRunnerRuns(cwd)),
    run,
  ])
  return run
}

function runRunnerProcess(
  cwd: string,
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...(env ?? {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', error => {
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr || error.message,
      })
    })
    child.on('close', code => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      })
    })
  })
}

async function writeTasks(cwd: string, tasks: TaskRecord[]): Promise<void> {
  await writeJsonFile(tasksPath(cwd), tasks)
}

async function writeBackgroundJobs(
  cwd: string,
  jobs: BackgroundJobRecord[],
): Promise<void> {
  await writeJsonFile(backgroundJobsPath(cwd), jobs)
}

function tasksPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'tasks', 'tasks.json')
}

function backgroundJobsPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'background', 'jobs.json')
}

function worktreeStatePath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'worktrees', 'current.json')
}

function runnerProfilesPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'runners', 'profiles.json')
}

function runnerRunsPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'runners', 'runs.json')
}

function taskTemplatesPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'tasks', 'templates.json')
}

function workflowRunsPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'workflows', 'runs.json')
}

function monitorsPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'monitors', 'monitors.json')
}

function coordinatorRunsPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'coordinator', 'runs.json')
}

function ultraplansPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'ultraplan', 'plans.json')
}

function assistantStatePath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'assistant', 'state.json')
}

function briefsPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'assistant', 'briefs.json')
}

function kairosChannelsPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'assistant', 'channels.json')
}

function pushNotificationsPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'assistant', 'push-notifications.json')
}

function githubWebhookSubscriptionsPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'assistant', 'github-webhooks.json')
}

function backgroundPRSuggestionsPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'assistant', 'background-pr-suggestions.json')
}

function proactiveTicksPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'assistant', 'proactive-ticks.json')
}

function defaultBackgroundPRBranch(title: string, id: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const suffix = id.replace(/^background_pr_/, '').slice(0, 8)
  return `background/${slug || 'follow-up'}-${suffix}`
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const BUILT_IN_AGENTS: BuiltInAgentDescriptor[] = [
  {
    name: 'explore',
    description: 'Read-only codebase exploration agent for locating files, contracts, and risks.',
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    prompt: [
      'You are the built-in Explore agent.',
      'Map the relevant code paths, tests, docs, and risks.',
      'Do not edit files. Return concise findings with file references and suggested next steps.',
    ].join('\n'),
  },
  {
    name: 'plan',
    description: 'Planning agent for decomposing implementation work into small verifiable steps.',
    allowedTools: ['Read', 'Glob', 'Grep'],
    prompt: [
      'You are the built-in Plan agent.',
      'Turn the user task into a concrete implementation plan.',
      'Include scope, files to inspect or edit, tests to run, and residual risks.',
      'Do not edit files.',
    ].join('\n'),
  },
]
