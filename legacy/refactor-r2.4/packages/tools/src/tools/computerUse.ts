import { z } from 'zod/v4'
import type { Tool } from '../types.js'
import {
  type BrowserSessionRecord,
  readBrowserSession,
  readBrowserSessions,
  recordBrowserInputEvent,
} from './webBrowser.js'

const ComputerUseInputSchema = z.object({
  browserSessionId: z.string().min(1),
  action: z.enum(['click', 'type', 'key', 'scroll', 'screenshot']),
  selector: z.string().min(1).optional(),
  text: z.string().optional(),
  key: z.string().min(1).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  deltaY: z.number().finite().optional(),
})

const ComputerUseStateSchema = z.object({
  browserSessionId: z.string().min(1).optional(),
})

type ComputerUseInput = z.infer<typeof ComputerUseInputSchema>
type ComputerUseStateInput = z.infer<typeof ComputerUseStateSchema>

export const computerUseInputTool: Tool<ComputerUseInput> = {
  name: 'ComputerUseInput',
  description:
    'Send native computer-use style input events to an active browser session: click, type, key, scroll, or screenshot.',
  inputSchema: ComputerUseInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      browserSessionId: { type: 'string', description: 'WebBrowser session id.' },
      action: {
        type: 'string',
        enum: ['click', 'type', 'key', 'scroll', 'screenshot'],
        description: 'Input event to send.',
      },
      selector: { type: 'string', description: 'Optional target selector.' },
      text: { type: 'string', description: 'Text to type.' },
      key: { type: 'string', description: 'Key to press.' },
      x: { type: 'number', description: 'Click x coordinate.' },
      y: { type: 'number', description: 'Click y coordinate.' },
      deltaY: { type: 'number', description: 'Scroll delta.' },
    },
    required: ['browserSessionId', 'action'],
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  async checkPermissions(input, context) {
    const session = await readBrowserSession(context.cwd, input.browserSessionId)
    if (!session) {
      return {
        decision: 'deny',
        reason: `browser session not found: ${input.browserSessionId}`,
      }
    }
    return { decision: 'allow' }
  },
  async execute(input, context) {
    const session = await recordBrowserInputEvent(context.cwd, {
      sessionId: input.browserSessionId,
      type: input.action,
      selector: input.selector,
      text: input.text,
      key: input.key,
      x: input.x,
      y: input.y,
      deltaY: input.deltaY,
    })
    return JSON.stringify({
      status: 'sent',
      transport: 'computer-use-input',
      browserSessionId: session.id,
      action: input.action,
      event: session.events.at(-1),
      viewport: session.viewport,
      focusedSelector: session.focusedSelector,
      scrollY: session.scrollY,
      typedTextLength: session.typedText?.length ?? 0,
    }, null, 2)
  },
}

export const computerUseTool: Tool<ComputerUseStateInput> = {
  name: 'ComputerUse',
  description:
    'Inspect the local computer-use runtime, active browser sessions, and event history.',
  inputSchema: ComputerUseStateSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      browserSessionId: { type: 'string', description: 'Optional WebBrowser session id.' },
    },
  },
  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
  async checkPermissions(input, context) {
    if (!input.browserSessionId) {
      return { decision: 'allow' }
    }
    const session = await readBrowserSession(context.cwd, input.browserSessionId)
    return session
      ? { decision: 'allow' }
      : {
          decision: 'deny',
          reason: `browser session not found: ${input.browserSessionId}`,
        }
  },
  async execute(input, context) {
    const sessions = input.browserSessionId
      ? [await readBrowserSession(context.cwd, input.browserSessionId)].filter(isBrowserSession)
      : await readBrowserSessions(context.cwd)
    return JSON.stringify({
      transport: 'computer-use-mcp',
      nativeInputPackage: '@ant/computer-use-input',
      swiftPackage: '@ant/computer-use-swift',
      sessionCount: sessions.length,
      sessions: sessions.map(session => ({
        id: session.id,
        url: session.url,
        title: session.title,
        status: session.status,
        viewport: session.viewport,
        eventCount: session.events.length,
        lastEvent: session.events.at(-1),
      })),
    }, null, 2)
  },
}

function isBrowserSession(
  session: BrowserSessionRecord | undefined,
): session is BrowserSessionRecord {
  return Boolean(session)
}
