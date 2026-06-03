import type { CommandResult } from "./types";

type RunCommandOptions = {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
};

type LimitedText = {
  text: string;
  truncated: boolean;
};

export async function runCommand(
  command: string,
  options: RunCommandOptions,
): Promise<CommandResult> {
  const startedAt = Date.now();
  const abortController = new AbortController();
  let timedOut = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, options.timeoutMs);

  const proc = Bun.spawn(["bash", "-lc", command], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal: abortController.signal,
  });

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readLimitedText(proc.stdout, options.maxOutputBytes),
      readLimitedText(proc.stderr, options.maxOutputBytes),
      proc.exited,
    ]);

    return {
      command,
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      durationMs: Date.now() - startedAt,
      truncated: stdout.truncated || stderr.truncated,
    };
  } catch (error) {
    if (timedOut) {
      throw new Error(`Command timed out after ${options.timeoutMs}ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readLimitedText(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<LimitedText> {
  if (!stream) {
    return { text: "", truncated: false };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let seenBytes = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const remaining = maxBytes - seenBytes;

    if (remaining > 0) {
      chunks.push(value.slice(0, remaining));
    }

    seenBytes += value.byteLength;

    if (seenBytes > maxBytes) {
      truncated = true;
    }
  }

  const text = new TextDecoder().decode(joinChunks(chunks));
  return { text, truncated };
}

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}
