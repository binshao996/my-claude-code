import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const PREVIEW_BYTES = 2 * 1024
const FETCH_BYTES = 50 * 1024
const KEY_REGEX = /^[A-Za-z0-9._-]{1,128}$/
const STORE_REGEX = /^(?!\.)[^/\\:]{1,255}$/

const LocalMemoryRecallInputSchema = z.object({
  action: z.enum(['list_stores', 'list_entries', 'fetch']),
  store: z.string().regex(STORE_REGEX).optional(),
  key: z.string().regex(KEY_REGEX).optional(),
  preview_only: z.boolean().optional(),
})

type LocalMemoryRecallInput = z.infer<typeof LocalMemoryRecallInputSchema>

export const localMemoryRecallTool: Tool<LocalMemoryRecallInput> = {
  name: 'LocalMemoryRecall',
  description: 'Read local cross-session memory stores under .my-claude-code/local-memory.',
  inputSchema: LocalMemoryRecallInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list_stores', 'list_entries', 'fetch'] },
      store: { type: 'string' },
      key: { type: 'string' },
      preview_only: { type: 'boolean' },
    },
    required: ['action'],
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions(input) {
    const error = validateMemoryInput(input)
    if (error) {
      return { decision: 'deny', reason: error }
    }
    if (input.action === 'fetch' && input.preview_only === false) {
      return {
        decision: 'ask',
        reason: `Fetch full local memory ${input.store}/${input.key}`,
      }
    }
    return { decision: 'allow' }
  },
  execute: async (input, context) => {
    const error = validateMemoryInput(input)
    if (error) {
      return JSON.stringify({ action: input.action, error }, null, 2)
    }
    if (input.action === 'list_stores') {
      return JSON.stringify({
        action: input.action,
        stores: await listStores(context.cwd),
      }, null, 2)
    }
    if (input.action === 'list_entries') {
      return JSON.stringify({
        action: input.action,
        store: input.store,
        entries: await listEntries(context.cwd, input.store as string),
      }, null, 2)
    }

    const maxBytes = input.preview_only === false ? FETCH_BYTES : PREVIEW_BYTES
    const fetched = await fetchMemory(context.cwd, input.store as string, input.key as string, maxBytes)
    return JSON.stringify({
      action: input.action,
      store: input.store,
      key: input.key,
      value: fetched.value,
      preview_only: input.preview_only !== false,
      truncated: fetched.truncated,
    }, null, 2)
  },
}

function memoryRoot(cwd: string): string {
  return join(cwd, '.my-claude-code', 'local-memory')
}

function validateMemoryInput(input: LocalMemoryRecallInput): string | undefined {
  if (input.store?.includes('\0')) {
    return `Invalid store name '${input.store}'`
  }
  if (input.action !== 'list_stores' && !input.store) {
    return `Missing store for action ${input.action}`
  }
  if (input.action === 'fetch' && !input.key) {
    return 'Missing key for fetch'
  }
  return undefined
}

async function listStores(cwd: string): Promise<string[]> {
  try {
    const entries = await readdir(memoryRoot(cwd), { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

async function listEntries(cwd: string, store: string): Promise<string[]> {
  try {
    const entries = await readdir(join(memoryRoot(cwd), store), { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => basename(entry.name, '.md'))
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

async function fetchMemory(cwd: string, store: string, key: string, maxBytes: number): Promise<{
  value?: string
  truncated?: boolean
}> {
  const path = join(memoryRoot(cwd), store, `${key}.md`)
  try {
    const fileStat = await stat(path)
    if (!fileStat.isFile()) {
      return { value: undefined, truncated: false }
    }
    const content = await readFile(path, 'utf8')
    const wrapped = [
      `<user_local_memory store="${xmlEscape(store)}" key="${xmlEscape(key)}" untrusted="true">`,
      xmlEscape(content),
      '</user_local_memory>',
    ].join('\n')
    return truncateUtf8(wrapped, maxBytes)
  } catch {
    return { value: undefined, truncated: false }
  }
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) {
    return { value, truncated: false }
  }
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1
  }
  return { value: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
