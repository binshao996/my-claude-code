import { isIP } from 'node:net'
import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const MAX_WEB_FETCH_CHARS = 100_000

const WebFetchInputSchema = z.object({
  url: z.string().url(),
  prompt: z.string().min(1),
  allowLocalhost: z.boolean().optional(),
})

type WebFetchInput = z.infer<typeof WebFetchInputSchema>

export const webFetchTool: Tool<WebFetchInput> = {
  name: 'WebFetch',
  description: 'Fetch URL content and return text relevant to the supplied prompt.',
  inputSchema: WebFetchInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'HTTP or HTTPS URL to fetch.' },
      prompt: { type: 'string', description: 'What information to extract from the fetched content.' },
      allowLocalhost: {
        type: 'boolean',
        description: 'Allow localhost/private addresses for explicit local tests.',
      },
    },
    required: ['url', 'prompt'],
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  checkPermissions(input) {
    const url = new URL(input.url)
    const blockedReason = webFetchBlockReason(url, input.allowLocalhost ?? false)
    if (blockedReason) {
      return { decision: 'deny', reason: blockedReason }
    }
    return { decision: 'allow' }
  },
  execute: async (input, context) => {
    const url = new URL(input.url)
    const blockedReason = webFetchBlockReason(url, input.allowLocalhost ?? false)
    if (blockedReason) {
      throw new Error(blockedReason)
    }
    const startedAt = Date.now()
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'my-claude-code WebFetch',
        Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5',
      },
      redirect: 'follow',
      signal: context.signal,
    })
    const raw = await response.text()
    const contentType = response.headers.get('content-type') ?? ''
    const text = contentType.includes('html') ? htmlToText(raw) : raw.trim()
    return JSON.stringify({
      bytes: new TextEncoder().encode(raw).byteLength,
      code: response.status,
      codeText: response.statusText,
      durationMs: Date.now() - startedAt,
      url: response.url || input.url,
      prompt: input.prompt,
      result: truncateWebFetch(text),
    }, null, 2)
  },
}

function webFetchBlockReason(url: URL, allowLocalhost: boolean): string | undefined {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `WebFetch only supports http and https URLs: ${url.protocol}`
  }
  if (!allowLocalhost && isLocalOrPrivateHost(url.hostname)) {
    return `WebFetch blocked local/private host: ${url.hostname}`
  }
  return undefined
}

function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') {
    return true
  }

  const ipVersion = isIP(host)
  if (ipVersion === 4) {
    const [a = 0, b = 0] = host.split('.').map(part => Number(part))
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0
    )
  }
  if (ipVersion === 6) {
    return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')
  }
  return false
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function truncateWebFetch(content: string): string {
  if (content.length <= MAX_WEB_FETCH_CHARS) {
    return content
  }
  return `${content.slice(0, MAX_WEB_FETCH_CHARS)}\n[truncated: WebFetch output exceeded ${MAX_WEB_FETCH_CHARS} chars]`
}
