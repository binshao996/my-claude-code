import { z } from 'zod/v4'
import { getBuiltinTools as getRuntimeBuiltinTools } from '@my-claude-code/tools'
import type { ProviderTool } from '@my-claude-code/model-provider'
import type { Tool, ToolExecutionContext, ToolInput, PermissionCheck } from '@my-claude-code/tools'

export type BuiltinToolModuleMirror = {
  moduleName: string
  upstreamPath: string
  toolNames: string[]
  tools: Tool[]
  tool: Tool
  providerTools: ProviderTool[]
  metadata: Array<{
    name: string
    readOnly: boolean
    destructive: boolean
    concurrencySafe: boolean
    permissionDecision: PermissionCheck['decision']
    schemaRequired: string[]
    runtime: 'local-runtime' | 'gated-upstream-surface'
  }>
}

const emptyInputSchema = z.object({}).catchall(z.unknown()) as z.ZodType<ToolInput>

export function createToolModuleMirror(args: {
  moduleName: string
  toolNames: string[]
  upstreamPath?: string
}): BuiltinToolModuleMirror {
  const runtimeTools = new Map(getRuntimeBuiltinTools().map(tool => [tool.name, tool]))
  const tools = args.toolNames.map(name => runtimeTools.get(name) ?? createGatedTool(name, args.moduleName))
  return {
    moduleName: args.moduleName,
    upstreamPath: args.upstreamPath ?? `claude-code/packages/builtin-tools/src/tools/${args.moduleName}`,
    toolNames: args.toolNames,
    tools,
    tool: tools[0],
    providerTools: tools.map(toProviderTool),
    metadata: tools.map(tool => buildToolMetadata(tool)),
  }
}

export function toProviderTool(tool: Tool): ProviderTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputJSONSchema,
  }
}

function buildToolMetadata(tool: Tool): BuiltinToolModuleMirror['metadata'][number] {
  const sampleInput = {}
  const permissionDecision: PermissionCheck['decision'] = tool.description.includes('gated upstream')
    ? 'deny'
    : safeToolBoolean(() => tool.isDestructive(sampleInput), false)
      ? 'ask'
      : 'allow'
  return {
    name: tool.name,
    readOnly: safeToolBoolean(() => tool.isReadOnly(sampleInput), false),
    destructive: safeToolBoolean(() => tool.isDestructive(sampleInput), false),
    concurrencySafe: safeToolBoolean(() => tool.isConcurrencySafe(sampleInput), false),
    permissionDecision,
    schemaRequired: tool.inputJSONSchema.required ?? [],
    runtime: tool.description.includes('gated upstream') ? 'gated-upstream-surface' : 'local-runtime',
  }
}

function safeToolBoolean(read: () => boolean, fallback: boolean): boolean {
  try {
    return read()
  } catch {
    return fallback
  }
}

function createGatedTool(name: string, moduleName: string): Tool {
  return {
    name,
    description: `R1.4 mirror for upstream ${moduleName}; runtime is provided by extension/MCP discovery and is gated until a concrete deferred tool is available.`,
    inputSchema: emptyInputSchema,
    inputJSONSchema: {
      type: 'object',
      properties: {},
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    checkPermissions() {
      return {
        decision: 'deny',
        reason: `${name} requires a concrete deferred runtime from ${moduleName}.`,
      }
    },
    async execute(_input: ToolInput, context: ToolExecutionContext) {
      return JSON.stringify({
        tool: name,
        moduleName,
        status: 'gated-upstream-surface',
        cwd: context.cwd,
        reason: 'No concrete deferred tool instance was supplied to this builtin tool mirror.',
      }, null, 2)
    },
  }
}
