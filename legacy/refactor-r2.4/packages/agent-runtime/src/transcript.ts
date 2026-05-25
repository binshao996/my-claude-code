import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  type CompactMetadata,
  type QueryEvent,
  type TerminalEvent,
  type ToolExecutionEvent,
  TranscriptRecordSchema,
  type TranscriptRecord,
} from '@my-claude-code/core'

export type TranscriptEvent = QueryEvent | TerminalEvent | ToolExecutionEvent

export type AppendTranscriptOptions = {
  transcriptPath: string
  sessionId: string
  event: TranscriptEvent
  now?: Date
  compact?: CompactMetadata
  promptStateHash?: string
}

export function defaultTranscriptPath(cwd: string, sessionId: string): string {
  return join(cwd, '.my-claude-code', 'transcripts', `${sessionId}.jsonl`)
}

export async function appendTranscript(
  options: AppendTranscriptOptions,
): Promise<TranscriptRecord> {
  const record = TranscriptRecordSchema.parse({
    id: randomUUID(),
    session_id: options.sessionId,
    created_at: (options.now ?? new Date()).toISOString(),
    event: options.event,
    compact: options.compact,
    promptStateHash: options.promptStateHash,
  })

  await mkdir(dirname(options.transcriptPath), { recursive: true })
  await writeFile(
    options.transcriptPath,
    `${JSON.stringify(record)}\n`,
    {
      flag: 'a',
    },
  )

  return record
}

export async function readTranscript(
  transcriptPath: string,
): Promise<TranscriptRecord[]> {
  const content = await readFile(transcriptPath, 'utf8')

  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => TranscriptRecordSchema.parse(JSON.parse(line)))
}
