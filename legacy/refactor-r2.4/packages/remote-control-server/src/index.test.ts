import { describe, expect, it } from 'bun:test'
import { startRemoteControlServerRuntime } from './index.js'

describe('remote-control-server runtime', () => {
  it('serves health, sessions, SSE, and POST ingress without owning tool state', async () => {
    const events: unknown[] = []
    const server = await startRemoteControlServerRuntime({
      onHealth: () => ({ daemon: { status: 'running' } }),
      onSessions: () => ({ sessions: [{ id: 'remote_1' }] }),
      onEvent: input => {
        const event = {
          id: 'bridge_1',
          type: 'remote.trigger',
          createdAt: '2026-05-24T00:00:00.000Z',
          payload: {
            transport: input.transport,
            bodyHash: input.bodyHash,
          },
        }
        events.push(event)
        return event
      },
    })

    try {
      await expect(fetch(`${server.url}/health`).then(response => response.json()))
        .resolves.toMatchObject({ daemon: { status: 'running' } })
      await expect(fetch(`${server.url}/sessions`).then(response => response.json()))
        .resolves.toMatchObject({ sessions: [{ id: 'remote_1' }] })
      await expect(fetch(`${server.url}/worker/events`, {
        method: 'POST',
        body: 'secret-body',
      }).then(response => response.json())).resolves.toMatchObject({
        event: {
          type: 'remote.trigger',
          payload: {
            transport: 'http-bridge',
            bodyHash: expect.any(String),
          },
        },
      })
      expect(JSON.stringify(events)).not.toContain('secret-body')
    } finally {
      await server.close()
    }
  })
})
