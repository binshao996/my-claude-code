import { z } from 'zod/v4'
import { recordReviewArtifactMutation } from '../services/agentWorkflows.js'
import type { Tool } from '../types.js'

const ReviewArtifactInputSchema = z.object({
  artifact: z.string().min(1),
  title: z.string().optional(),
  annotations: z.array(z.object({
    line: z.number().int().positive().optional(),
    message: z.string().min(1),
    severity: z.enum(['info', 'warning', 'error', 'suggestion']).optional(),
  })),
  summary: z.string().optional(),
})

type ReviewArtifactInput = z.infer<typeof ReviewArtifactInputSchema>

export const reviewArtifactTool: Tool<ReviewArtifactInput> = {
  name: 'ReviewArtifact',
  description: 'Review an artifact with inline annotations and a summary.',
  inputSchema: ReviewArtifactInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      artifact: { type: 'string', description: 'Artifact content to review.' },
      title: { type: 'string', description: 'Optional artifact title or path.' },
      annotations: {
        type: 'array',
        description: 'Inline annotations for the artifact.',
        items: {
          type: 'object',
          properties: {
            line: { type: 'number', description: '1-based line number.' },
            message: { type: 'string', description: 'Annotation text.' },
            severity: {
              type: 'string',
              enum: ['info', 'warning', 'error', 'suggestion'],
              description: 'Annotation severity.',
            },
          },
          required: ['message'],
        },
      },
      summary: { type: 'string', description: 'Overall review summary.' },
    },
    required: ['artifact', 'annotations'],
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions() {
    return { decision: 'allow' }
  },
  async execute(input, context) {
    const lineCount = input.artifact.split(/\r?\n/).length
    const annotations = input.annotations
      .map(annotation => ({
        severity: annotation.severity ?? 'info',
        line: annotation.line,
        message: annotation.message,
        outOfRange: annotation.line ? annotation.line > lineCount : false,
      }))
      .sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER))
    const record = await recordReviewArtifactMutation(context.cwd, {
      artifact: input.artifact,
      title: input.title,
      annotations,
      summary: input.summary,
    })

    return JSON.stringify({
      recordId: record.id,
      title: input.title,
      annotationCount: annotations.length,
      summary: input.summary,
      lineCount,
      annotations,
      artifact: input.artifact,
    })
  },
}
