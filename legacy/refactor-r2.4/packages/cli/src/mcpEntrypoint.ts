import { createInterface } from 'node:readline'
import {
  getBuiltinTools,
  runToolUse,
  toolsToProviderTools,
} from '@my-claude-code/tools'
import type { CliIO } from './program.js'

type JsonRpcRequest = {
  jsonrpc?: '2.0'
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

export async function startMcpEntrypoint(args: {
  cwd: string
  io?: CliIO
  input?: AsyncIterable<string>
}): Promise<void> {
  const io = args.io ?? {
    stdout: process.stdout,
    stderr: process.stderr,
  }
  const input = args.input ?? createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  })

  for await (const line of input) {
    if (!line.trim()) {
      continue
    }
    const response = await handleMcpMessage(line, args.cwd)
    if (response) {
      io.stdout.write(`${JSON.stringify(response)}\n`)
    }
  }
}

export async function handleMcpMessage(
  line: string,
  cwd: string,
): Promise<JsonRpcResponse | undefined> {
  let request: JsonRpcRequest
  try {
    request = JSON.parse(line) as JsonRpcRequest
  } catch {
    return errorResponse(null, -32700, 'Parse error')
  }

  if (request.id === undefined) {
    return undefined
  }

  try {
    switch (request.method) {
      case 'initialize':
        return resultResponse(request.id, {
          protocolVersion: '2024-11-05',
          serverInfo: {
            name: 'my-claude-code',
            version: '1.0.0',
          },
          capabilities: {
            tools: {},
          },
        })
      case 'tools/list':
        return resultResponse(request.id, {
          tools: toolsToProviderTools(getBuiltinTools()).map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.input_schema,
          })),
        })
      case 'tools/call':
        return resultResponse(request.id, await callMcpTool(request.params, cwd))
      default:
        return errorResponse(request.id, -32601, `Method not found: ${request.method}`)
    }
  } catch (error) {
    return errorResponse(
      request.id,
      -32603,
      error instanceof Error ? error.message : String(error),
    )
  }
}

async function callMcpTool(
  params: Record<string, unknown> | undefined,
  cwd: string,
) {
  const name = typeof params?.name === 'string' ? params.name : undefined
  if (!name) {
    throw new Error('tools/call requires params.name')
  }
  const input = params?.arguments && typeof params.arguments === 'object'
    ? params.arguments as Record<string, unknown>
    : {}
  const result = await runToolUse(
    {
      type: 'tool_use',
      id: `mcp_${Date.now()}`,
      name,
      input,
    },
    getBuiltinTools(),
    {
      cwd,
      permissionMode: 'default',
    },
  )

  return {
    isError: result.is_error ?? false,
    content: [
      {
        type: 'text',
        text: result.content,
      },
    ],
  }
}

function resultResponse(
  id: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result,
  }
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  }
}
