import { describe, expect, it } from 'bun:test'
import {
  createQueuedPromptCommand,
  dequeueNextQueuedPromptCommand,
  editableQueuedPromptCommandCount,
  enqueueQueuedPromptCommand,
  popAllEditableQueuedPromptCommands,
  replaceEditableQueuedPromptCommands,
  updateQueuedPromptCommand,
} from './queuedCommands.js'

describe('queued prompt commands', () => {
  it('enqueues and drains prompts FIFO', () => {
    const first = createQueuedPromptCommand({
      id: 'q1',
      prompt: 'first',
      now: new Date('2026-05-23T00:00:00.000Z'),
    })
    const second = createQueuedPromptCommand({
      id: 'q2',
      prompt: 'second',
      now: new Date('2026-05-23T00:00:01.000Z'),
    })
    const queue = enqueueQueuedPromptCommand(
      enqueueQueuedPromptCommand([], first),
      second,
    )

    const drained = dequeueNextQueuedPromptCommand(queue)
    expect(drained.command).toEqual(first)
    expect(drained.queue).toEqual([second])
  })

  it('pops all editable queued prompts into the current input', () => {
    const queue = [
      createQueuedPromptCommand({
        id: 'q1',
        prompt: 'queued one',
        now: new Date('2026-05-23T00:00:00.000Z'),
      }),
      createQueuedPromptCommand({
        id: 'q2',
        prompt: 'notification',
        now: new Date('2026-05-23T00:00:01.000Z'),
        editable: false,
      }),
      createQueuedPromptCommand({
        id: 'q3',
        prompt: 'queued two',
        now: new Date('2026-05-23T00:00:02.000Z'),
      }),
    ]

    expect(editableQueuedPromptCommandCount(queue)).toBe(2)
    expect(popAllEditableQueuedPromptCommands(queue, 'draft', 2)).toEqual({
      queue: [queue[1]],
      text: 'queued one\nqueued two\ndraft',
      cursor: 'queued one\nqueued two'.length + 1 + 2,
      poppedCount: 2,
    })
  })

  it('updates editable queued prompts without touching locked queue entries', () => {
    const queue = [
      createQueuedPromptCommand({
        id: 'q1',
        prompt: 'draft',
        now: new Date('2026-05-23T00:00:00.000Z'),
      }),
      createQueuedPromptCommand({
        id: 'q2',
        prompt: 'locked',
        now: new Date('2026-05-23T00:00:01.000Z'),
        editable: false,
      }),
    ]

    expect(updateQueuedPromptCommand(queue, 'q1', 'edited')).toEqual({
      queue: [{ ...queue[0], prompt: 'edited' }, queue[1]],
      updated: true,
    })
    expect(updateQueuedPromptCommand(queue, 'q2', 'ignored')).toEqual({
      queue,
      updated: false,
    })
  })

  it('replaces editable queued prompt text from edited lines', () => {
    const queue = [
      createQueuedPromptCommand({
        id: 'q1',
        prompt: 'queued one',
        now: new Date('2026-05-23T00:00:00.000Z'),
      }),
      createQueuedPromptCommand({
        id: 'q2',
        prompt: 'notification',
        now: new Date('2026-05-23T00:00:01.000Z'),
        editable: false,
      }),
      createQueuedPromptCommand({
        id: 'q3',
        prompt: 'queued two',
        now: new Date('2026-05-23T00:00:02.000Z'),
      }),
    ]

    expect(replaceEditableQueuedPromptCommands(queue, 'edited one\n\n')).toEqual({
      queue: [{ ...queue[0], prompt: 'edited one' }, queue[1]],
      updatedCount: 1,
      removedCount: 1,
    })
  })
})
