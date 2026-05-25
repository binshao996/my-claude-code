import { z } from 'zod/v4'
import {
  classifyWorkflowJob,
  readAgentWorkflowState,
  readCronSchedules,
  recordMessageAction,
  recordReviewArtifactMutation,
  recordWorkflowEvent,
  runDueCronWorkflows,
  runVerificationAgent,
  scheduleCronWorkflow,
  type WorkflowEventKind,
} from '../services/agentWorkflows.js'
import type { Tool } from '../types.js'

const MessageActionInputSchema = z.object({
  message_id: z.string().min(1),
  action: z.enum(['copy', 'retry', 'edit', 'delete', 'pin', 'rate']),
  reason: z.string().optional(),
  replacement: z.string().optional(),
})

const VerificationAgentInputSchema = z.object({
  objective: z.string().min(1),
  plan_summary: z.string().optional(),
  checks: z.array(z.string().min(1)).optional(),
})

const ReviewArtifactMutationInputSchema = z.object({
  artifact: z.string().min(1),
  title: z.string().optional(),
  annotations: z.array(z.object({
    line: z.number().int().positive().optional(),
    message: z.string().min(1),
    severity: z.enum(['info', 'warning', 'error', 'suggestion']).optional(),
  })).default([]),
  summary: z.string().optional(),
  target_path: z.string().min(1).optional(),
  replacement: z.string().optional(),
  apply: z.boolean().optional(),
})

const JobClassifyInputSchema = z.object({
  prompt: z.string().min(1),
  command: z.string().optional(),
})

const ScheduleCronInputSchema = z.object({
  name: z.string().optional(),
  cron: z.string().optional(),
  prompt: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
})

const WorkflowEventInputSchema = z.object({
  kind: z.enum([
    'ant-trace',
    'bughunter',
    'ctx_viz',
    'debug-tool-call',
    'feedback',
    'good-claude',
    'heapdump',
    'issue',
    'perf-issue',
    'pr-comments',
    'release-notes',
    'review',
    'security-review',
    'share',
    'stickers',
    'tag',
    'thinkback',
    'thinkback-play',
  ]),
  summary: z.string().optional(),
  payload: z.unknown().optional(),
})

export const messageActionTool: Tool<z.infer<typeof MessageActionInputSchema>> = {
  name: 'MessageAction',
  description: 'Record a user-visible message action such as retry, edit, delete, pin, copy, or rating.',
  inputSchema: MessageActionInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      message_id: { type: 'string' },
      action: { type: 'string', enum: ['copy', 'retry', 'edit', 'delete', 'pin', 'rate'] },
      reason: { type: 'string' },
      replacement: { type: 'string' },
    },
    required: ['message_id', 'action'],
  },
  isReadOnly: () => false,
  isDestructive: input => input.action === 'delete' || input.action === 'edit',
  isConcurrencySafe: () => false,
  checkPermissions: (input, context) =>
    input.action === 'delete' && context.permissionMode !== 'bypassPermissions'
      ? { decision: 'ask', reason: 'MessageAction delete mutates local message action state' }
      : { decision: 'allow' },
  async execute(input, context) {
    return JSON.stringify(
      await recordMessageAction(context.cwd, {
        messageId: input.message_id,
        action: input.action,
        reason: input.reason,
        replacement: input.replacement,
      }),
      null,
      2,
    )
  },
}

export const verificationAgentTool: Tool<z.infer<typeof VerificationAgentInputSchema>> = {
  name: 'VerificationAgent',
  description: 'Run the local verification-agent workflow with explore, execute, and verify worker transcripts.',
  inputSchema: VerificationAgentInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      objective: { type: 'string' },
      plan_summary: { type: 'string' },
      checks: { type: 'array', items: { type: 'string' } },
    },
    required: ['objective'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(
      await runVerificationAgent(context.cwd, {
        objective: input.objective,
        planSummary: input.plan_summary,
        checks: input.checks,
      }),
      null,
      2,
    )
  },
}

export const reviewArtifactMutationTool: Tool<z.infer<typeof ReviewArtifactMutationInputSchema>> = {
  name: 'ReviewArtifactMutation',
  description: 'Persist review artifact annotations and optionally apply a replacement to a workspace file with a backup.',
  inputSchema: ReviewArtifactMutationInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      artifact: { type: 'string' },
      title: { type: 'string' },
      annotations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            line: { type: 'number' },
            message: { type: 'string' },
            severity: { type: 'string', enum: ['info', 'warning', 'error', 'suggestion'] },
          },
        },
      },
      summary: { type: 'string' },
      target_path: { type: 'string' },
      replacement: { type: 'string' },
      apply: { type: 'boolean' },
    },
    required: ['artifact'],
  },
  isReadOnly: input => !input.apply,
  isDestructive: input => Boolean(input.apply),
  isConcurrencySafe: input => !input.apply,
  checkPermissions: (input, context) =>
    input.apply && context.permissionMode !== 'bypassPermissions'
      ? { decision: 'ask', reason: 'ReviewArtifactMutation can rewrite a workspace file' }
      : { decision: 'allow' },
  async execute(input, context) {
    return JSON.stringify(
      await recordReviewArtifactMutation(context.cwd, {
        artifact: input.artifact,
        title: input.title,
        annotations: input.annotations.map(annotation => ({
          line: annotation.line,
          message: annotation.message,
          severity: annotation.severity ?? 'info',
        })),
        summary: input.summary,
        targetPath: input.target_path,
        replacement: input.replacement,
        apply: input.apply,
      }),
      null,
      2,
    )
  },
}

export const jobClassifyTool: Tool<z.infer<typeof JobClassifyInputSchema>> = {
  name: 'JobClassify',
  description: 'Classify a requested job into agent, workflow, monitor, review, or diagnostic execution.',
  inputSchema: JobClassifyInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      command: { type: 'string' },
    },
    required: ['prompt'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(await classifyWorkflowJob(context.cwd, input), null, 2)
  },
}

export const scheduleCronTool: Tool<z.infer<typeof ScheduleCronInputSchema>> = {
  name: 'ScheduleCron',
  description: 'Create a local cron-style workflow schedule for a prompt or command.',
  inputSchema: ScheduleCronInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      cron: { type: 'string' },
      prompt: { type: 'string' },
      command: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
    },
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: (_, context) =>
    context.permissionMode === 'bypassPermissions'
      ? { decision: 'allow' }
      : { decision: 'ask', reason: 'ScheduleCron can register a future local workflow command' },
  async execute(input, context) {
    return JSON.stringify(await scheduleCronWorkflow(context.cwd, input), null, 2)
  },
}

export const scheduleCronRunDueTool: Tool = {
  name: 'ScheduleCronRunDue',
  description: 'Run due local cron-style workflow schedules.',
  inputSchema: z.object({}),
  inputJSONSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: (_, context) =>
    context.permissionMode === 'bypassPermissions'
      ? { decision: 'allow' }
      : { decision: 'ask', reason: 'ScheduleCronRunDue can launch local scheduled commands' },
  async execute(_, context) {
    return JSON.stringify(await runDueCronWorkflows(context.cwd), null, 2)
  },
}

export const workflowEventTool: Tool<z.infer<typeof WorkflowEventInputSchema>> = {
  name: 'WorkflowEvent',
  description: 'Record a workflow/review/diagnostic event such as thinkback, bughunter, security-review, share, or release notes.',
  inputSchema: WorkflowEventInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string' },
      summary: { type: 'string' },
      payload: { type: 'object' },
    },
    required: ['kind'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  async execute(input, context) {
    return JSON.stringify(
      await recordWorkflowEvent(context.cwd, {
        kind: input.kind as WorkflowEventKind,
        summary: input.summary,
        payload: input.payload,
      }),
      null,
      2,
    )
  },
}

export const agentWorkflowStateTool: Tool = {
  name: 'AgentWorkflowState',
  description: 'Read local V2.0 agent workflow, review, automation, and diagnostic state.',
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
    return JSON.stringify(await readAgentWorkflowState(context.cwd), null, 2)
  },
}

export const scheduleCronListTool: Tool = {
  name: 'ScheduleCronList',
  description: 'List local cron-style workflow schedules.',
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
    return JSON.stringify(await readCronSchedules(context.cwd), null, 2)
  },
}
