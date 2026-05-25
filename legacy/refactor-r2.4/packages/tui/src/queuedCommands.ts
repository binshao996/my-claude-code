export type QueuedPromptCommand = {
  id: string
  prompt: string
  editable: boolean
  createdAt: string
}

export type PopEditableQueuedPromptCommandsResult = {
  queue: QueuedPromptCommand[]
  text: string
  cursor: number
  poppedCount: number
}

export type UpdateQueuedPromptCommandResult = {
  queue: QueuedPromptCommand[]
  updated: boolean
}

export type ReplaceEditableQueuedPromptCommandsResult = {
  queue: QueuedPromptCommand[]
  updatedCount: number
  removedCount: number
}

export function createQueuedPromptCommand(args: {
  id: string
  prompt: string
  now?: Date
  editable?: boolean
}): QueuedPromptCommand {
  return {
    id: args.id,
    prompt: args.prompt,
    editable: args.editable ?? true,
    createdAt: (args.now ?? new Date()).toISOString(),
  }
}

export function enqueueQueuedPromptCommand(
  queue: QueuedPromptCommand[],
  command: QueuedPromptCommand,
): QueuedPromptCommand[] {
  return [...queue, command]
}

export function dequeueNextQueuedPromptCommand(
  queue: QueuedPromptCommand[],
): {
  queue: QueuedPromptCommand[]
  command?: QueuedPromptCommand
} {
  const [command, ...rest] = queue
  return {
    queue: rest,
    ...(command ? { command } : {}),
  }
}

export function editableQueuedPromptCommandCount(
  queue: QueuedPromptCommand[],
): number {
  return queue.filter(command => command.editable).length
}

export function popAllEditableQueuedPromptCommands(
  queue: QueuedPromptCommand[],
  currentInput: string,
  currentCursor: number,
): PopEditableQueuedPromptCommandsResult | undefined {
  const editable = queue.filter(command => command.editable)
  if (editable.length === 0) {
    return undefined
  }

  const nonEditable = queue.filter(command => !command.editable)
  const queuedText = editable.map(command => command.prompt).join('\n')
  const text = [queuedText, currentInput].filter(Boolean).join('\n')
  const cursor = queuedText.length + (currentInput ? 1 + currentCursor : 0)

  return {
    queue: nonEditable,
    text,
    cursor,
    poppedCount: editable.length,
  }
}

export function updateQueuedPromptCommand(
  queue: QueuedPromptCommand[],
  id: string,
  prompt: string,
): UpdateQueuedPromptCommandResult {
  let updated = false
  const nextQueue = queue.map(command => {
    if (command.id !== id || !command.editable) {
      return command
    }

    updated = true
    return {
      ...command,
      prompt,
    }
  })

  return {
    queue: nextQueue,
    updated,
  }
}

export function replaceEditableQueuedPromptCommands(
  queue: QueuedPromptCommand[],
  editedText: string,
): ReplaceEditableQueuedPromptCommandsResult {
  const editedPrompts = editedText
    .split('\n')
    .map(prompt => prompt.trim())
    .filter(Boolean)
  let updatedCount = 0
  let removedCount = 0

  const nextQueue = queue.flatMap(command => {
    if (!command.editable) {
      return [command]
    }

    const prompt = editedPrompts.shift()
    if (!prompt) {
      removedCount++
      return []
    }

    updatedCount++
    return [{
      ...command,
      prompt,
    }]
  })

  return {
    queue: nextQueue,
    updatedCount,
    removedCount,
  }
}
