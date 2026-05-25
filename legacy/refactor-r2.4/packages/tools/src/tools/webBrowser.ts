import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { dirname, join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod/v4'
import type { Tool } from '../types.js'

const MAX_BROWSER_RESULT_CHARS = 50_000
const DEFAULT_VIEWPORT = { width: 1280, height: 720 }

const WebBrowserInputSchema = z.object({
  url: z.string().url().optional(),
  action: z
    .enum(['navigate', 'screenshot', 'click', 'type', 'key', 'scroll', 'back', 'forward', 'state'])
    .default('navigate'),
  sessionId: z.string().min(1).optional(),
  selector: z.string().min(1).optional(),
  text: z.string().optional(),
  key: z.string().min(1).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  deltaY: z.number().finite().optional(),
  allowLocalhost: z.boolean().optional(),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).optional(),
}).refine(input => input.url || input.sessionId, {
  message: 'WebBrowser requires either url or sessionId',
})

type WebBrowserInput = z.infer<typeof WebBrowserInputSchema>

export type BrowserSessionEvent = {
  id: string
  type: 'navigate' | 'screenshot' | 'click' | 'type' | 'key' | 'scroll' | 'back' | 'forward'
  createdAt: string
  selector?: string
  textLength?: number
  key?: string
  x?: number
  y?: number
  deltaY?: number
  url?: string
  artifactPath?: string
}

export type BrowserSessionRecord = {
  id: string
  url: string
  title: string
  status: 'open'
  viewport: { width: number; height: number }
  content: string
  history: string[]
  historyIndex: number
  focusedSelector?: string
  typedText?: string
  scrollY: number
  screenshotCount: number
  events: BrowserSessionEvent[]
  createdAt: string
  updatedAt: string
}

type BrowserOutput = {
  session: BrowserSessionRecord
  action: WebBrowserInput['action']
  artifactPath?: string
  content?: string
}

export const webBrowserTool: Tool<WebBrowserInput> = {
  name: 'WebBrowser',
  description:
    'Open and control a stateful browser session. Supports navigation, visual screenshot artifacts, click/type/key/scroll input events, history, and state inspection.',
  inputSchema: WebBrowserInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'HTTP or HTTPS URL to open or navigate to.' },
      action: {
        type: 'string',
        enum: ['navigate', 'screenshot', 'click', 'type', 'key', 'scroll', 'back', 'forward', 'state'],
        description: 'Browser session action.',
      },
      sessionId: { type: 'string', description: 'Existing browser session id.' },
      selector: { type: 'string', description: 'CSS selector or accessible target for input events.' },
      text: { type: 'string', description: 'Text to type into the focused target.' },
      key: { type: 'string', description: 'Keyboard key to send.' },
      x: { type: 'number', description: 'Viewport x coordinate for click events.' },
      y: { type: 'number', description: 'Viewport y coordinate for click events.' },
      deltaY: { type: 'number', description: 'Scroll delta in CSS pixels.' },
      allowLocalhost: {
        type: 'boolean',
        description: 'Allow localhost/private addresses for local tests and explicit local debugging.',
      },
      viewport: {
        type: 'object',
        properties: {
          width: { type: 'number' },
          height: { type: 'number' },
        },
        description: 'Viewport size for a new browser session.',
      },
    },
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions(input) {
    if (!input.url) {
      return { decision: 'allow' }
    }
    const url = parseBrowserUrl(input.url)
    const blockedReason = browserUrlBlockReason(url, input.allowLocalhost ?? false)
    if (blockedReason) {
      return {
        decision: 'deny',
        reason: blockedReason,
      }
    }
    return { decision: 'allow' }
  },
  async execute(input, context) {
    const action = input.action ?? 'navigate'
    let session = input.sessionId
      ? await readBrowserSession(context.cwd, input.sessionId)
      : undefined

    if (!session || action === 'navigate') {
      if (!input.url) {
        throw new Error('WebBrowser navigate requires url')
      }
      const page = await fetchBrowserPage(input.url, input.allowLocalhost ?? false, context.signal)
      session = await upsertBrowserSession(context.cwd, {
        previous: session,
        url: page.url,
        title: page.title,
        content: page.text,
        viewport: input.viewport ?? session?.viewport ?? DEFAULT_VIEWPORT,
      })
    }

    const next = await applyBrowserAction(context.cwd, session, input)
    return formatBrowserOutput({
      session: next.session,
      action,
      artifactPath: next.artifactPath,
      content: action === 'navigate' || action === 'state'
        ? truncateBrowserContent(next.session.content)
        : undefined,
    })
  },
}

export async function readBrowserSession(
  cwd: string,
  sessionId: string,
): Promise<BrowserSessionRecord | undefined> {
  const sessions = await readBrowserSessions(cwd)
  return sessions.find(session => session.id === sessionId)
}

export async function readBrowserSessions(cwd: string): Promise<BrowserSessionRecord[]> {
  return readJsonFile(browserSessionsPath(cwd), [])
}

export async function recordBrowserInputEvent(
  cwd: string,
  args: {
    sessionId: string
    type: 'click' | 'type' | 'key' | 'scroll' | 'screenshot'
    selector?: string
    text?: string
    key?: string
    x?: number
    y?: number
    deltaY?: number
  },
): Promise<BrowserSessionRecord> {
  const session = await readBrowserSession(cwd, args.sessionId)
  if (!session) {
    throw new Error(`browser session not found: ${args.sessionId}`)
  }
  const result = await applyBrowserAction(cwd, session, {
    action: args.type,
    sessionId: args.sessionId,
    selector: args.selector,
    text: args.text,
    key: args.key,
    x: args.x,
    y: args.y,
    deltaY: args.deltaY,
  })
  return result.session
}

async function applyBrowserAction(
  cwd: string,
  session: BrowserSessionRecord,
  input: WebBrowserInput,
): Promise<{ session: BrowserSessionRecord; artifactPath?: string }> {
  const action = input.action ?? 'navigate'
  switch (action) {
    case 'navigate':
      return { session }
    case 'screenshot': {
      const artifactPath = await writeScreenshotArtifact(cwd, session)
      return {
        session: await appendBrowserEvent(cwd, session, {
          type: 'screenshot',
          artifactPath,
        }),
        artifactPath,
      }
    }
    case 'click':
      return {
        session: await appendBrowserEvent(cwd, {
          ...session,
          focusedSelector: input.selector ?? session.focusedSelector,
        }, {
          type: 'click',
          selector: input.selector,
          x: input.x,
          y: input.y,
        }),
      }
    case 'type':
      return {
        session: await appendBrowserEvent(cwd, {
          ...session,
          typedText: `${session.typedText ?? ''}${input.text ?? ''}`,
        }, {
          type: 'type',
          selector: input.selector ?? session.focusedSelector,
          textLength: (input.text ?? '').length,
        }),
      }
    case 'key':
      return {
        session: await appendBrowserEvent(cwd, session, {
          type: 'key',
          key: input.key,
          selector: input.selector ?? session.focusedSelector,
        }),
      }
    case 'scroll':
      return {
        session: await appendBrowserEvent(cwd, {
          ...session,
          scrollY: Math.max(0, session.scrollY + (input.deltaY ?? 0)),
        }, {
          type: 'scroll',
          deltaY: input.deltaY ?? 0,
        }),
      }
    case 'back': {
      const historyIndex = Math.max(0, session.historyIndex - 1)
      return {
        session: await appendBrowserEvent(cwd, {
          ...session,
          historyIndex,
          url: session.history[historyIndex] ?? session.url,
        }, {
          type: 'back',
        }),
      }
    }
    case 'forward': {
      const historyIndex = Math.min(session.history.length - 1, session.historyIndex + 1)
      return {
        session: await appendBrowserEvent(cwd, {
          ...session,
          historyIndex,
          url: session.history[historyIndex] ?? session.url,
        }, {
          type: 'forward',
        }),
      }
    }
    case 'state':
      return { session }
  }
}

async function fetchBrowserPage(
  value: string,
  allowLocalhost: boolean,
  signal: AbortSignal | undefined,
): Promise<{ title: string; url: string; text: string }> {
  const url = parseBrowserUrl(value)
  assertBrowserUrlAllowed(url, allowLocalhost)
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; my-claude-code WebBrowser; +https://localhost)',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
    },
    redirect: 'follow',
    signal,
  })

  if (!response.ok) {
    return {
      title: `HTTP ${response.status}`,
      url: response.url || value,
      text: `Error: ${response.status} ${response.statusText}`,
    }
  }

  const contentType = response.headers.get('content-type') ?? ''
  const raw = await response.text()
  return {
    title: contentType.includes('html') ? extractTitle(raw) : '',
    url: response.url || value,
    text: contentType.includes('html') ? htmlToText(raw) : raw.trim(),
  }
}

async function upsertBrowserSession(
  cwd: string,
  args: {
    previous?: BrowserSessionRecord
    url: string
    title: string
    content: string
    viewport: BrowserSessionRecord['viewport']
  },
): Promise<BrowserSessionRecord> {
  const now = new Date().toISOString()
  const previous = args.previous
  const history = previous
    ? [...previous.history.slice(0, previous.historyIndex + 1), args.url]
    : [args.url]
  const session: BrowserSessionRecord = {
    id: previous?.id ?? `browser_${randomUUID()}`,
    url: args.url,
    title: args.title,
    status: 'open',
    viewport: args.viewport,
    content: args.content,
    history,
    historyIndex: history.length - 1,
    focusedSelector: previous?.focusedSelector,
    typedText: previous?.typedText,
    scrollY: previous?.scrollY ?? 0,
    screenshotCount: previous?.screenshotCount ?? 0,
    events: [
      ...(previous?.events ?? []),
      {
        id: `browser_event_${randomUUID()}`,
        type: 'navigate',
        url: args.url,
        createdAt: now,
      },
    ],
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
  await writeBrowserSession(cwd, session)
  return session
}

async function appendBrowserEvent(
  cwd: string,
  session: BrowserSessionRecord,
  event: Omit<BrowserSessionEvent, 'id' | 'createdAt'>,
): Promise<BrowserSessionRecord> {
  const now = new Date().toISOString()
  const next: BrowserSessionRecord = {
    ...session,
    screenshotCount: event.type === 'screenshot'
      ? session.screenshotCount + 1
      : session.screenshotCount,
    events: [
      ...session.events,
      {
        id: `browser_event_${randomUUID()}`,
        createdAt: now,
        ...event,
      },
    ],
    updatedAt: now,
  }
  await writeBrowserSession(cwd, next)
  return next
}

async function writeBrowserSession(cwd: string, session: BrowserSessionRecord): Promise<void> {
  const sessions = await readBrowserSessions(cwd)
  const next = [
    ...sessions.filter(candidate => candidate.id !== session.id),
    session,
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  await writeJsonFile(browserSessionsPath(cwd), next)
}

async function writeScreenshotArtifact(cwd: string, session: BrowserSessionRecord): Promise<string> {
  const artifactPath = join(
    browserSessionDirectory(cwd, session.id),
    `screenshot-${String(session.screenshotCount + 1).padStart(3, '0')}.svg`,
  )
  const lines = wrapSvgLines(session.content, 96).slice(0, 28)
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${session.viewport.width}" height="${session.viewport.height}" viewBox="0 0 ${session.viewport.width} ${session.viewport.height}">`,
    '<rect width="100%" height="100%" fill="#111111"/>',
    `<rect x="16" y="16" width="${session.viewport.width - 32}" height="42" rx="8" fill="#202020"/>`,
    `<text x="32" y="43" fill="#d7d7d7" font-family="monospace" font-size="16">${escapeXml(session.title || '(untitled)')}</text>`,
    `<text x="32" y="78" fill="#8ab4f8" font-family="monospace" font-size="13">${escapeXml(session.url)}</text>`,
    ...lines.map((line, index) =>
      `<text x="32" y="${116 + index * 22}" fill="#eeeeee" font-family="monospace" font-size="16">${escapeXml(line)}</text>`
    ),
    '</svg>',
  ].join('\n')
  await writeTextFile(artifactPath, svg)
  return artifactPath
}

function parseBrowserUrl(value: string): URL {
  try {
    return new URL(value)
  } catch {
    throw new Error(`invalid browser URL: ${value}`)
  }
}

function assertBrowserUrlAllowed(url: URL, allowLocalhost: boolean): void {
  const blockedReason = browserUrlBlockReason(url, allowLocalhost)
  if (blockedReason) {
    throw new Error(blockedReason)
  }
}

function browserUrlBlockReason(url: URL, allowLocalhost: boolean): string | undefined {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `WebBrowser only supports http and https URLs: ${url.protocol}`
  }
  if (!allowLocalhost && isLocalOrPrivateHost(url.hostname)) {
    return `WebBrowser blocked local/private host: ${url.hostname}`
  }
  return undefined
}

function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1'
  ) {
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

function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return decodeHtmlEntities(match?.[1]?.replace(/\s+/g, ' ').trim() ?? '')
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

function truncateBrowserContent(content: string): string {
  if (content.length <= MAX_BROWSER_RESULT_CHARS) {
    return content
  }
  return `${content.slice(0, MAX_BROWSER_RESULT_CHARS)}\n[truncated: WebBrowser output exceeded ${MAX_BROWSER_RESULT_CHARS} chars]`
}

function formatBrowserOutput(output: BrowserOutput): string {
  return JSON.stringify({
    action: output.action,
    sessionId: output.session.id,
    status: output.session.status,
    title: output.session.title || '(untitled)',
    url: output.session.url,
    viewport: output.session.viewport,
    scrollY: output.session.scrollY,
    focusedSelector: output.session.focusedSelector,
    typedTextLength: output.session.typedText?.length ?? 0,
    history: {
      index: output.session.historyIndex,
      entries: output.session.history,
    },
    screenshot: output.artifactPath
      ? {
          path: output.artifactPath,
          format: 'svg',
        }
      : undefined,
    events: output.session.events.slice(-10),
    content: output.content,
  }, null, 2)
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return fallback
    }
    throw error
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeTextFile(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value, 'utf8')
}

function browserSessionsPath(cwd: string): string {
  return join(cwd, '.my-claude-code', 'browser-sessions', 'sessions.json')
}

function browserSessionDirectory(cwd: string, sessionId: string): string {
  return join(cwd, '.my-claude-code', 'browser-sessions', sessionId)
}

function wrapSvgLines(value: string, columns: number): string[] {
  const words = value.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length > columns && current) {
      lines.push(current)
      current = word
      continue
    }
    current = next
  }
  if (current) {
    lines.push(current)
  }
  return lines
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
