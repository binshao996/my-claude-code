import { z } from 'zod/v4'
import {
  extractMemories,
  rankMemoryStoreEntries,
  syncTeamMemory,
  writeAgentMemorySnapshot,
  writeSessionMemorySnapshot,
} from '../services/memory.js'
import type { Tool } from '../types.js'

const ExtractMemoriesInputSchema = z.object({
  text: z.string().min(1),
  store: z.string().min(1).optional(),
  source: z.enum(['text', 'transcript', 'session']).optional(),
})

const AgentMemorySnapshotInputSchema = z.object({
  agent_id: z.string().min(1),
  session_id: z.string().min(1).optional(),
  summary: z.string().min(1),
  memories: z.array(z.string().min(1)).optional(),
})

const SessionMemorySnapshotInputSchema = z.object({
  session_id: z.string().min(1),
  summary: z.string().min(1),
})

const TeamMemorySyncInputSchema = z.object({
  team_name: z.string().min(1).optional(),
})

const MemoryRankInputSchema = z.object({
  prompt: z.string().optional(),
  limit: z.number().int().min(1).max(20).optional(),
})

export const extractMemoriesTool: Tool<z.infer<typeof ExtractMemoriesInputSchema>> = {
  name: 'ExtractMemories',
  description: 'Extract durable local memories from transcript or text into ranked memory stores.',
  inputSchema: ExtractMemoriesInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      store: { type: 'string' },
      source: { type: 'string', enum: ['text', 'transcript', 'session'] },
    },
    required: ['text'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  execute: async (input, context) =>
    JSON.stringify({
      memories: await extractMemories(context.cwd, input),
    }, null, 2),
}

export const agentMemorySnapshotTool: Tool<z.infer<typeof AgentMemorySnapshotInputSchema>> = {
  name: 'AgentMemorySnapshot',
  description: 'Persist an agent-specific memory snapshot for later session context.',
  inputSchema: AgentMemorySnapshotInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string' },
      session_id: { type: 'string' },
      summary: { type: 'string' },
      memories: { type: 'array', items: { type: 'string' } },
    },
    required: ['agent_id', 'summary'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  execute: async (input, context) =>
    JSON.stringify(await writeAgentMemorySnapshot(context.cwd, {
      agentId: input.agent_id,
      sessionId: input.session_id,
      summary: input.summary,
      memories: input.memories,
    }), null, 2),
}

export const sessionMemorySnapshotTool: Tool<z.infer<typeof SessionMemorySnapshotInputSchema>> = {
  name: 'SessionMemorySnapshot',
  description: 'Persist compact session memory and cache-break diagnostics.',
  inputSchema: SessionMemorySnapshotInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string' },
      summary: { type: 'string' },
    },
    required: ['session_id', 'summary'],
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  execute: async (input, context) =>
    JSON.stringify(await writeSessionMemorySnapshot(context.cwd, {
      sessionId: input.session_id,
      summary: input.summary,
    }), null, 2),
}

export const teamMemorySyncTool: Tool<z.infer<typeof TeamMemorySyncInputSchema>> = {
  name: 'TeamMemorySync',
  description: 'Sync local team events into a team memory store.',
  inputSchema: TeamMemorySyncInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      team_name: { type: 'string' },
    },
  },
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: () => ({ decision: 'allow' }),
  execute: async (input, context) =>
    JSON.stringify(await syncTeamMemory(context.cwd, input.team_name), null, 2),
}

export const memoryRankTool: Tool<z.infer<typeof MemoryRankInputSchema>> = {
  name: 'MemoryRank',
  description: 'Rank local memory store entries for the current prompt and refresh the memory cache.',
  inputSchema: MemoryRankInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      limit: { type: 'number' },
    },
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ decision: 'allow' }),
  execute: async (input, context) =>
    JSON.stringify(await rankMemoryStoreEntries(context.cwd, input.prompt, input.limit), null, 2),
}
