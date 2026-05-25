import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ContentBlock,
  Message,
  ToolResultBlock,
} from '@my-claude-code/core'
import { estimateTokens } from './context.js'

const DEFAULT_MAX_TOOL_RESULT_CHARS = 8_000
const DEFAULT_MAX_TOTAL_TOOL_RESULT_CHARS = 16_000
const DEFAULT_COMPACT_KEEP_MESSAGES = 8
export const DEFAULT_AUTO_COMPACT_THRESHOLD_TOKENS = 160_000

export type ToolResultBudgetOptions = {
  cwd: string
  sessionId?: string
  maxToolResultChars?: number
  maxTotalToolResultChars?: number
}

export type ToolResultBudgetStats = {
  persistedResults: number
  truncatedResults: number
  originalChars: number
  retainedChars: number
}

export type CompactOptions = {
  thresholdTokens?: number
  keepLastMessages?: number
}

export type CompactSummarizer = (request: {
  messages: Message[]
  fallbackSummary: string
}) => string | Promise<string>

export type CompactWithSummaryOptions = CompactOptions & {
  summarizer?: CompactSummarizer
}

export type CompactResult = {
  messages: Message[]
  compacted: boolean
  estimatedTokensBefore: number
  estimatedTokensAfter: number
  summary?: string
}

export async function applyAutoCompactWithSummary(
  messages: Message[],
  options: CompactWithSummaryOptions = {},
): Promise<CompactResult> {
  const result = applyAutoCompact(messages, options)
  if (!result.compacted || !options.summarizer) {
    return result
  }

  const keepLastMessages = Math.max(
    1,
    Math.floor(options.keepLastMessages ?? DEFAULT_COMPACT_KEEP_MESSAGES),
  )
  const compactedSource = messages.slice(
    0,
    Math.max(0, messages.length - keepLastMessages),
  )
  const summary = await options.summarizer({
    messages: compactedSource,
    fallbackSummary: result.summary ?? '',
  })
  const compactedMessages = [
    compactBoundaryMessage(compactedSource.length, summary),
    ...result.messages.slice(1),
  ]

  return {
    ...result,
    messages: compactedMessages,
    summary,
    estimatedTokensAfter: estimateTokens(renderMessages(compactedMessages)),
  }
}

export async function applyToolResultBudget(
  messages: Message[],
  options: ToolResultBudgetOptions,
): Promise<{ messages: Message[]; stats: ToolResultBudgetStats }> {
  const maxToolResultChars =
    options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS
  const maxTotalToolResultChars =
    options.maxTotalToolResultChars ?? DEFAULT_MAX_TOTAL_TOOL_RESULT_CHARS
  const stats: ToolResultBudgetStats = {
    persistedResults: 0,
    truncatedResults: 0,
    originalChars: 0,
    retainedChars: 0,
  }
  let retainedBudget = maxTotalToolResultChars

  const nextMessages: Message[] = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      nextMessages.push(message)
      continue
    }

    const content: ContentBlock[] = []
    for (const block of message.content) {
      if (block.type !== 'tool_result') {
        content.push(block)
        continue
      }

      const originalText = toolResultText(block)
      stats.originalChars += originalText.length
      const perResultLimit = Math.min(maxToolResultChars, retainedBudget)
      if (originalText.length <= perResultLimit) {
        content.push(block)
        retainedBudget -= originalText.length
        stats.retainedChars += originalText.length
        continue
      }

      const reference = await persistToolResult(options, block, originalText)
      const retainedText = [
        originalText.slice(0, Math.max(0, perResultLimit)),
        `[tool result truncated: ${originalText.length} chars persisted at ${reference}]`,
      ].filter(Boolean).join('\n')
      content.push({
        ...block,
        content: retainedText,
      })
      retainedBudget = Math.max(0, retainedBudget - retainedText.length)
      stats.persistedResults += 1
      stats.truncatedResults += 1
      stats.retainedChars += retainedText.length
    }

    nextMessages.push({
      ...message,
      content,
    })
  }

  return {
    messages: nextMessages,
    stats,
  }
}

export function applyAutoCompact(
  messages: Message[],
  options: CompactOptions = {},
): CompactResult {
  const estimatedTokensBefore = estimateTokens(renderMessages(messages))
  const thresholdTokens =
    options.thresholdTokens ?? DEFAULT_AUTO_COMPACT_THRESHOLD_TOKENS
  if (!thresholdTokens || estimatedTokensBefore <= thresholdTokens) {
    return {
      messages,
      compacted: false,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
    }
  }

  const keepLastMessages = Math.max(
    1,
    Math.floor(options.keepLastMessages ?? DEFAULT_COMPACT_KEEP_MESSAGES),
  )
  const preserved = messages.slice(-keepLastMessages)
  const compacted = messages.slice(0, Math.max(0, messages.length - keepLastMessages))
  const summary = summarizeMessages(compacted)
  const compactedMessages: Message[] = [
    compactBoundaryMessage(compacted.length, summary),
    ...preserved,
  ]
  const estimatedTokensAfter = estimateTokens(renderMessages(compactedMessages))

  return {
    messages: compactedMessages,
    compacted: true,
    estimatedTokensBefore,
    estimatedTokensAfter,
    summary,
  }
}

function compactBoundaryMessage(compactedCount: number, summary: string): Message {
  return {
    role: 'system',
    content: [
      'compact_boundary',
      `compactedMessages: ${compactedCount}`,
      summary ? `summary:\n${summary}` : undefined,
    ].filter(Boolean).join('\n'),
  }
}

function toolResultText(block: ToolResultBlock): string {
  if (typeof block.content === 'string') {
    return block.content
  }
  return (block.content ?? []).map(item => item.text).join('\n')
}

async function persistToolResult(
  options: ToolResultBudgetOptions,
  block: ToolResultBlock,
  content: string,
): Promise<string> {
  const digest = createHash('sha256')
    .update(block.tool_use_id)
    .update('\0')
    .update(content)
    .digest('hex')
    .slice(0, 16)
  const directory = join(options.cwd, '.my-claude-code', 'tool-results')
  const filename = `${options.sessionId ?? 'session'}-${block.tool_use_id}-${digest}.txt`
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, filename), content, 'utf8')
  return join('.my-claude-code', 'tool-results', filename)
}

function summarizeMessages(messages: Message[]): string {
  const rendered = renderMessages(messages)
  if (!rendered) {
    return ''
  }
  return rendered.length <= 2_000
    ? rendered
    : `${rendered.slice(0, 2_000)}\n[summary truncated: compacted context exceeded 2000 chars]`
}

function renderMessages(messages: Message[]): string {
  return messages.map(message => `${message.role}: ${renderContent(message.content)}`).join('\n\n')
}

function renderContent(content: Message['content']): string {
  if (typeof content === 'string') {
    return content
  }
  return content.map(block => {
    if (block.type === 'text') {
      return block.text
    }
    if (block.type === 'thinking') {
      return block.thinking
    }
    if (block.type === 'tool_use') {
      return `tool_use ${block.name} ${JSON.stringify(block.input)}`
    }
    if (block.type === 'image') {
      return `[image:${block.source.media_type};base64:${block.source.data.length} chars]`
    }
    return `tool_result ${block.tool_use_id} ${toolResultText(block)}`
  }).join('\n')
}
