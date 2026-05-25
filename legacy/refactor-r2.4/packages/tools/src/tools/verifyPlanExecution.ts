import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const VerifyPlanExecutionInputSchema = z.object({
  plan_summary: z.string().min(1),
  verification_notes: z.string().optional(),
  all_steps_completed: z.boolean(),
})

type VerifyPlanExecutionInput = z.infer<typeof VerifyPlanExecutionInputSchema>

type PlanVerificationRecord = {
  id: string
  verified: boolean
  plan_summary: string
  verification_notes?: string
  createdAt: string
}

export const verifyPlanExecutionTool: Tool<VerifyPlanExecutionInput> = {
  name: 'VerifyPlanExecution',
  description: 'Verify that an executed plan completed successfully and record the verification result.',
  inputSchema: VerifyPlanExecutionInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      plan_summary: {
        type: 'string',
        description: 'Summary of the plan that was executed.',
      },
      verification_notes: {
        type: 'string',
        description: 'Notes about tests, checks, skipped work, or failures.',
      },
      all_steps_completed: {
        type: 'boolean',
        description: 'Whether every planned step was completed successfully.',
      },
    },
    required: ['plan_summary', 'all_steps_completed'],
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions() {
    return { decision: 'allow' }
  },
  async execute(input, context) {
    const record: PlanVerificationRecord = {
      id: randomUUID(),
      verified: input.all_steps_completed,
      plan_summary: input.plan_summary,
      verification_notes: input.verification_notes,
      createdAt: new Date().toISOString(),
    }
    const records = await readVerificationRecords(context.cwd)
    records.push(record)
    await writeVerificationRecords(context.cwd, records)

    return JSON.stringify({
      verified: record.verified,
      summary: record.plan_summary,
      verification_notes: record.verification_notes,
      recordId: record.id,
    })
  },
}

async function readVerificationRecords(cwd: string): Promise<PlanVerificationRecord[]> {
  try {
    return JSON.parse(await readFile(verificationPath(cwd), 'utf8')) as PlanVerificationRecord[]
  } catch {
    return []
  }
}

async function writeVerificationRecords(
  cwd: string,
  records: PlanVerificationRecord[],
): Promise<void> {
  const path = verificationPath(cwd)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
}

function verificationPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'verification', 'plans.json')
}
