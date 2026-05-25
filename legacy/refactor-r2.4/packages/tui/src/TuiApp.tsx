import { randomUUID } from 'node:crypto'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, ThemeProvider, useApp, useInput, useStdout, useTheme } from '@anthropic/ink'
import { query, textDeltaFromEvent } from '@my-claude-code/agent-runtime'
import type { ContentBlock, Message } from '@my-claude-code/core'
import {
  buildHelpV2Screen,
  buildNativeImagePasteScreen,
  buildOnboardingScreen,
  buildThemeScreen,
  buildWizardScreen,
  collectDoctorScreen,
  collectSandboxScreen,
  collectSettingsScreen,
  collectTrustScreen,
  SLASH_COMMAND_DESCRIPTIONS,
  SLASH_COMMAND_NAMES,
  type CommandScreen,
  runSlashCommand,
} from '@my-claude-code/commands'
import {
  appendProjectSettingsRule,
  loadSettings,
  setProjectSetting,
  type ThemeName,
} from '@my-claude-code/settings'
import {
  forkSession,
  listSessionCheckpoints,
  listSessions,
  replaySession,
  rewindFilesToCheckpoint,
  resolveSession,
  sessionContextStats,
  type ReplayContext,
  type SessionCheckpoint,
  type SessionMetadata,
  type SessionRestorePlan,
} from '@my-claude-code/session'
import { CheckpointPicker } from './components/CheckpointPicker.js'
import {
  collectPromptCompletionAgents,
  collectPromptCompletionFilePaths,
  collectPromptCompletionMcpResources,
  collectPromptPlatformCompletionSources,
  DEFAULT_QUEUED_COMMAND_COMPLETIONS,
  type PromptPlatformCompletionSources,
} from './completionSources.js'
import { messageRowsForDisplay } from './messageMarkdown.js'
import {
  readVoiceMode,
  startVoiceRuntimeRecording,
  stopVoiceRuntimeRecording,
  type PermissionCheck,
  type VoiceModeState,
  type VoiceRecordingSession,
} from '@my-claude-code/tools'
import { InfoScreen } from './components/InfoScreen.js'
import { MessageList, type MessageListHeaderRow } from './components/MessageList.js'
import { OverlayStack } from './components/OverlayStack.js'
import { PermissionPanel } from './components/PermissionPanel.js'
import { PromptInput } from './components/PromptInput.js'
import { ResumePicker } from './components/ResumePicker.js'
import { statusLineRows, statusLineSelectionRows } from './components/StatusLine.js'
import { ThemePicker } from './components/ThemePicker.js'
import { TuiRuntimeProvider } from './TuiContext.js'
import {
  DEFAULT_INTERACTIVE_MAX_TURNS,
  type PermissionNotice,
  type TuiMessage,
  type TuiRuntimeOptions,
  type TuiStatus,
} from './tuiTypes.js'
import {
  activePermissionRequest,
  permissionRulesForQueue,
  removePermissionRequest,
  resolvePermissionQueue,
  type QueuedPermissionRequest,
} from './permissionQueue.js'
import {
  permissionRuleForRequest,
  summarizePermissionRule,
} from './permissionRules.js'
import {
  scrollTopFromOffsetFromEnd,
} from './components/ScrollBox.js'
import {
  measureMessageViewport,
  messageRowCount,
  windowMessageRowRangesInWindow,
} from './windowing.js'
import {
  buildScreenSelectionRows,
  hitTestScreenRows,
  screenPointFromTerminalMouse,
  selectablePointFromHit,
  selectedScreenText,
  type ScreenSelection,
} from './screenSelection.js'
import { parseSgrMouseEvent } from './promptEditing.js'
import {
  copyTextToSystemClipboard,
  imageClipboardCommandForPlatform,
  readImageFromSystemClipboard,
  type ClipboardImage,
} from './clipboard.js'
import {
  createQueuedPromptCommand,
  dequeueNextQueuedPromptCommand,
  editableQueuedPromptCommandCount,
  enqueueQueuedPromptCommand,
  popAllEditableQueuedPromptCommands,
  type QueuedPromptCommand,
} from './queuedCommands.js'

export function TuiApp(props: {
  options: TuiRuntimeOptions
  maxVisibleMessages?: number
}) {
  const app = useApp()
  const { stdout } = useStdout()
  const [sessionId, setSessionId] = useState(() => props.options.sessionId ?? randomUUID())
  const cwd = props.options.cwd ?? process.cwd()
  const queryRuntime = props.options.queryRuntime ?? query
  const abortRef = useRef<AbortController | undefined>(undefined)
  const userContextRef = useRef<string | undefined>(props.options.userContext)
  const hydratedMessagesRef = useRef<Message[] | undefined>(props.options.messages)
  const streamingAssistantTextRef = useRef('')
  const [streamingAssistantText, setStreamingAssistantText] = useState('')
  const [turnWaitingState, setTurnWaitingState] = useState<{
    startedAt: number
    visibleText: boolean
  }>()
  const [messages, setMessages] = useState<TuiMessage[]>([
    systemMessage(startupMessage(cwd)),
  ])
  const [input, setInput] = useState('')
  const [inputCursor, setInputCursor] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | undefined>()
  const [vimMode, setVimMode] = useState(() => props.options.vimMode ?? false)
  const [queuedPromptCommands, setQueuedPromptCommandsState] = useState<
    QueuedPromptCommand[]
  >([])
  const queuedPromptCommandsRef = useRef<QueuedPromptCommand[]>([])
  const [completionFilePaths, setCompletionFilePaths] = useState<string[]>([])
  const [completionMcpResources, setCompletionMcpResources] = useState<string[]>([])
  const [completionAgents, setCompletionAgents] = useState<string[]>([])
  const [platformCompletionSources, setPlatformCompletionSources] =
    useState<PromptPlatformCompletionSources>({
      slackChannels: [],
      ideMentions: [],
      imageAttachments: [],
      voiceActions: [],
    })
  const [clipboardImage, setClipboardImage] = useState<ClipboardImage>()
  const [status, setStatus] = useState<TuiStatus>('idle')
  const [scrollOffsetFromEnd, setScrollOffsetFromEnd] = useState(0)
  const [additionalDirectories, setAdditionalDirectories] = useState<string[]>(
    props.options.additionalDirectories ?? [],
  )
  const [, setViewportVersion] = useState(0)
  const [allowedTools, setAllowedTools] = useState<string[]>(
    props.options.allowedTools ?? [],
  )
  const [disallowedTools, setDisallowedTools] = useState<string[]>(
    props.options.disallowedTools ?? [],
  )
  const [permissionNotice, setPermissionNotice] = useState<PermissionNotice>()
  const [permissionQueue, setPermissionQueue] = useState<QueuedPermissionRequest[]>([])
  const [resumeSessions, setResumeSessions] = useState<SessionMetadata[]>()
  const [resumeIndex, setResumeIndex] = useState(0)
  const [resumeRestorePlans, setResumeRestorePlans] = useState<
    Record<string, SessionRestorePlan>
  >({})
  const [checkpointPicker, setCheckpointPicker] = useState<{
    session: SessionMetadata
    checkpoints: SessionCheckpoint[]
  }>()
  const [themePicker, setThemePicker] = useState<ThemeName>()
  const [activeTheme, setActiveTheme] = useState<ThemeName>('default')
  const [activeScreen, setActiveScreen] = useState<CommandScreen>()
  const [screenSelection, setScreenSelection] = useState<ScreenSelection>()
  const [statusStats, setStatusStats] = useState<ReplayContext['stats']>()
  const [voiceMode, setVoiceModeState] = useState<VoiceModeState>()
  const [voiceRecording, setVoiceRecording] = useState<VoiceRecordingSession>()
  const refreshVoiceMode = useCallback(async () => {
    setVoiceModeState(await readVoiceMode(cwd))
  }, [cwd])
  const permissionRequest = activePermissionRequest(permissionQueue)
  const hasOverlay =
    Boolean(permissionRequest) ||
    Boolean(permissionNotice) ||
    Boolean(resumeSessions) ||
    Boolean(checkpointPicker) ||
    Boolean(themePicker) ||
    Boolean(activeScreen)
  const messageViewport = measureMessageViewport(stdout ?? props.options.output, {
    reservedRows: 12,
    fallbackRows: props.maxVisibleMessages ?? 20,
  })
  const messageWindowRows = props.maxVisibleMessages ??
    (hasOverlay ? Math.max(5, Math.floor(messageViewport.rows / 2)) : messageViewport.rows)
  const messageWindowColumns = messageViewport.columns
    ? Math.max(10, messageViewport.columns - 3)
    : undefined
  const streamingDisplayText = completeStreamingLines(streamingAssistantText)
  const displayMessages = streamingDisplayText
    ? [
        ...messages,
        {
          id: 'streaming-assistant',
          role: 'assistant' as const,
          text: streamingDisplayText,
        },
      ]
    : messages
  const statusLineProps = {
    sessionId,
    cwd,
    version: props.options.version,
    model: props.options.model,
    permissionMode: props.options.permissionMode,
    status,
    tokenBudget: statusStats?.tokenBudget,
    promptCacheHitRate: statusStats?.promptCache.hitRate,
    voice: voiceMode
      ? {
          enabled: voiceMode.enabled,
          status: voiceMode.status,
          provider: voiceMode.provider,
          recording: voiceRecording?.status === 'recording',
        }
      : undefined,
  }
  const statusHeaderRows = messageListStatusRows(statusLineProps)
  const statusRows = statusLineSelectionRows(statusLineProps)
  const showLoadingIndicator =
    status !== 'idle' && Boolean(turnWaitingState && !streamingDisplayText)
  const promptRows = promptChromeRows({
    input,
    showLoadingIndicator,
  })
  const loadingRows = showLoadingIndicator ? 1 : 0
  const messageRows = displayMessages.reduce(
    (current, message) =>
      current + messageRowCount(message, messageWindowColumns),
    0,
  )
  const transcriptRows = statusHeaderRows.length + messageRows
  const scrollHeight = transcriptRows + loadingRows + promptRows
  const appViewportRows = messageWindowRows + loadingRows + promptRows
  const viewportRows = Math.max(
    1,
    Math.min(appViewportRows, Math.max(1, scrollHeight)),
  )
  const maxScrollOffsetFromEnd = Math.max(0, scrollHeight - viewportRows)
  const normalizedScrollOffsetFromEnd = Math.min(
    maxScrollOffsetFromEnd,
    Math.max(0, scrollOffsetFromEnd),
  )
  const scrollTop = scrollTopFromOffsetFromEnd({
    scrollHeight,
    viewportRows,
    offsetFromEnd: normalizedScrollOffsetFromEnd,
  })
  const scrollWindowStart = scrollTop
  const scrollWindowEnd = scrollTop + viewportRows
  const loadingStart = transcriptRows
  const promptStart = loadingStart + loadingRows
  const promptEnd = promptStart + promptRows
  const isLoadingVisible =
    showLoadingIndicator &&
    scrollWindowStart < loadingStart + loadingRows &&
    scrollWindowEnd > loadingStart
  const isPromptVisible =
    scrollWindowStart < promptEnd &&
    scrollWindowEnd > promptStart
  const rawTranscriptWindowStart = Math.max(0, scrollWindowStart)
  const rawTranscriptWindowEnd = Math.max(
    0,
    Math.min(transcriptRows, scrollWindowEnd),
  )
  const transcriptViewportRows = isLoadingVisible || isPromptVisible
    ? Math.max(0, rawTranscriptWindowEnd - rawTranscriptWindowStart)
    : Math.min(viewportRows, transcriptRows)
  const transcriptWindowEnd = isLoadingVisible || isPromptVisible
    ? rawTranscriptWindowEnd
    : Math.min(transcriptRows, Math.max(transcriptViewportRows, rawTranscriptWindowEnd))
  const transcriptWindowStart = Math.max(
    0,
    transcriptWindowEnd - transcriptViewportRows,
  )
  const visibleTranscriptRows = Math.max(
    0,
    transcriptWindowEnd - transcriptWindowStart,
  )
  const visibleStatusRows = statusRows.slice(
    Math.max(0, transcriptWindowStart),
    Math.max(0, Math.min(statusRows.length, transcriptWindowEnd)),
  )
  const messageRowWindow = windowMessageRowRangesInWindow(
    displayMessages,
    Math.max(0, transcriptWindowStart - statusHeaderRows.length),
    Math.max(0, transcriptWindowEnd - statusHeaderRows.length),
    messageWindowColumns,
  )
  const messageWindowVisible = messageRowWindow.ranges.map(range => range.message)
  const appScrollBarRows = scrollHeight > viewportRows
    ? renderAppScrollBarRows({
        scrollTop,
        scrollHeight,
        viewportRows,
        trackRows: viewportRows,
      })
    : undefined
  const moveAppScrollByRows = (deltaRows: number) => {
    setScrollOffsetFromEnd(current =>
      Math.max(0, Math.min(maxScrollOffsetFromEnd, current - deltaRows)),
    )
  }
  const screenRows = buildScreenSelectionRows({
    statusRows: visibleStatusRows,
    messages: messageWindowVisible,
    messageRows: messageRowWindow.ranges.map(range => {
      const rows = messageRowsForDisplay(range.message, messageWindowColumns)
      return {
        message: range.message,
        rows: rows.slice(
          range.visibleStart - range.start,
          range.visibleEnd - range.start,
        ),
      }
    }),
    olderHiddenMessages: 0,
    newerHiddenMessages: 0,
    activityRows: isLoadingVisible ? ['✻ Thinking…'] : undefined,
    overlays: permissionRequest
      ? [`permission: ${permissionRequest.tool}`]
      : permissionNotice
        ? [`permission ${permissionNotice.decision}: ${permissionNotice.tool}`]
        : undefined,
    promptValue: isPromptVisible ? input : undefined,
    promptPrefix: status === 'idle' ? '> ' : '… ',
    noSelectDecorations: true,
    columns: messageWindowColumns,
  })
  const messageScreenStartRow = Math.max(
    0,
    screenRows.findIndex(row => row.pane === 'messages'),
  )
  const screenSelectionText = selectedScreenText(screenRows, screenSelection)
  const promptScreenStartRow = Math.max(0, screenRows.length - input.split('\n').length)
  const setQueuedPromptCommands = (
    update:
      | QueuedPromptCommand[]
      | ((current: QueuedPromptCommand[]) => QueuedPromptCommand[]),
  ) => {
    setQueuedPromptCommandsState(current => {
      const next = typeof update === 'function' ? update(current) : update
      queuedPromptCommandsRef.current = next
      return next
    })
  }

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      collectPromptCompletionFilePaths(cwd),
      collectPromptCompletionMcpResources(cwd),
      collectPromptCompletionAgents(cwd),
      collectPromptPlatformCompletionSources(cwd),
    ]).then(([paths, mcpResources, agents, platformSources]) => {
      if (cancelled) {
        return
      }

      setCompletionFilePaths(paths)
      setCompletionMcpResources(mcpResources)
      setCompletionAgents(agents)
      setPlatformCompletionSources(platformSources)
    })

    return () => {
      cancelled = true
    }
  }, [cwd])

  useEffect(() => {
    void refreshVoiceMode()
  }, [refreshVoiceMode])

  useEffect(() => {
    const output = props.options.output ?? stdout
    if (!isWritableOutput(output)) {
      return
    }

    output.write('\x1B[?1000h\x1B[?1002h\x1B[?1006h')
    return () => {
      output.write('\x1B[?1000l\x1B[?1002l\x1B[?1006l')
    }
  }, [props.options.output, stdout])

  useEffect(() => {
    const output = stdout ?? props.options.output
    if (!hasResizeEvents(output)) {
      return
    }

    const rerender = () => {
      setViewportVersion(version => version + 1)
    }
    output.on('resize', rerender)
    return () => {
      output.off('resize', rerender)
    }
  }, [props.options.output, stdout])

  const refreshStatusStats = useCallback(async () => {
    try {
      setStatusStats((await sessionContextStats(cwd, sessionId))?.stats)
    } catch {
      setStatusStats(undefined)
    }
  }, [cwd, sessionId])

  useEffect(() => {
    void refreshStatusStats()
  }, [refreshStatusStats])

  useEffect(() => {
    let cancelled = false
    void loadSettings(cwd).then(settings => {
      if (!cancelled) {
        setActiveTheme(settings.theme ?? 'default')
      }
    })

    return () => {
      cancelled = true
    }
  }, [cwd])

  const appendMessage = (
    message: TuiMessage,
    options: { stickToLatest?: boolean } = {},
  ) => {
    setMessages(current => [...current, message])
    setScrollOffsetFromEnd(current =>
      options.stickToLatest === false && current > 0
        ? current + messageRowCount(message, messageWindowColumns)
        : 0,
    )
  }
  const appendAssistantMessage = useCallback((text: string) => {
    const trimmed = text.trimEnd()
    if (!trimmed) {
      return
    }

    setMessages(current => [
      ...current,
      {
        id: randomUUID(),
        role: 'assistant',
        text: trimmed,
      },
    ])
    setScrollOffsetFromEnd(0)
  }, [])

  const clearStreamingAssistant = useCallback(() => {
    streamingAssistantTextRef.current = ''
    setStreamingAssistantText('')
  }, [])

  const finalizeStreamingAssistant = useCallback(() => {
    const text = streamingAssistantTextRef.current
    clearStreamingAssistant()
    appendAssistantMessage(text)
  }, [appendAssistantMessage, clearStreamingAssistant])

  const submitSlashCommand = async (command: string) => {
    const output: string[] = []
    try {
      const result = await runSlashCommand({
        command,
        options: {
          model: props.options.model,
          permissionMode: props.options.permissionMode,
          allowedTools,
          disallowedTools,
          sessionId,
          vimMode,
          additionalDirectories,
        },
        io: {
          stdout: { write: chunk => output.push(chunk) },
          stderr: { write: chunk => output.push(chunk) },
        },
        cwd,
        version: props.options.version ?? '1.0.0',
      })

      if (output.join('').trim()) {
        appendMessage(systemMessage(output.join('').trimEnd()))
      }

      if (result.additionalDirectories) {
        setAdditionalDirectories(result.additionalDirectories)
      }

      if (result.exitRequested) {
        app.exit()
      }
    } catch (error) {
      appendMessage(errorMessage(error instanceof Error ? error.message : String(error)))
    }
  }

  const openResumePicker = async () => {
    const sessions = await listSessions(cwd)
    setResumeSessions(sessions)
    setResumeIndex(0)
    setResumeRestorePlans({})
    if (sessions.length === 0) {
      appendMessage(systemMessage('No sessions found.'))
      return
    }
    const previews = await Promise.all(
      sessions.slice(0, 10).map(async session => {
        try {
          return [session.id, (await replaySession(session)).restorePlan] as const
        } catch {
          return undefined
        }
      }),
    )
    setResumeRestorePlans(
      Object.fromEntries(
        previews.filter((preview): preview is readonly [string, SessionRestorePlan] =>
          Boolean(preview),
        ),
      ),
    )
  }

  const selectResumeSession = async (session: SessionMetadata) => {
    const replay = await replaySession(session)
    setSessionId(session.id)
    userContextRef.current = replay.summary
    hydratedMessagesRef.current = replay.providerMessages
    setResumeSessions(undefined)
    appendMessage(systemMessage(`Resumed ${session.id}`))
  }

  const forkResumeSession = async (session: SessionMetadata) => {
    const fork = await forkSession({
      cwd,
      sourceSessionId: session.id,
    })
    if (!fork) {
      appendMessage(errorMessage(`Could not fork ${session.id}`))
      return
    }

    appendMessage(systemMessage(`Forked ${session.id} -> ${fork.id}`))
    await selectResumeSession(fork)
  }

  const openCheckpointPicker = async (session: SessionMetadata) => {
    const checkpoints = await listSessionCheckpoints(session, 12)
    if (checkpoints.length === 0) {
      appendMessage(errorMessage(`No rewind checkpoint found for ${session.id}`))
      return
    }

    setResumeSessions(undefined)
    setCheckpointPicker({
      session,
      checkpoints,
    })
  }

  const rewindResumeSession = async (
    session: SessionMetadata,
    checkpoint: SessionCheckpoint,
  ) => {
    const fork = await forkSession({
      cwd,
      sourceSessionId: session.id,
      truncateAfterRecordId: checkpoint.recordId,
      mode: 'rewind',
    })
    if (!fork) {
      appendMessage(errorMessage(
        `Could not rewind ${session.id} at ${checkpoint.recordId}`,
      ))
      return
    }

    appendMessage(systemMessage(
      `Rewound ${session.id} at ${checkpoint.recordId} -> ${fork.id}`,
    ))
    setCheckpointPicker(undefined)
    await selectResumeSession(fork)
  }

  const rewindFilesForSession = async (
    session: SessionMetadata,
    checkpoint: SessionCheckpoint,
  ) => {
    try {
      const result = await rewindFilesToCheckpoint({
        cwd,
        session,
        checkpointRecordId: checkpoint.recordId,
      })
      appendMessage(systemMessage(
        `Rewound files at ${checkpoint.recordId}: ${
          result.restoredFiles.length > 0
            ? result.restoredFiles.join(', ')
            : '(none)'
        }`,
      ))
      if (result.missingSnapshots.length > 0) {
        appendMessage(errorMessage(
          `Missing snapshots: ${result.missingSnapshots.join(', ')}`,
        ))
      }
      if (result.worktreeConflicts.length > 0) {
        appendMessage(errorMessage(
          `Restored over uncommitted worktree changes: ${result.worktreeConflicts.join(', ')}`,
        ))
      }
      setCheckpointPicker(undefined)
    } catch (error) {
      appendMessage(errorMessage(
        error instanceof Error ? error.message : String(error),
      ))
    }
  }

  const selectResumeSessionById = async (id: string) => {
    const session = await resolveSession(cwd, id)
    if (!session) {
      appendMessage(errorMessage(`No session found: ${id}`))
      return
    }

    await selectResumeSession(session)
  }

  const handleResumePrompt = async (prompt: string) => {
    const parsed = parseTuiResumePrompt(prompt)
    if (!parsed) {
      await openResumePicker()
      return
    }

    const session = await resolveSession(cwd, parsed.sessionId)
    if (!session) {
      appendMessage(errorMessage(`No session found: ${parsed.sessionId}`))
      return
    }

    if (parsed.action === 'fork') {
      await forkResumeSession(session)
      return
    }

    if (parsed.action === 'checkpoints') {
      await openCheckpointPicker(session)
      return
    }

    if (parsed.action === 'rewind') {
      const recordId =
        parsed.recordId ?? (await listSessionCheckpoints(session, 2))[1]?.recordId
      if (!recordId) {
        appendMessage(errorMessage(`No rewind checkpoint found for ${session.id}`))
        return
      }

      await rewindResumeSession(session, {
        recordId,
        createdAt: '',
        eventType: 'manual',
        label: recordId,
      })
      return
    }

    if (parsed.action === 'rewind-files') {
      const recordId =
        parsed.recordId ?? (await listSessionCheckpoints(session, 2))[1]?.recordId
      if (!recordId) {
        appendMessage(errorMessage(`No file rewind checkpoint found for ${session.id}`))
        return
      }

      await rewindFilesForSession(session, {
        recordId,
        createdAt: '',
        eventType: 'manual',
        label: recordId,
      })
      return
    }

    await selectResumeSessionById(parsed.sessionId)
  }

  const submitPrompt = async (rawPrompt: string) => {
    const prompt = rawPrompt.trim()
    if (!prompt) {
      return
    }

    if (status === 'running' || status === 'aborting') {
      const command = createQueuedPromptCommand({
        id: randomUUID(),
        prompt,
      })
      setInput('')
      setInputCursor(0)
      setHistoryIndex(undefined)
      setQueuedPromptCommands(current =>
        enqueueQueuedPromptCommand(current, command),
      )
      appendMessage(systemMessage(`Queued prompt: ${prompt}`), {
        stickToLatest: false,
      })
      return
    }

    setInput('')
    setInputCursor(0)
    setHistory(current => [...current, prompt])
    setHistoryIndex(undefined)
    appendMessage({
      id: randomUUID(),
      role: 'user',
      text: prompt,
    })

    if (prompt.startsWith('/')) {
      if (prompt === '/help' || prompt.startsWith('/help ')) {
        setActiveScreen(buildHelpV2Screen({
          commandNames: SLASH_COMMAND_NAMES,
          descriptions: SLASH_COMMAND_DESCRIPTIONS,
          filter: prompt.replace(/^\/help\s*/, ''),
        }))
        return
      }

      if (prompt === '/resume') {
        await openResumePicker()
        return
      }

      if (prompt.startsWith('/resume ')) {
        await handleResumePrompt(prompt)
        return
      }

      if (prompt === '/doctor') {
        setActiveScreen(await collectDoctorScreen({
          cwd,
          version: props.options.version ?? '1.0.0',
          model: props.options.model ?? 'deepseek-v4-flash',
          permissionMode: props.options.permissionMode ?? 'default',
        }))
        return
      }

      if (prompt === '/settings') {
        setActiveScreen(await collectSettingsScreen({ cwd }))
        return
      }

      if (prompt === '/trust') {
        setActiveScreen(await collectTrustScreen(cwd))
        return
      }

      if (prompt === '/onboarding') {
        setActiveScreen(buildOnboardingScreen(cwd))
        return
      }

      if (prompt === '/wizard') {
        setActiveScreen(buildWizardScreen())
        return
      }

      if (prompt === '/sandbox') {
        setActiveScreen(await collectSandboxScreen(cwd))
        return
      }

      if (prompt === '/paste-image') {
        const image = await readImageFromSystemClipboard()
        if (image) {
          setClipboardImage(image)
          setPlatformCompletionSources(current => ({
            ...current,
            imageAttachments: uniqueRules([
              ...current.imageAttachments,
              'clipboard',
            ]),
          }))
          setInput('@image:clipboard ')
          setInputCursor('@image:clipboard '.length)
          appendMessage(systemMessage(
            `Pasted clipboard image (${image.mediaType}, ${image.byteLength} bytes).`,
          ))
          return
        }

        setActiveScreen(buildNativeImagePasteScreen({
          supported: Boolean(imageClipboardCommandForPlatform()),
          detail: 'no image bytes were available from the OS clipboard',
        }))
        return
      }

      if (prompt === '/theme') {
        const settings = await loadSettings(cwd)
        setThemePicker(settings.theme ?? 'default')
        return
      }

      await submitSlashCommand(prompt)
      if (prompt === '/voice' || prompt.startsWith('/voice ')) {
        await refreshVoiceMode()
      }
      if (prompt === '/vim' || prompt.startsWith('/vim ')) {
        const settings = await loadSettings(cwd)
        setVimMode(settings.vimMode ?? vimMode)
      }
      if (isThemeSetPrompt(prompt)) {
        const settings = await loadSettings(cwd)
        const theme = settings.theme ?? 'default'
        setActiveTheme(theme)
        setActiveScreen(buildThemeScreen(theme, 'Saved project theme.'))
      }
      return
    }

    const abortController = new AbortController()
    abortRef.current = abortController
    clearStreamingAssistant()
    setTurnWaitingState({
      startedAt: Date.now(),
      visibleText: false,
    })
    setStatus('running')

    try {
      for await (const event of queryRuntime({
        prompt,
        cwd,
        model: props.options.model,
        maxTurns: props.options.maxTurns ?? DEFAULT_INTERACTIVE_MAX_TURNS,
        permissionMode: props.options.permissionMode,
        systemPrompt: props.options.systemPrompt,
        appendSystemPrompt: props.options.appendSystemPrompt,
        allowedTools,
        disallowedTools,
        userContext: userContextRef.current,
        messages: hydratedMessagesRef.current,
        promptContent: buildPromptContent(prompt, clipboardImage),
        sessionId,
        transcriptPath: props.options.transcriptPath,
        additionalDirectories,
        signal: abortController.signal,
        permissionPrompt: ({ tool, input, reason }) =>
          new Promise(resolve => {
            setPermissionQueue(current => [...current, {
              id: randomUUID(),
              tool: tool.name,
              input,
              reason: reason ?? `${tool.name} requires permission`,
              resolve,
            }])
          }),
      })) {
        if (event.type === 'tool_execution_start') {
          continue
        }

        if (event.type === 'tool_execution_result') {
          if (event.permission_decision && event.permission_decision !== 'allow') {
            setPermissionNotice({
              tool: event.name,
              decision: event.permission_decision,
              reason: event.content,
            })
          }
          continue
        }

        if (event.type === 'terminal') {
          if (event.exitCode !== 0) {
            finalizeStreamingAssistant()
            appendMessage(errorMessage(event.reason ?? event.status), {
              stickToLatest: false,
            })
          }
          continue
        }

        const text = textDeltaFromEvent(event)
        if (text) {
          streamingAssistantTextRef.current += text
          setStreamingAssistantText(streamingAssistantTextRef.current)
          setTurnWaitingState(current =>
            current ? { ...current, visibleText: true } : current,
          )
        }
      }

      finalizeStreamingAssistant()
      const context = await sessionContextStats(cwd, sessionId)
      userContextRef.current = context?.summary ?? userContextRef.current
      setStatusStats(context?.stats)
    } catch (error) {
      finalizeStreamingAssistant()
      appendMessage(errorMessage(error instanceof Error ? error.message : String(error)), {
        stickToLatest: false,
      })
    } finally {
      clearStreamingAssistant()
      abortRef.current = undefined
      setStatus('idle')
      setTurnWaitingState(undefined)
      const nextQueued = dequeueNextQueuedPromptCommand(
        queuedPromptCommandsRef.current,
      )
      if (nextQueued.command) {
        const command = nextQueued.command
        setQueuedPromptCommands(nextQueued.queue)
        queueMicrotask(() => {
          void submitPrompt(command.prompt)
        })
      }
    }
  }

  const abortOrExit = () => {
    if (status === 'running') {
      setStatus('aborting')
      abortRef.current?.abort()
      return
    }

    app.exit()
  }

  const toggleVoiceRecording = async () => {
    try {
      if (voiceRecording?.status === 'recording') {
        const stopped = await stopVoiceRuntimeRecording({ sessionId: voiceRecording.id })
        setVoiceRecording(undefined)
        appendMessage(systemMessage(
          `Voice recording stopped (${stopped.bytes} bytes, ${stopped.rawPath}).`,
        ))
        return
      }
      const recording = await startVoiceRuntimeRecording(cwd, {})
      setVoiceRecording(recording)
      appendMessage(systemMessage(`Voice recording started (${recording.backend}).`))
    } catch (error) {
      appendMessage(errorMessage(error instanceof Error ? error.message : String(error)), {
        stickToLatest: false,
      })
    } finally {
      await refreshVoiceMode()
    }
  }

  useInput((_input, key) => {
    const mouse = parseSgrMouseEvent(_input)
    if (mouse) {
      if (mouse.type === 'wheelUp') {
        moveAppScrollByRows(-Math.max(3, Math.floor(viewportRows / 4)))
        return
      }

      if (mouse.type === 'wheelDown') {
        moveAppScrollByRows(Math.max(3, Math.floor(viewportRows / 4)))
        return
      }

      const hit = hitTestScreenRows(
        screenRows,
        screenPointFromTerminalMouse(mouse),
      )
      if (hit?.row.pane === 'prompt') {
        setScreenSelection(undefined)
        return
      }

      const point = hit ? selectablePointFromHit(hit) : undefined
      if (!point) {
        setScreenSelection(undefined)
        return
      }

      if (mouse.type === 'press') {
        setScreenSelection({ anchor: point, focus: point })
        return
      }

      if (mouse.type === 'drag') {
        setScreenSelection(current => ({
          anchor: current?.anchor ?? point,
          focus: point,
        }))
        return
      }

      if (mouse.type === 'release') {
        setScreenSelection(current => {
          if (
            !current ||
            (current.anchor.row === point.row &&
              current.anchor.column === point.column)
          ) {
            return undefined
          }

          const nextSelection = {
            anchor: current.anchor,
            focus: point,
          }
          const text = selectedScreenText(screenRows, nextSelection)
          if (text) {
            void copyTextToSystemClipboard(text)
          }
          return nextSelection
        })
        return
      }
    }

    if (key.escape && screenSelection) {
      setScreenSelection(undefined)
      return
    }

    if (key.pageUp) {
      moveAppScrollByRows(-viewportRows)
      return
    }

    if (key.pageDown) {
      moveAppScrollByRows(viewportRows)
      return
    }

  }, {
    isActive:
      !permissionRequest &&
      !resumeSessions &&
      !checkpointPicker &&
      !activeScreen &&
      !themePicker,
  })

  const resolvePermissionRequest = (
    request: QueuedPermissionRequest | undefined,
    decision: PermissionCheck,
  ) => {
    request?.resolve(decision)
    if (request) {
      setPermissionQueue(current => removePermissionRequest(current, request.id))
    }
  }

  const permissionRule = permissionRequest
    ? permissionRuleForRequest(permissionRequest)
    : undefined

  const allowPermissionOnce = () => {
    resolvePermissionRequest(permissionRequest, { decision: 'allow' })
  }

  const allowPermissionForSession = () => {
    const request = permissionRequest
    if (request) {
      const rule = permissionRuleForRequest(request)
      setAllowedTools(current => uniqueRules([...current, rule]))
      appendMessage(systemMessage(`Allowed ${summarizePermissionRule(rule)} for this session.`))
    }
    resolvePermissionRequest(request, { decision: 'allow' })
  }

  const allowPermissionPersistently = () => {
    const request = permissionRequest
    if (!request) {
      return
    }

    void persistPermissionRule(request, 'allowedTools', 'allow')
  }

  const denyPermissionOnce = () => {
    resolvePermissionRequest(permissionRequest, {
      decision: 'deny',
      reason: `Denied ${permissionRequest?.tool ?? 'tool'} by user`,
    })
  }

  const denyPermissionForSession = () => {
    const request = permissionRequest
    if (request) {
      const rule = permissionRuleForRequest(request)
      setDisallowedTools(current => uniqueRules([...current, rule]))
      appendMessage(systemMessage(`Denied ${summarizePermissionRule(rule)} for this session.`))
    }
    resolvePermissionRequest(request, {
      decision: 'deny',
      reason: `Denied ${request?.tool ?? 'tool'} by user`,
    })
  }

  const denyPermissionPersistently = () => {
    const request = permissionRequest
    if (!request) {
      return
    }

    void persistPermissionRule(request, 'disallowedTools', 'deny')
  }

  const persistPermissionRule = async (
    request: QueuedPermissionRequest,
    field: 'allowedTools' | 'disallowedTools',
    decision: 'allow' | 'deny',
  ) => {
    const rule = permissionRuleForRequest(request)
    try {
      await appendProjectSettingsRule(cwd, field, rule)
      if (field === 'allowedTools') {
        setAllowedTools(current => uniqueRules([...current, rule]))
        appendMessage(systemMessage(`Persistently allowed ${summarizePermissionRule(rule)}.`))
        resolvePermissionRequest(request, { decision: 'allow' })
        return
      }

      setDisallowedTools(current => uniqueRules([...current, rule]))
      appendMessage(systemMessage(`Persistently denied ${summarizePermissionRule(rule)}.`))
      resolvePermissionRequest(request, {
        decision: 'deny',
        reason: `Denied ${request.tool} by persistent rule`,
      })
    } catch (error) {
      appendMessage(errorMessage(
        `Could not update settings: ${error instanceof Error ? error.message : String(error)}`,
      ))
      if (decision === 'allow') {
        setAllowedTools(current => uniqueRules([...current, rule]))
        appendMessage(systemMessage(`Allowed ${summarizePermissionRule(rule)} for this session instead.`))
        resolvePermissionRequest(request, { decision: 'allow' })
        return
      }

      setDisallowedTools(current => uniqueRules([...current, rule]))
      appendMessage(systemMessage(`Denied ${summarizePermissionRule(rule)} for this session instead.`))
      resolvePermissionRequest(request, {
        decision: 'deny',
        reason: `Denied ${request.tool} by user`,
      })
    }
  }

  const allowPermissionQueueForSession = () => {
    const queue = [...permissionQueue]
    if (queue.length === 0) {
      return
    }

    const rules = permissionRulesForQueue(queue)
    setAllowedTools(current => uniqueRules([...current, ...rules]))
    appendMessage(systemMessage(`Allowed ${rules.length} queued permission rule${rules.length === 1 ? '' : 's'} for this session.`))
    resolvePermissionQueue(queue, () => ({ decision: 'allow' }))
    setPermissionQueue(current =>
      current.filter(request => !queue.some(queued => queued.id === request.id)),
    )
  }

  const denyPermissionQueueForSession = () => {
    const queue = [...permissionQueue]
    if (queue.length === 0) {
      return
    }

    const rules = permissionRulesForQueue(queue)
    setDisallowedTools(current => uniqueRules([...current, ...rules]))
    appendMessage(systemMessage(`Denied ${rules.length} queued permission rule${rules.length === 1 ? '' : 's'} for this session.`))
    resolvePermissionQueue(queue, request => ({
      decision: 'deny',
      reason: `Denied ${request.tool} by queued session rule`,
    }))
    setPermissionQueue(current =>
      current.filter(request => !queue.some(queued => queued.id === request.id)),
    )
  }

  const persistPermissionQueue = async (
    field: 'allowedTools' | 'disallowedTools',
  ) => {
    const queue = [...permissionQueue]
    if (queue.length === 0) {
      return
    }

    const rules = permissionRulesForQueue(queue)
    try {
      for (const rule of rules) {
        await appendProjectSettingsRule(cwd, field, rule)
      }

      if (field === 'allowedTools') {
        setAllowedTools(current => uniqueRules([...current, ...rules]))
        appendMessage(systemMessage(`Persistently allowed ${rules.length} queued permission rule${rules.length === 1 ? '' : 's'}.`))
        resolvePermissionQueue(queue, () => ({ decision: 'allow' }))
      } else {
        setDisallowedTools(current => uniqueRules([...current, ...rules]))
        appendMessage(systemMessage(`Persistently denied ${rules.length} queued permission rule${rules.length === 1 ? '' : 's'}.`))
        resolvePermissionQueue(queue, request => ({
          decision: 'deny',
          reason: `Denied ${request.tool} by persistent queued rule`,
        }))
      }

      setPermissionQueue(current =>
        current.filter(request => !queue.some(queued => queued.id === request.id)),
      )
    } catch (error) {
      appendMessage(errorMessage(
        `Could not update settings: ${error instanceof Error ? error.message : String(error)}`,
      ))
      if (field === 'allowedTools') {
        allowPermissionQueueForSession()
      } else {
        denyPermissionQueueForSession()
      }
    }
  }

  const updateInput = (value: string, cursor = value.length) => {
    setInput(value)
    setInputCursor(cursor)
  }

  const editQueuedPromptCommands = () => {
    const result = popAllEditableQueuedPromptCommands(
      queuedPromptCommandsRef.current,
      input,
      inputCursor,
    )
    if (!result) {
      return false
    }

    setQueuedPromptCommands(result.queue)
    updateInput(result.text, result.cursor)
    appendMessage(systemMessage(
      `Moved ${result.poppedCount} queued prompt${
        result.poppedCount === 1 ? '' : 's'
      } back to input.`,
    ))
    return true
  }

  const selectTheme = async (theme: ThemeName) => {
    const settings = await setProjectSetting(cwd, 'theme', theme)
    setActiveTheme(settings.theme ?? 'default')
    setThemePicker(undefined)
    setActiveScreen(buildThemeScreen(
      settings.theme ?? 'default',
      'Saved project theme.',
    ))
  }

  return (
    <ThemeProvider activeTheme={activeTheme} env={readThemeEnv()}>
      <TuiRuntimeProvider
        value={{
          ...props.options,
          additionalDirectories,
          allowedTools,
          disallowedTools,
        }}
      >
        <Box flexDirection="row" width="100%">
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            {visibleTranscriptRows > 0 ? (
              <MessageList
                messages={displayMessages}
                headerRows={statusHeaderRows}
                maxVisibleMessages={props.maxVisibleMessages ?? 20}
                maxVisibleRows={visibleTranscriptRows}
                columns={messageWindowColumns}
                scrollOffsetFromEnd={Math.max(
                  0,
                  transcriptRows - (transcriptWindowStart + visibleTranscriptRows),
                )}
                selection={screenSelection}
                startRow={messageScreenStartRow}
                selectionRows={screenRows}
              />
            ) : null}
            {isLoadingVisible && turnWaitingState ? (
              <LoadingIndicator startedAt={turnWaitingState.startedAt} />
            ) : null}
            <OverlayStack>
              <PermissionPanel
                request={permissionRequest}
                rule={permissionRule ? summarizePermissionRule(permissionRule) : undefined}
                queueCount={permissionQueue.length}
                notice={permissionNotice}
                onAllowOnce={allowPermissionOnce}
                onAllowSession={allowPermissionForSession}
                onAllowPersist={allowPermissionPersistently}
                onDenyOnce={denyPermissionOnce}
                onDenySession={denyPermissionForSession}
                onDenyPersist={denyPermissionPersistently}
                onAllowQueueSession={allowPermissionQueueForSession}
                onAllowQueuePersist={() => {
                  void persistPermissionQueue('allowedTools')
                }}
                onDenyQueueSession={denyPermissionQueueForSession}
                onDenyQueuePersist={() => {
                  void persistPermissionQueue('disallowedTools')
                }}
                onDismiss={() => setPermissionNotice(undefined)}
              />
              {activeScreen ? (
                <InfoScreen
                  screen={activeScreen}
                  onClose={() => setActiveScreen(undefined)}
                />
              ) : null}
              {resumeSessions ? (
                <ResumePicker
                  sessions={resumeSessions}
                  selectedIndex={resumeIndex}
                  restorePlans={resumeRestorePlans}
                  onSelectedIndexChange={setResumeIndex}
                  onSelect={selectResumeSession}
                  onFork={forkResumeSession}
                  onRewind={openCheckpointPicker}
                  onCancel={() => setResumeSessions(undefined)}
                />
              ) : null}
              {checkpointPicker ? (
                <CheckpointPicker
                  session={checkpointPicker.session}
                  checkpoints={checkpointPicker.checkpoints}
                  onRewind={checkpoint => {
                    void rewindResumeSession(checkpointPicker.session, checkpoint)
                  }}
                  onRewindFiles={checkpoint => {
                    void rewindFilesForSession(checkpointPicker.session, checkpoint)
                  }}
                  onCancel={() => setCheckpointPicker(undefined)}
                />
              ) : null}
              {themePicker ? (
                <ThemePicker
                  activeTheme={themePicker}
                  onSelect={theme => {
                    void selectTheme(theme)
                  }}
                  onCancel={() => setThemePicker(undefined)}
                />
              ) : null}
            </OverlayStack>
            {isPromptVisible ? (
            <PromptInput
              value={input}
              cursor={inputCursor}
              columns={messageWindowColumns}
              history={history}
              historyIndex={historyIndex}
              isRunning={status !== 'idle'}
              vimMode={vimMode}
              completionFilePaths={completionFilePaths}
              completionMcpResources={completionMcpResources}
              completionAgents={completionAgents}
              completionSlackChannels={platformCompletionSources.slackChannels}
              completionIdeMentions={platformCompletionSources.ideMentions}
              completionImageAttachments={platformCompletionSources.imageAttachments}
              completionVoiceActions={platformCompletionSources.voiceActions}
              voiceIndicator={voiceFooterIndicator(voiceMode, voiceRecording)}
              onVoiceShortcut={() => {
                void toggleVoiceRecording()
              }}
              completionQueuedCommands={[
                ...DEFAULT_QUEUED_COMMAND_COMPLETIONS,
                ...queuedPromptCommands.map(command => command.prompt),
              ]}
              editableQueuedCommandCount={editableQueuedPromptCommandCount(
                queuedPromptCommands,
              )}
              onEditQueuedCommands={editQueuedPromptCommands}
              completionPromptSuggestions={[
                'explain this repository',
                'run tests and summarize failures',
                'review the current git diff',
              ]}
              onChange={updateInput}
              onSubmit={submitPrompt}
              onHistoryIndexChange={setHistoryIndex}
              onAbort={abortOrExit}
              onExit={app.exit}
              onPermissionDismiss={() => setPermissionNotice(undefined)}
              onClipboardResult={result => {
                appendMessage(
                  result.ok
                    ? systemMessage(`Copied ${result.textLength} selected characters.`)
                    : errorMessage('System clipboard is unavailable for this terminal.'),
                )
              }}
              screenSelection={screenSelection}
              screenSelectionRows={screenRows}
              screenSelectionStartRow={promptScreenStartRow}
              screenSelectionText={screenSelectionText}
              onScreenSelectionCopy={result => {
                appendMessage(
                  result.ok
                    ? systemMessage(`Copied ${result.textLength} selected characters.`)
                    : errorMessage('System clipboard is unavailable for this terminal.'),
                )
                if (result.ok) {
                  setScreenSelection(undefined)
                }
              }}
              disabled={Boolean(
                permissionRequest ??
                  resumeSessions ??
                  checkpointPicker ??
                  activeScreen ??
                  themePicker,
              )}
            />
            ) : null}
          </Box>
          {appScrollBarRows ? <AppScrollBar rows={appScrollBarRows} /> : null}
        </Box>
      </TuiRuntimeProvider>
    </ThemeProvider>
  )
}

function uniqueRules(rules: string[]): string[] {
  return [...new Set(rules)]
}

type AppScrollBarRow = {
  id: string
  marker: string
}

function AppScrollBar(props: { rows: AppScrollBarRow[] }) {
  const theme = useTheme()
  return (
    <Box flexDirection="column" width={3} flexShrink={0}>
      {props.rows.map(row => (
        <Text key={row.id} color={theme.palette.muted} dimColor>
          {row.marker}
        </Text>
      ))}
    </Box>
  )
}

function renderAppScrollBarRows(args: {
  scrollTop: number
  scrollHeight: number
  viewportRows: number
  trackRows: number
}): AppScrollBarRow[] {
  const trackRows = Math.max(1, Math.floor(args.trackRows))
  const viewportRows = Math.max(1, Math.floor(args.viewportRows))
  const scrollHeight = Math.max(viewportRows, Math.ceil(args.scrollHeight))
  const maxScrollTop = Math.max(1, scrollHeight - viewportRows)
  const thumbRows = Math.max(
    1,
    Math.min(trackRows, Math.round((viewportRows / scrollHeight) * trackRows)),
  )
  const maxThumbTop = Math.max(0, trackRows - thumbRows)
  const thumbTop = Math.max(
    0,
    Math.min(
      maxThumbTop,
      Math.round((Math.max(0, args.scrollTop) / maxScrollTop) * maxThumbTop),
    ),
  )

  return Array.from({ length: trackRows }, (_, row) => {
    const marker = row >= thumbTop && row < thumbTop + thumbRows ? ' █ ' : '   '
    return {
      id: `app-scrollbar:${row}:${marker}`,
      marker,
    }
  })
}

function promptChromeRows(args: {
  input: string
  showLoadingIndicator: boolean
}): number {
  return 5 + (args.input.includes('\n') ? 1 : 0) + (args.showLoadingIndicator ? 1 : 0)
}

function voiceFooterIndicator(
  voiceMode: VoiceModeState | undefined,
  recording: VoiceRecordingSession | undefined,
): string {
  if (recording?.status === 'recording') {
    return 'voice:recording Ctrl+Space stop'
  }
  if (!voiceMode?.enabled) {
    return 'voice:off'
  }
  return `voice:${voiceMode.status} Ctrl+Space record`
}

export function buildPromptContent(
  prompt: string,
  clipboardImage: ClipboardImage | undefined,
): ContentBlock[] | undefined {
  if (!clipboardImage || !prompt.includes('@image:clipboard')) {
    return undefined
  }

  return [
    { type: 'text', text: prompt },
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: clipboardImage.mediaType,
        data: clipboardImage.dataBase64,
      },
    },
  ]
}

type TuiResumeAction = 'checkpoints' | 'fork' | 'rewind' | 'rewind-files'

export function parseTuiResumePrompt(prompt: string):
  | {
    sessionId: string
    action?: TuiResumeAction
    recordId?: string
  }
  | undefined {
  const [commandName, ...args] = prompt.trim().split(/\s+/)
  if (commandName !== '/resume') {
    return undefined
  }

  const sessionId = args.find(arg => !arg.startsWith('--'))
  if (!sessionId) {
    return undefined
  }

  const actionIndex = args.findIndex(arg =>
    arg === '--checkpoints' ||
    arg === '--fork' ||
    arg === '--rewind' ||
    arg === '--rewind-files',
  )
  if (actionIndex === -1) {
    return { sessionId }
  }

  const action = args[actionIndex].slice(2) as TuiResumeAction
  const recordId = args
    .slice(actionIndex + 1)
    .find(arg => !arg.startsWith('--'))
  return { sessionId, action, recordId }
}

function isThemeSetPrompt(prompt: string): boolean {
  const [commandName, themeName] = prompt.trim().split(/\s+/)
  return commandName === '/theme' && (
    themeName === 'default' ||
    themeName === 'dark' ||
    themeName === 'light' ||
    themeName === 'auto'
  )
}

function readThemeEnv(): Record<string, string | undefined> {
  return {
    COLORFGBG: process.env.COLORFGBG,
    COLORTERM: process.env.COLORTERM,
    TERM: process.env.TERM,
    TERM_PROGRAM: process.env.TERM_PROGRAM,
    LC_TERMINAL: process.env.LC_TERMINAL,
    TERMINAL_EMULATOR: process.env.TERMINAL_EMULATOR,
  }
}

function isWritableOutput(output: unknown): output is NodeJS.WritableStream {
  return Boolean(
    output &&
      typeof output === 'object' &&
      'write' in output &&
      typeof output.write === 'function',
  )
}

function hasResizeEvents(output: unknown): output is {
  on(event: 'resize', listener: () => void): void
  off(event: 'resize', listener: () => void): void
} {
  return Boolean(
    output &&
      typeof output === 'object' &&
      'on' in output &&
      typeof output.on === 'function' &&
      'off' in output &&
      typeof output.off === 'function',
  )
}

function LoadingIndicator(props: { startedAt: number }) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick(current => current + 1), 120)
    return () => clearInterval(timer)
  }, [])

  const frames = ['✶', '✻', '✽', '✸']
  const frame = frames[tick % frames.length] ?? '*'
  const elapsed = Math.max(0, Math.floor((Date.now() - props.startedAt) / 1000))
  return (
    <Text color="yellow">
      {frame} Thinking… ({elapsed}s)
    </Text>
  )
}

function completeStreamingLines(text: string): string | undefined {
  if (!text) {
    return undefined
  }

  const lastNewline = text.lastIndexOf('\n')
  if (lastNewline < 0) {
    return undefined
  }

  const completed = text.slice(0, lastNewline + 1).trimEnd()
  return completed ? completed : undefined
}

function messageListStatusRows(
  props: Parameters<typeof statusLineRows>[0],
): MessageListHeaderRow[] {
  return [
    ...statusLineRows(props).map((row, index) => ({
      id: `status:${index}:${row.text}`,
      art: row.art,
      text: row.text,
      strong: row.strong,
    })),
    {
      id: 'status:blank',
      text: '',
    },
  ]
}

function systemMessage(text: string): TuiMessage {
  return {
    id: randomUUID(),
    role: 'system',
    text,
  }
}

function startupMessage(cwd: string): string {
  return [
    '└ SessionStart:startup says: # my-claude-code status',
    '',
    'This project has no memory yet. The current session will seed it; subsequent sessions will receive auto-injected context for relevant past work.',
    '',
    'Memory injection starts on your second session in a project.',
    '',
    '`/learn-codebase` is available if you want to front-load the entire repo into memory in a single pass. Otherwise memory builds passively as work happens.',
    '',
    `Workspace: ${compactHomePath(cwd)}`,
    'How it works: `/help`',
  ].join('\n')
}

function compactHomePath(path: string): string {
  const home = process.env.HOME
  return home && path.startsWith(home)
    ? `~${path.slice(home.length)}`
    : path
}

function errorMessage(text: string): TuiMessage {
  return {
    id: randomUUID(),
    role: 'error',
    text,
  }
}
