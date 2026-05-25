import type {
  ToolExecutionEvent,
  ToolUseBlock,
} from '@my-claude-code/core'
import { resolvePermission } from './permissions.js'
import type {
  Tool,
  ToolExecutionContext,
  ToolInput,
  ToolResult,
} from './types.js'
import { toolExecutionResultEvent } from './types.js'

export async function* runToolUses(options: {
  toolUses: ToolUseBlock[]
  tools: Tool[]
  context: ToolExecutionContext
}): AsyncGenerator<ToolExecutionEvent, ToolResult[]> {
  return yield* runTools(options)
}

export async function* runTools(options: {
  toolUses: ToolUseBlock[]
  tools: Tool[]
  context: ToolExecutionContext
}): AsyncGenerator<ToolExecutionEvent, ToolResult[]> {
  const results: ToolResult[] = []
  const batches = partitionToolUses(options.toolUses, options.tools)

  for (const batch of batches) {
    for (const toolUse of batch.toolUses) {
      yield {
        type: 'tool_execution_start',
        tool_use_id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
      }
    }

    const batchResults = batch.concurrent
      ? await Promise.all(
          batch.toolUses.map(toolUse =>
            runToolUse(toolUse, options.tools, options.context),
          ),
        )
      : await runSequentially(batch.toolUses, options.tools, options.context)

    for (const result of batchResults) {
      results.push(result)
      yield toolExecutionResultEvent(result)
    }
  }

  return results
}

export async function runToolUse(
  toolUse: ToolUseBlock,
  tools: Tool[],
  context: ToolExecutionContext,
): Promise<ToolResult> {
  const tool = tools.find(candidate => candidate.name === toolUse.name)

  if (!tool) {
    return errorResult(
      toolUse,
      `unknown tool: ${toolUse.name}`,
    )
  }

  const parsed = tool.inputSchema.safeParse(toolUse.input)
  if (!parsed.success) {
    return errorResult(
      toolUse,
      `invalid input for ${tool.name}: ${parsed.error.message}`,
    )
  }

  try {
    const permission = await resolvePermission(
      tool,
      parsed.data as ToolInput,
      context,
      toolUse.id,
    )
    if (permission.decision !== 'allow') {
      return errorResult(
        toolUse,
        permission.reason ?? `${tool.name} was not allowed`,
        permission.decision,
      )
    }

    await recordFileSnapshotBeforeMutation(tool, toolUse, parsed.data as ToolInput, context)
    const content = await tool.execute(parsed.data as ToolInput, context)
    return runPostToolUseHooks(tool, toolUse, parsed.data as ToolInput, context, {
      tool_use_id: toolUse.id,
      name: tool.name,
      content,
    })
  } catch (error) {
    return errorResult(
      toolUse,
      error instanceof Error ? error.message : String(error),
    )
  }
}

async function runSequentially(
  toolUses: ToolUseBlock[],
  tools: Tool[],
  context: ToolExecutionContext,
): Promise<ToolResult[]> {
  const results: ToolResult[] = []

  for (const toolUse of toolUses) {
    results.push(await runToolUse(toolUse, tools, context))
  }

  return results
}

function partitionToolUses(
  toolUses: ToolUseBlock[],
  tools: Tool[],
): Array<{ concurrent: boolean; toolUses: ToolUseBlock[] }> {
  const batches: Array<{ concurrent: boolean; toolUses: ToolUseBlock[] }> = []

  for (const toolUse of toolUses) {
    const concurrent = isConcurrencySafeToolUse(toolUse, tools)
    const previous = batches.at(-1)

    if (previous?.concurrent && concurrent) {
      previous.toolUses.push(toolUse)
      continue
    }

    batches.push({
      concurrent,
      toolUses: [toolUse],
    })
  }

  return batches
}

function isConcurrencySafeToolUse(toolUse: ToolUseBlock, tools: Tool[]): boolean {
  const tool = tools.find(candidate => candidate.name === toolUse.name)
  if (!tool) {
    return false
  }

  const parsed = tool.inputSchema.safeParse(toolUse.input)
  return parsed.success && tool.isConcurrencySafe(parsed.data as ToolInput)
}

async function runPostToolUseHooks(
  tool: Tool,
  toolUse: ToolUseBlock,
  input: ToolInput,
  context: ToolExecutionContext,
  result: ToolResult,
): Promise<ToolResult> {
  let next = result

  for (const hook of context.postToolUseHooks ?? []) {
    next =
      (await hook({
        tool,
        toolUse,
        input,
        result: next,
        context,
      })) ?? next
  }

  return next
}

function errorResult(
  toolUse: ToolUseBlock,
  content: string,
  permissionDecision?: ToolResult['permission_decision'],
): ToolResult {
  return {
    tool_use_id: toolUse.id,
    name: toolUse.name,
    content,
    is_error: true,
    permission_decision: permissionDecision,
  }
}

async function recordFileSnapshotBeforeMutation(
  tool: Tool,
  toolUse: ToolUseBlock,
  input: ToolInput,
  context: ToolExecutionContext,
): Promise<void> {
  if (!context.fileSnapshotRecorder || !tool.isDestructive(input)) {
    return
  }

  const filePath = input.file_path
  if (typeof filePath !== 'string' || !filePath) {
    return
  }

  await context.fileSnapshotRecorder({
    tool,
    toolUse,
    input,
    context,
    filePath,
  })
}
