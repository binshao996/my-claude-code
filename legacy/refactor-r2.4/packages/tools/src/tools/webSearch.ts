import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const MAX_WEB_SEARCH_RESULTS = 20

const WebSearchInputSchema = z.object({
  query: z.string().min(2),
  allowed_domains: z.array(z.string()).optional(),
  blocked_domains: z.array(z.string()).optional(),
  num_results: z.number().int().positive().max(MAX_WEB_SEARCH_RESULTS).optional(),
  livecrawl: z.enum(['fallback', 'preferred']).optional(),
  search_type: z.enum(['auto', 'fast', 'deep']).optional(),
  context_max_characters: z.number().int().positive().optional(),
})

type WebSearchInput = z.infer<typeof WebSearchInputSchema>

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

type SearchResult = {
  title: string
  url: string
  snippet?: string
}

export function createWebSearchTool(options: {
  fetchImpl?: FetchLike
  endpoint?: string
} = {}): Tool<WebSearchInput> {
  const fetchImpl = options.fetchImpl ?? fetch
  const endpoint = options.endpoint ?? 'https://www.bing.com/search'

  return {
    name: 'WebSearch',
    description: 'Search the web for current information and return source links.',
    inputSchema: WebSearchInputSchema,
    inputJSONSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query to use.' },
        allowed_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only include search results from these domains.',
        },
        blocked_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Never include search results from these domains.',
        },
        num_results: {
          type: 'number',
          description: 'Number of search results to return.',
        },
        livecrawl: {
          type: 'string',
          enum: ['fallback', 'preferred'],
          description: 'Live crawl mode.',
        },
        search_type: {
          type: 'string',
          enum: ['auto', 'fast', 'deep'],
          description: 'Search type.',
        },
        context_max_characters: {
          type: 'number',
          description: 'Maximum characters for context strings.',
        },
      },
      required: ['query'],
    },
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    checkPermissions(input) {
      if (input.allowed_domains?.length && input.blocked_domains?.length) {
        return {
          decision: 'deny',
          reason: 'Cannot specify both allowed_domains and blocked_domains',
        }
      }
      return { decision: 'allow' }
    },
    async execute(input, context) {
      if (input.allowed_domains?.length && input.blocked_domains?.length) {
        throw new Error('Cannot specify both allowed_domains and blocked_domains')
      }

      const startedAt = Date.now()
      const url = new URL(endpoint)
      url.searchParams.set('q', input.query)
      url.searchParams.set('setmkt', 'en-US')
      const response = await fetchImpl(url, {
        headers: {
          'User-Agent': 'my-claude-code WebSearch',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        },
        signal: context.signal,
      })
      const html = await response.text()
      const results = filterResults(extractSearchResults(html), input)
        .slice(0, input.num_results ?? 8)

      return JSON.stringify({
        query: input.query,
        results: results.length
          ? [{
              tool_use_id: 'adapter-search-1',
              content: results,
            }]
          : ['No search results found.'],
        durationSeconds: (Date.now() - startedAt) / 1000,
        reminder: 'Include the sources above in the response using markdown hyperlinks.',
      }, null, 2)
    },
  }
}

export const webSearchTool = createWebSearchTool()

export function extractSearchResults(html: string): SearchResult[] {
  const results = extractBingResults(html)
  if (results.length > 0) {
    return results
  }
  return extractGenericLinks(html)
}

function extractBingResults(html: string): SearchResult[] {
  const results: SearchResult[] = []
  const blockRegex = /<li\s+class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi

  while (true) {
    const blockMatch = blockRegex.exec(html)
    if (!blockMatch) {
      break
    }
    const block = blockMatch[1] ?? ''
    const linkMatch = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!linkMatch) {
      continue
    }

    const url = resolveSearchUrl(decodeHtml(linkMatch[1] ?? ''))
    if (!url) {
      continue
    }

    results.push({
      title: htmlToText(linkMatch[2] ?? ''),
      url,
      snippet: extractSnippet(block),
    })
  }

  return dedupeResults(results)
}

function extractGenericLinks(html: string): SearchResult[] {
  const results: SearchResult[] = []
  const linkRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi

  while (true) {
    const match = linkRegex.exec(html)
    if (!match) {
      break
    }
    results.push({
      title: htmlToText(match[2] ?? ''),
      url: decodeHtml(match[1] ?? ''),
    })
  }

  return dedupeResults(results)
}

function extractSnippet(block: string): string | undefined {
  const lineClamp = /<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block)
  if (lineClamp) {
    return htmlToText(lineClamp[1] ?? '')
  }
  const caption = /<div[^>]*class="b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
  if (caption) {
    return htmlToText(caption[1] ?? '')
  }
  return undefined
}

function filterResults(results: SearchResult[], input: WebSearchInput): SearchResult[] {
  return results.filter(result => {
    let hostname: string
    try {
      hostname = new URL(result.url).hostname.toLowerCase()
    } catch {
      return false
    }

    if (
      input.allowed_domains?.length &&
      !input.allowed_domains.some(domain => domainMatches(hostname, domain))
    ) {
      return false
    }
    if (
      input.blocked_domains?.length &&
      input.blocked_domains.some(domain => domainMatches(hostname, domain))
    ) {
      return false
    }
    return true
  })
}

function domainMatches(hostname: string, domain: string): boolean {
  const normalized = domain.toLowerCase()
  return hostname === normalized || hostname.endsWith(`.${normalized}`)
}

function resolveSearchUrl(rawUrl: string): string | undefined {
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    return rawUrl
  }
  return undefined
}

function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>()
  return results.filter(result => {
    if (!result.title || !result.url || seen.has(result.url)) {
      return false
    }
    seen.add(result.url)
    return true
  })
}

function htmlToText(html: string): string {
  return decodeHtml(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
}

function decodeHtml(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}
