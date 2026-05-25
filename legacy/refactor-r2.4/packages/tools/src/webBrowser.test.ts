import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { getBuiltinTools } from './builtin.js'
import { runToolUse } from './runner.js'
import { createVaultHttpFetchTool } from './tools/vaultHttpFetch.js'
import { createWebSearchTool } from './tools/webSearch.js'

describe('V1.7 browser and computer-use tools', () => {
  it('runs stateful browser sessions, visual screenshots, and input events with explicit localhost opt-in', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-browser-'))
    const server = createServer((_, response) => {
      response.setHeader('content-type', 'text/html')
      response.end([
        '<html>',
        '<head><title>Fixture &amp; Browser</title><style>.x{}</style></head>',
        '<body><h1>Hello browser</h1><script>secret()</script><p>Visible text</p></body>',
        '</html>',
      ].join(''))
    })

    try {
      const url = await listen(server)
      const blocked = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_browser_blocked',
          name: 'WebBrowser',
          input: { url },
        },
        getBuiltinTools(),
        { cwd, permissionMode: 'default' },
      )
      expect(blocked).toMatchObject({
        is_error: true,
        permission_decision: 'deny',
      })
      expect(blocked.content).toContain('blocked local/private host')

      const navigate = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_browser_navigate',
          name: 'WebBrowser',
          input: { url, allowLocalhost: true },
        },
        getBuiltinTools(),
        { cwd, permissionMode: 'default' },
      )
      expect(navigate.is_error).toBeUndefined()
      const navigatePayload = JSON.parse(navigate.content) as {
        action: string
        sessionId: string
        title: string
        content: string
      }
      expect(navigatePayload.action).toBe('navigate')
      expect(navigatePayload.sessionId).toMatch(/^browser_/)
      expect(navigatePayload.title).toBe('Fixture & Browser')
      expect(navigatePayload.content).toContain('Hello browser')
      expect(navigatePayload.content).toContain('Visible text')
      expect(navigate.content).not.toContain('secret()')

      const screenshot = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_browser_screenshot',
          name: 'WebBrowser',
          input: { sessionId: navigatePayload.sessionId, action: 'screenshot' },
        },
        getBuiltinTools(),
        { cwd, permissionMode: 'default' },
      )
      const screenshotPayload = JSON.parse(screenshot.content) as {
        action: string
        screenshot: { path: string; format: string }
      }
      expect(screenshotPayload.action).toBe('screenshot')
      expect(screenshotPayload.screenshot.format).toBe('svg')
      expect(existsSync(screenshotPayload.screenshot.path)).toBe(true)

      const click = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_browser_click',
          name: 'WebBrowser',
          input: {
            sessionId: navigatePayload.sessionId,
            action: 'click',
            selector: 'h1',
            x: 12,
            y: 24,
          },
        },
        getBuiltinTools(),
        { cwd, permissionMode: 'default' },
      )
      const clickPayload = JSON.parse(click.content) as {
        focusedSelector: string
        events: Array<{ type: string; selector?: string }>
      }
      expect(clickPayload.focusedSelector).toBe('h1')
      expect(clickPayload.events.at(-1)).toMatchObject({ type: 'click', selector: 'h1' })

      const computerInput = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_computer_type',
          name: 'ComputerUseInput',
          input: {
            browserSessionId: navigatePayload.sessionId,
            action: 'type',
            text: 'hello',
          },
        },
        getBuiltinTools(),
        { cwd, permissionMode: 'default' },
      )
      const computerPayload = JSON.parse(computerInput.content) as {
        status: string
        transport: string
        typedTextLength: number
      }
      expect(computerPayload).toMatchObject({
        status: 'sent',
        transport: 'computer-use-input',
        typedTextLength: 5,
      })

      const computerState = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_computer_state',
          name: 'ComputerUse',
          input: { browserSessionId: navigatePayload.sessionId },
        },
        getBuiltinTools(),
        { cwd, permissionMode: 'default' },
      )
      expect(JSON.parse(computerState.content)).toMatchObject({
        transport: 'computer-use-mcp',
        nativeInputPackage: '@ant/computer-use-input',
        swiftPackage: '@ant/computer-use-swift',
        sessionCount: 1,
      })

      const fetchResult = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_web_fetch',
          name: 'WebFetch',
          input: { url, prompt: 'extract visible text', allowLocalhost: true },
        },
        getBuiltinTools(),
        { cwd, permissionMode: 'default' },
      )
      expect(fetchResult.is_error).toBeUndefined()
      expect(JSON.parse(fetchResult.content)).toMatchObject({
        code: 200,
        codeText: 'OK',
        prompt: 'extract visible text',
        result: expect.stringContaining('Hello browser'),
      })
    } finally {
      server.close()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('searches web fixtures with domain filters through an injectable adapter', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-search-'))
    const fixtureHtml = [
      '<ol id="b_results">',
      '<li class="b_algo"><h2><a href="https://docs.example.com/a">Docs &amp; API</a></h2><div class="b_caption"><p>Official docs snippet.</p></div></li>',
      '<li class="b_algo"><h2><a href="https://spam.example.net/b">Spam</a></h2><div class="b_caption"><p>Blocked snippet.</p></div></li>',
      '</ol>',
    ].join('')
    const webSearch = createWebSearchTool({
      fetchImpl: async () => new Response(fixtureHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
      endpoint: 'https://search.example.test/search',
    })

    try {
      const blocked = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_search_conflict',
          name: 'WebSearch',
          input: {
            query: 'claude docs',
            allowed_domains: ['docs.example.com'],
            blocked_domains: ['spam.example.net'],
          },
        },
        [webSearch],
        { cwd, permissionMode: 'bypassPermissions' },
      )
      expect(blocked).toMatchObject({
        is_error: true,
        permission_decision: 'deny',
      })

      const result = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_search',
          name: 'WebSearch',
          input: {
            query: 'claude docs',
            allowed_domains: ['docs.example.com'],
            num_results: 5,
          },
        },
        [webSearch],
        { cwd, permissionMode: 'default' },
      )
      const payload = JSON.parse(result.content) as {
        query: string
        results: Array<{ content: Array<{ title: string; url: string; snippet: string }> }>
      }
      expect(payload.query).toBe('claude docs')
      expect(payload.results[0]?.content).toEqual([
        {
          title: 'Docs & API',
          url: 'https://docs.example.com/a',
          snippet: 'Official docs snippet.',
        },
      ])
      expect(result.content).not.toContain('spam.example.net')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('fetches with vault auth without leaking secret-derived output', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my-claude-code-vault-'))
    const seenHeaders: Record<string, string> = {}
    const vaultFetch = createVaultHttpFetchTool({
      getSecret: key => key === 'github-token' ? 'secret-token-123' : undefined,
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers)
        headers.forEach((value, key) => {
          seenHeaders[key] = value
        })
        return new Response('echo secret-token-123 and Bearer secret-token-123', {
          status: 200,
          statusText: 'OK',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer secret-token-123',
            'x-trace': 'safe secret-token-123',
          },
        })
      },
    })

    try {
      const denied = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_vault_http',
          name: 'VaultHttpFetch',
          input: {
            url: 'http://api.example.com/user',
            vault_auth_key: 'github-token',
            reason: 'test non-https denial',
          },
        },
        [vaultFetch],
        {
          cwd,
          permissionMode: 'default',
          allowedTools: ['VaultHttpFetch(github-token@api.example.com)'],
        },
      )
      expect(denied).toMatchObject({
        is_error: true,
        permission_decision: 'deny',
      })
      expect(denied.content).toContain('Only https:// URLs are allowed')

      const result = await runToolUse(
        {
          type: 'tool_use',
          id: 'toolu_vault_https',
          name: 'VaultHttpFetch',
          input: {
            url: 'https://api.example.com/user',
            vault_auth_key: 'github-token',
            auth_scheme: 'bearer',
            reason: 'test authenticated fixture',
          },
        },
        [vaultFetch],
        {
          cwd,
          permissionMode: 'default',
          allowedTools: ['VaultHttpFetch(github-token@api.example.com)'],
        },
      )
      expect(result.is_error).toBeUndefined()
      expect(seenHeaders.authorization).toBe('Bearer secret-token-123')
      const payload = JSON.parse(result.content) as {
        status: number
        responseHeaders: Record<string, string>
        body: string
      }
      expect(payload.status).toBe(200)
      expect(payload.responseHeaders.authorization).toBe('[REDACTED]')
      expect(payload.responseHeaders['x-trace']).toBe('safe [REDACTED]')
      expect(payload.body).toBe('echo [REDACTED] and [REDACTED]')
      expect(result.content).not.toContain('secret-token-123')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) {
        resolve(`http://127.0.0.1:${address.port}/`)
      }
    })
  })
}
