import { z } from 'zod/v4'
import type {
  PermissionCheck,
  PermissionMode,
  Tool,
  ToolExecutionContext,
  ToolInput,
} from './types.js'

export const PermissionModeSchema = z
  .enum(['default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk'])
  .default('default')

export function parsePermissionMode(value: string | undefined): PermissionMode {
  return PermissionModeSchema.catch('default').parse(value)
}

export async function resolvePermission<TInput extends ToolInput>(
  tool: Tool<TInput>,
  input: TInput,
  context: ToolExecutionContext,
  toolUseId = 'hook-preview',
): Promise<PermissionCheck> {
  const ruleDecision = resolveRuleDecision(tool.name, input, context)
  if (ruleDecision?.decision === 'deny') {
    return ruleDecision
  }

  const toolDecision = await tool.checkPermissions(input, context)
  if (toolDecision.decision === 'deny') {
    return toolDecision
  }

  const hookDecision = await runPreToolUseHooks(tool, input, context, toolUseId)
  if (hookDecision) {
    return hookDecision
  }

  if (ruleDecision) {
    return ruleDecision
  }

  return applyPermissionMode(tool, input, context, toolDecision)
}

async function runPreToolUseHooks<TInput extends ToolInput>(
  tool: Tool<TInput>,
  input: TInput,
  context: ToolExecutionContext,
  toolUseId: string,
): Promise<PermissionCheck | undefined> {
  for (const hook of context.preToolUseHooks ?? []) {
    const decision = await hook({
      tool,
      toolUse: {
        type: 'tool_use',
        id: toolUseId,
        name: tool.name,
        input,
      },
      input,
      context,
    })

    if (decision) {
      return decision
    }
  }

  return undefined
}

async function applyPermissionMode<TInput extends ToolInput>(
  tool: Tool<TInput>,
  input: TInput,
  context: ToolExecutionContext,
  toolDecision: PermissionCheck,
): Promise<PermissionCheck> {
  if (toolDecision.decision === 'deny') {
    return toolDecision
  }

  if (context.permissionMode === 'bypassPermissions') {
    return { decision: 'allow' }
  }

  if (context.permissionMode === 'plan' && !tool.isReadOnly(input)) {
    return {
      decision: 'deny',
      reason: `plan mode blocks non-read-only tool ${tool.name}`,
    }
  }

  if (
    context.permissionMode === 'acceptEdits' &&
    (tool.name === 'Edit' || tool.name === 'Write')
  ) {
    return { decision: 'allow' }
  }

  if (toolDecision.decision === 'ask') {
    const promptedDecision = await context.permissionPrompt?.({
      tool,
      input,
      reason: toolDecision.reason,
      context,
    })
    if (promptedDecision) {
      return promptedDecision
    }

    return {
      decision: 'deny',
      reason:
        toolDecision.reason ??
        `${tool.name} requires permission, but headless mode cannot ask yet`,
    }
  }

  return toolDecision
}

function resolveRuleDecision<TInput extends ToolInput>(
  toolName: string,
  input: TInput,
  context: ToolExecutionContext,
): PermissionCheck | undefined {
  if (context.disallowedTools?.some(rule => matchesToolRule(toolName, input, rule))) {
    return {
      decision: 'deny',
      reason: `${toolName} is disallowed by permission rules`,
    }
  }

  if (context.allowedTools?.some(rule => matchesToolRule(toolName, input, rule))) {
    return { decision: 'allow' }
  }

  if (context.allowedTools?.some(rule => !isPatternToolRule(rule))) {
    return {
      decision: 'deny',
      reason: `${toolName} is not in allowedTools`,
    }
  }

  return undefined
}

export function matchesToolRule<TInput extends ToolInput>(
  toolName: string,
  input: TInput,
  rule: string,
): boolean {
  const parsed = parseToolRule(rule)
  if (!matchesToolName(toolName, parsed.toolName)) {
    return false
  }

  if (!parsed.pattern) {
    return true
  }

  return inputText(input).includes(parsed.pattern)
}

export function matchesToolNameRule(toolName: string, rule: string): boolean {
  return matchesToolName(toolName, parseToolRule(rule).toolName)
}

export function isPatternToolRule(rule: string): boolean {
  return parseToolRule(rule).pattern !== undefined
}

function parseToolRule(rule: string): { toolName: string; pattern?: string } {
  const match = /^(?<toolName>[^()]+)(?:\((?<pattern>.*)\))?$/.exec(rule.trim())
  return {
    toolName: match?.groups?.toolName?.trim() || rule.trim(),
    pattern: match?.groups?.pattern?.trim(),
  }
}

function matchesToolName(toolName: string, ruleName: string): boolean {
  if (ruleName === '*' || ruleName === toolName) {
    return true
  }

  if (isMcpServerRule(ruleName)) {
    return toolName.startsWith(`${ruleName}__`)
  }

  if (ruleName.endsWith('*')) {
    return toolName.startsWith(ruleName.slice(0, -1))
  }

  return false
}

function isMcpServerRule(ruleName: string): boolean {
  const parts = ruleName.split('__')
  return parts.length === 2 && parts[0] === 'mcp' && Boolean(parts[1])
}

function inputText(input: ToolInput): string {
  return Object.values(input)
    .map(value => (typeof value === 'string' ? value : JSON.stringify(value)))
    .join('\n')
}
