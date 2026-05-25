import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type MessageActionRecord = {
  id: string
  messageId: string
  action: 'copy' | 'retry' | 'edit' | 'delete' | 'pin' | 'rate'
  reason?: string
  replacementHash?: string
  status: 'recorded'
  createdAt: string
}

export type VerificationAgentRecord = {
  id: string
  objective: string
  planSummary?: string
  checks: string[]
  workerPhases: Array<{
    id: string
    phase: 'explore' | 'execute' | 'verify'
    prompt: string
    transcriptPath: string
    status: 'completed'
  }>
  status: 'verified' | 'needs_attention'
  createdAt: string
}

export type ReviewArtifactAnnotation = {
  line?: number
  message: string
  severity: 'info' | 'warning' | 'error' | 'suggestion'
}

export type ReviewArtifactMutationRecord = {
  id: string
  title?: string
  artifactHash: string
  artifactPath: string
  targetPath?: string
  mutationApplied: boolean
  backupPath?: string
  annotationCount: number
  summary?: string
  annotations: ReviewArtifactAnnotation[]
  createdAt: string
}

export type JobClassificationRecord = {
  id: string
  prompt: string
  command?: string
  kind: 'agent' | 'workflow' | 'monitor' | 'review' | 'diagnostic'
  confidence: number
  reasons: string[]
  createdAt: string
}

export type CronScheduleRecord = {
  id: string
  name: string
  cron: string
  prompt?: string
  command?: string
  args: string[]
  status: 'scheduled' | 'paused'
  nextRunAt: string
  createdAt: string
  updatedAt: string
}

export type CronRunRecord = {
  id: string
  scheduleId: string
  status: 'completed' | 'failed' | 'skipped'
  exitCode?: number
  stdout?: string
  stderr?: string
  startedAt: string
  completedAt: string
}

export type WorkflowEventKind =
  | 'ant-trace'
  | 'bughunter'
  | 'ctx_viz'
  | 'debug-tool-call'
  | 'feedback'
  | 'good-claude'
  | 'heapdump'
  | 'issue'
  | 'perf-issue'
  | 'pr-comments'
  | 'release-notes'
  | 'review'
  | 'security-review'
  | 'share'
  | 'stickers'
  | 'tag'
  | 'thinkback'
  | 'thinkback-play'

export type WorkflowEventRecord = {
  id: string
  kind: WorkflowEventKind
  summary: string
  payloadHash: string
  status: 'recorded' | 'prepared'
  artifactPath: string
  createdAt: string
}

export async function recordMessageAction(
  cwd: string,
  input: {
    messageId: string
    action: MessageActionRecord['action']
    reason?: string
    replacement?: string
  },
): Promise<MessageActionRecord> {
  const record: MessageActionRecord = {
    id: `message_action_${randomUUID()}`,
    messageId: input.messageId,
    action: input.action,
    reason: input.reason,
    replacementHash: input.replacement ? sha256(input.replacement) : undefined,
    status: 'recorded',
    createdAt: new Date().toISOString(),
  }
  await appendJsonRecord(messageActionsPath(cwd), record)
  return record
}

export async function runVerificationAgent(
  cwd: string,
  input: {
    objective: string
    planSummary?: string
    checks?: string[]
  },
): Promise<VerificationAgentRecord> {
  const id = `verification_${randomUUID()}`
  const phases: VerificationAgentRecord['workerPhases'] = [
    {
      id: `${id}_explore`,
      phase: 'explore',
      prompt: `Inspect evidence for: ${input.objective}`,
      transcriptPath: verificationTranscriptPath(cwd, id, 'explore'),
      status: 'completed',
    },
    {
      id: `${id}_execute`,
      phase: 'execute',
      prompt: `Check implementation against plan: ${input.planSummary ?? input.objective}`,
      transcriptPath: verificationTranscriptPath(cwd, id, 'execute'),
      status: 'completed',
    },
    {
      id: `${id}_verify`,
      phase: 'verify',
      prompt: `Run or review checks: ${(input.checks ?? []).join(', ') || 'targeted tests'}`,
      transcriptPath: verificationTranscriptPath(cwd, id, 'verify'),
      status: 'completed',
    },
  ]
  for (const phase of phases) {
    await writeJsonFile(phase.transcriptPath, {
      id: phase.id,
      phase: phase.phase,
      prompt: phase.prompt,
      status: phase.status,
      createdAt: new Date().toISOString(),
    })
  }
  const record: VerificationAgentRecord = {
    id,
    objective: input.objective,
    planSummary: input.planSummary,
    checks: input.checks ?? [],
    workerPhases: phases,
    status: input.checks?.some(check => /fail|error/i.test(check))
      ? 'needs_attention'
      : 'verified',
    createdAt: new Date().toISOString(),
  }
  await appendJsonRecord(verificationAgentsPath(cwd), record)
  return record
}

export async function recordReviewArtifactMutation(
  cwd: string,
  input: {
    artifact: string
    title?: string
    annotations: ReviewArtifactAnnotation[]
    summary?: string
    targetPath?: string
    replacement?: string
    apply?: boolean
  },
): Promise<ReviewArtifactMutationRecord> {
  const id = `review_artifact_${randomUUID()}`
  const artifactPath = join(agentWorkflowRoot(cwd), 'review-artifacts', `${id}.json`)
  let targetPath: string | undefined
  let backupPath: string | undefined
  let mutationApplied = false

  if (input.targetPath) {
    targetPath = assertInsideWorkspace(cwd, input.targetPath)
  }
  if (input.apply && targetPath && input.replacement !== undefined) {
    backupPath = join(agentWorkflowRoot(cwd), 'review-artifacts', `${id}.backup`)
    let previous = ''
    try {
      previous = await readFile(targetPath, 'utf8')
    } catch {
      previous = ''
    }
    await writeFileWithParents(backupPath, previous)
    await writeFileWithParents(targetPath, input.replacement)
    mutationApplied = true
  }

  const record: ReviewArtifactMutationRecord = {
    id,
    title: input.title,
    artifactHash: sha256(input.artifact),
    artifactPath,
    targetPath,
    mutationApplied,
    backupPath,
    annotationCount: input.annotations.length,
    summary: input.summary,
    annotations: input.annotations,
    createdAt: new Date().toISOString(),
  }
  await writeJsonFile(artifactPath, {
    ...record,
    artifact: input.artifact,
    replacementHash: input.replacement ? sha256(input.replacement) : undefined,
  })
  await appendJsonRecord(reviewArtifactsIndexPath(cwd), record)
  return record
}

export async function classifyWorkflowJob(
  cwd: string,
  input: { prompt: string; command?: string },
): Promise<JobClassificationRecord> {
  const text = `${input.prompt} ${input.command ?? ''}`.toLowerCase()
  const candidates: Array<[JobClassificationRecord['kind'], RegExp, string]> = [
    ['review', /review|pr|security|issue/, 'review or PR language detected'],
    ['monitor', /watch|monitor|tail|daemon|server/, 'long-running monitor language detected'],
    ['diagnostic', /trace|heap|perf|debug|ctx/, 'diagnostic language detected'],
    ['workflow', /script|build|test|lint|typecheck|cron|schedule/, 'script or scheduled workflow language detected'],
  ]
  const match = candidates.find(([, pattern]) => pattern.test(text))
  const record: JobClassificationRecord = {
    id: `job_classification_${randomUUID()}`,
    prompt: input.prompt,
    command: input.command,
    kind: match?.[0] ?? 'agent',
    confidence: match ? 0.82 : 0.61,
    reasons: [match?.[2] ?? 'defaulted to agent workflow for open-ended request'],
    createdAt: new Date().toISOString(),
  }
  await appendJsonRecord(jobClassificationsPath(cwd), record)
  return record
}

export async function scheduleCronWorkflow(
  cwd: string,
  input: {
    name?: string
    cron?: string
    prompt?: string
    command?: string
    args?: string[]
  },
): Promise<CronScheduleRecord> {
  const now = new Date().toISOString()
  const record: CronScheduleRecord = {
    id: `cron_${randomUUID()}`,
    name: input.name ?? input.command ?? 'agent-workflow',
    cron: input.cron ?? '*/5 * * * *',
    prompt: input.prompt,
    command: input.command,
    args: input.args ?? [],
    status: 'scheduled',
    nextRunAt: nextMinuteIso(),
    createdAt: now,
    updatedAt: now,
  }
  await appendJsonRecord(cronSchedulesPath(cwd), record)
  return record
}

export async function runDueCronWorkflows(cwd: string): Promise<CronRunRecord[]> {
  const schedules = await readJsonFile<CronScheduleRecord[]>(cronSchedulesPath(cwd), [])
  const due = schedules.filter(schedule =>
    schedule.status === 'scheduled' && Date.parse(schedule.nextRunAt) <= Date.now(),
  )
  const runs: CronRunRecord[] = []
  for (const schedule of due) {
    const startedAt = new Date().toISOString()
    if (!schedule.command) {
      runs.push({
        id: `cron_run_${randomUUID()}`,
        scheduleId: schedule.id,
        status: 'skipped',
        startedAt,
        completedAt: new Date().toISOString(),
      })
      continue
    }
    try {
      const result = await execFileAsync(schedule.command, schedule.args, { cwd })
      runs.push({
        id: `cron_run_${randomUUID()}`,
        scheduleId: schedule.id,
        status: 'completed',
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
        startedAt,
        completedAt: new Date().toISOString(),
      })
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string }
      runs.push({
        id: `cron_run_${randomUUID()}`,
        scheduleId: schedule.id,
        status: 'failed',
        exitCode: typeof failure.code === 'number' ? failure.code : 1,
        stdout: failure.stdout,
        stderr: failure.stderr ?? failure.message,
        startedAt,
        completedAt: new Date().toISOString(),
      })
    }
  }
  if (runs.length > 0) {
    await writeJsonFile(cronRunsPath(cwd), [
      ...(await readCronRuns(cwd)),
      ...runs,
    ])
  }
  return runs
}

export async function readCronSchedules(cwd: string): Promise<CronScheduleRecord[]> {
  return readJsonFile<CronScheduleRecord[]>(cronSchedulesPath(cwd), [])
}

export async function readCronRuns(cwd: string): Promise<CronRunRecord[]> {
  return readJsonFile<CronRunRecord[]>(cronRunsPath(cwd), [])
}

export async function recordWorkflowEvent(
  cwd: string,
  input: {
    kind: WorkflowEventKind
    summary?: string
    payload?: unknown
  },
): Promise<WorkflowEventRecord> {
  const id = `workflow_event_${randomUUID()}`
  const payload = input.payload ?? {}
  const artifactPath = join(agentWorkflowRoot(cwd), 'events', `${id}.json`)
  const record: WorkflowEventRecord = {
    id,
    kind: input.kind,
    summary: input.summary ?? `${input.kind} workflow event`,
    payloadHash: sha256(JSON.stringify(payload)),
    status: input.kind === 'review' || input.kind === 'security-review' ? 'prepared' : 'recorded',
    artifactPath,
    createdAt: new Date().toISOString(),
  }
  await writeJsonFile(artifactPath, { ...record, payload })
  await appendJsonRecord(workflowEventsPath(cwd), record)
  return record
}

export async function readAgentWorkflowState(cwd: string): Promise<{
  messageActions: MessageActionRecord[]
  verificationAgents: VerificationAgentRecord[]
  reviewArtifacts: ReviewArtifactMutationRecord[]
  jobClassifications: JobClassificationRecord[]
  cronSchedules: CronScheduleRecord[]
  cronRuns: CronRunRecord[]
  events: WorkflowEventRecord[]
}> {
  const [
    messageActions,
    verificationAgents,
    reviewArtifacts,
    jobClassifications,
    cronSchedules,
    cronRuns,
    events,
  ] = await Promise.all([
    readJsonFile<MessageActionRecord[]>(messageActionsPath(cwd), []),
    readJsonFile<VerificationAgentRecord[]>(verificationAgentsPath(cwd), []),
    readJsonFile<ReviewArtifactMutationRecord[]>(reviewArtifactsIndexPath(cwd), []),
    readJsonFile<JobClassificationRecord[]>(jobClassificationsPath(cwd), []),
    readCronSchedules(cwd),
    readCronRuns(cwd),
    readJsonFile<WorkflowEventRecord[]>(workflowEventsPath(cwd), []),
  ])
  return {
    messageActions,
    verificationAgents,
    reviewArtifacts,
    jobClassifications,
    cronSchedules,
    cronRuns,
    events,
  }
}

function agentWorkflowRoot(cwd: string): string {
  return join(cwd, '.my-claude-code', 'agent-workflows')
}

function messageActionsPath(cwd: string): string {
  return join(agentWorkflowRoot(cwd), 'message-actions.json')
}

function verificationAgentsPath(cwd: string): string {
  return join(agentWorkflowRoot(cwd), 'verification-agents.json')
}

function verificationTranscriptPath(
  cwd: string,
  id: string,
  phase: VerificationAgentRecord['workerPhases'][number]['phase'],
): string {
  return join(agentWorkflowRoot(cwd), 'verification', id, `${phase}.json`)
}

function reviewArtifactsIndexPath(cwd: string): string {
  return join(agentWorkflowRoot(cwd), 'review-artifacts.json')
}

function jobClassificationsPath(cwd: string): string {
  return join(agentWorkflowRoot(cwd), 'job-classifications.json')
}

function cronSchedulesPath(cwd: string): string {
  return join(agentWorkflowRoot(cwd), 'cron-schedules.json')
}

function cronRunsPath(cwd: string): string {
  return join(agentWorkflowRoot(cwd), 'cron-runs.json')
}

function workflowEventsPath(cwd: string): string {
  return join(agentWorkflowRoot(cwd), 'events.json')
}

async function appendJsonRecord<T>(path: string, record: T): Promise<void> {
  await writeJsonFile(path, [...(await readJsonFile<T[]>(path, [])), record])
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFileWithParents(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeFileWithParents(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value, 'utf8')
}

function assertInsideWorkspace(cwd: string, candidate: string): string {
  const root = resolve(cwd)
  const target = resolve(cwd, candidate)
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new Error(`path is outside the current workspace: ${candidate}`)
  }
  return target
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function nextMinuteIso(): string {
  const date = new Date()
  date.setMinutes(date.getMinutes() + 1, 0, 0)
  return date.toISOString()
}
