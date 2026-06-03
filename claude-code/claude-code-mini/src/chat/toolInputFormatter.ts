const MAX_STRING_PREVIEW_CHARS = 240;
const MAX_FORMATTED_JSON_CHARS = 1_200;

export type ToolInputProgress = {
  activeToolUseId: string | null;
  nextNoticeLength: number;
};

const TOOL_INPUT_NOTICE_STEP = 1_024;

export function createToolInputProgress(): ToolInputProgress {
  return {
    activeToolUseId: null,
    nextNoticeLength: TOOL_INPUT_NOTICE_STEP,
  };
}

export function startToolInputProgress(
  progress: ToolInputProgress,
  toolUseId: string,
): void {
  progress.activeToolUseId = toolUseId;
  progress.nextNoticeLength = TOOL_INPUT_NOTICE_STEP;
}

export function shouldPrintToolInputProgress(
  progress: ToolInputProgress,
  toolUseId: string,
  inputJSONLength: number,
): boolean {
  if (progress.activeToolUseId !== toolUseId) {
    return false;
  }

  if (inputJSONLength < progress.nextNoticeLength) {
    return false;
  }

  while (progress.nextNoticeLength <= inputJSONLength) {
    progress.nextNoticeLength += TOOL_INPUT_NOTICE_STEP;
  }

  return true;
}

export function finishToolInputProgress(progress: ToolInputProgress): void {
  progress.activeToolUseId = null;
  progress.nextNoticeLength = TOOL_INPUT_NOTICE_STEP;
}

export function formatToolInput(input: Record<string, unknown>): string {
  const summarized = summarizeValue(input);
  const json = JSON.stringify(summarized);

  if (json.length <= MAX_FORMATTED_JSON_CHARS) {
    return json;
  }

  return `${json.slice(0, MAX_FORMATTED_JSON_CHARS)}... [truncated]`;
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return summarizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => summarizeValue(item));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, summarizeValue(item)]),
    );
  }

  return value;
}

function summarizeString(value: string): string {
  if (value.length <= MAX_STRING_PREVIEW_CHARS) {
    return value;
  }

  const preview = value.slice(0, MAX_STRING_PREVIEW_CHARS).trimEnd();
  return `${preview}... [truncated, ${value.length} chars total]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
