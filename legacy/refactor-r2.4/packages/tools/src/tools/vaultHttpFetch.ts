import { z } from 'zod/v4'
import type { Tool, ToolExecutionContext } from '../types.js'

const RESPONSE_BODY_CAP_CHARS = 100_000

const VaultHttpFetchInputSchema = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  vault_auth_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  auth_scheme: z.enum(['bearer', 'basic', 'header_x_api_key', 'custom']).default('bearer'),
  auth_header_name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  body: z.string().max(RESPONSE_BODY_CAP_CHARS).optional(),
  body_content_type: z.string().max(128).optional(),
  reason: z.string().min(1).max(500),
})

type VaultHttpFetchInput = z.infer<typeof VaultHttpFetchInputSchema>
type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export function createVaultHttpFetchTool(options: {
  fetchImpl?: FetchLike
  getSecret?: (key: string) => string | undefined | Promise<string | undefined>
} = {}): Tool<VaultHttpFetchInput> {
  const fetchImpl = options.fetchImpl ?? fetch
  const getSecret = options.getSecret ?? getSecretFromEnvironment

  return {
    name: 'VaultHttpFetch',
    description: 'Make an authenticated HTTPS request using a vault-stored secret key name.',
    inputSchema: VaultHttpFetchInputSchema,
    inputJSONSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target HTTPS URL.' },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          description: 'HTTP method.',
        },
        vault_auth_key: {
          type: 'string',
          description: 'Vault key name, never the secret value.',
        },
        auth_scheme: {
          type: 'string',
          enum: ['bearer', 'basic', 'header_x_api_key', 'custom'],
          description: 'How to inject the secret into request headers.',
        },
        auth_header_name: {
          type: 'string',
          description: 'Header name when auth_scheme=custom.',
        },
        body: { type: 'string', description: 'Request body.' },
        body_content_type: { type: 'string', description: 'Request Content-Type.' },
        reason: {
          type: 'string',
          description: 'Why this authenticated request is needed.',
        },
      },
      required: ['url', 'vault_auth_key', 'reason'],
    },
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    checkPermissions(input, context) {
      const denied = vaultPermissionBlockReason(input, context)
      if (denied) {
        return { decision: 'deny', reason: denied }
      }
      if (isVaultAllowed(input, context)) {
        return { decision: 'allow' }
      }
      return {
        decision: 'ask',
        reason: `Allow VaultHttpFetch using key '${input.vault_auth_key}' to ${input.method} ${input.url}? Reason: ${input.reason}`,
      }
    },
    async execute(input, context) {
      const denied = vaultPermissionBlockReason(input, context)
      if (denied) {
        throw new Error(denied)
      }
      const secret = await getSecret(input.vault_auth_key)
      if (!secret) {
        return JSON.stringify({
          error: `Vault key '${input.vault_auth_key}' not found`,
        })
      }
      const secretForms = buildDerivedSecretForms(secret)
      const headers = buildAuthHeaders(input, secret)
      const response = await fetchImpl(input.url, {
        method: input.method,
        headers,
        body: input.body,
        redirect: 'manual',
        signal: context.signal,
      })
      const body = await response.text()
      return JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        responseHeaders: scrubResponseHeaders(response.headers, secretForms),
        body: truncate(scrubAllSecretForms(body, secretForms)),
      }, null, 2)
    },
  }
}

export const vaultHttpFetchTool = createVaultHttpFetchTool()

function vaultPermissionBlockReason(
  input: VaultHttpFetchInput,
  _context: ToolExecutionContext,
): string | undefined {
  const url = new URL(input.url)
  if (url.protocol !== 'https:') {
    return `Only https:// URLs are allowed (got: ${input.url})`
  }
  if (input.auth_scheme === 'custom' && !input.auth_header_name) {
    return 'auth_scheme=custom requires auth_header_name'
  }
  return undefined
}

function isVaultAllowed(input: VaultHttpFetchInput, context: ToolExecutionContext): boolean {
  const host = new URL(input.url).host.toLowerCase()
  const exactRule = `VaultHttpFetch(${input.vault_auth_key}@${host})`
  const wildcardRule = `VaultHttpFetch(${input.vault_auth_key}@*)`
  return context.allowedTools?.includes(exactRule) === true ||
    context.allowedTools?.includes(wildcardRule) === true
}

function buildAuthHeaders(input: VaultHttpFetchInput, secret: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'my-claude-code VaultHttpFetch',
  }
  switch (input.auth_scheme) {
    case 'bearer':
      headers.Authorization = `Bearer ${secret}`
      break
    case 'basic':
      headers.Authorization = `Basic ${Buffer.from(secret, 'utf8').toString('base64')}`
      break
    case 'header_x_api_key':
      headers['X-Api-Key'] = secret
      break
    case 'custom':
      if (!input.auth_header_name) {
        throw new Error('auth_scheme=custom requires auth_header_name')
      }
      headers[input.auth_header_name] = secret
      break
  }
  if (input.body !== undefined) {
    headers['Content-Type'] = input.body_content_type ?? 'application/json'
  }
  return headers
}

function getSecretFromEnvironment(key: string): string | undefined {
  const envName = `MY_CLAUDE_CODE_VAULT_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
  return process.env[envName]
}

export function buildDerivedSecretForms(secret: string): string[] {
  if (secret.length < 4) {
    return []
  }
  const base64 = Buffer.from(secret, 'utf8').toString('base64')
  return secret.length < 8
    ? [`Basic ${base64}`, `Bearer ${secret}`, secret]
    : [`Basic ${base64}`, `Bearer ${secret}`, base64, secret]
}

export function scrubAllSecretForms(value: string, forms: string[]): string {
  return forms.reduce((output, form) => output.split(form).join('[REDACTED]'), value)
}

function scrubResponseHeaders(headers: Headers, forms: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of headers.entries()) {
    if (isSensitiveHeader(key)) {
      result[key] = '[REDACTED]'
      continue
    }
    result[key] = scrubAllSecretForms(value, forms)
  }
  return result
}

function isSensitiveHeader(header: string): boolean {
  return [
    'authorization',
    'x-api-key',
    'cookie',
    'set-cookie',
    'proxy-authorization',
    'www-authenticate',
  ].includes(header.toLowerCase())
}

function truncate(value: string): string {
  if (value.length <= RESPONSE_BODY_CAP_CHARS) {
    return value
  }
  return `${value.slice(0, RESPONSE_BODY_CAP_CHARS)}\n[truncated: VaultHttpFetch output exceeded ${RESPONSE_BODY_CAP_CHARS} chars]`
}
