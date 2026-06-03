import type { RuntimeWorkspaceContext } from "./workspace";

export type RuntimeUserInput = {
  prompt: string;
  workspace: RuntimeWorkspaceContext;
};

export type RuntimeSessionInfo = {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
};

export type RuntimeEvent =
  | {
      type: "session_started";
      session: RuntimeSessionInfo;
    }
  | {
      type: "turn_started";
      turnId: string;
      prompt: string;
    }
  | {
      type: "assistant_delta";
      messageId: string;
      text: string;
    }
  | {
      type: "tool_started";
      toolCallId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_finished";
      toolCallId: string;
      ok: boolean;
      output: string;
    }
  | {
      type: "context_updated";
      cwd: string;
      openFiles: string[];
    }
  | {
      type: "turn_finished";
      turnId: string;
    };

export interface RuntimeAdapter {
  startSession(input: RuntimeUserInput): AsyncGenerator<RuntimeEvent, void>;
}

export interface RuntimeClient {
  send(input: RuntimeUserInput): AsyncGenerator<RuntimeEvent, void>;
}

export function createRuntimeClient(adapter: RuntimeAdapter): RuntimeClient {
  return {
    send(input) {
      return adapter.startSession(input);
    },
  };
}

export class FakeRuntimeAdapter implements RuntimeAdapter {
  async *startSession(input: RuntimeUserInput): AsyncGenerator<RuntimeEvent, void> {
    const session: RuntimeSessionInfo = {
      sessionId: "demo-session-001",
      transcriptPath: `${input.workspace.rootPath}/.client-demo/transcript.jsonl`,
      cwd: input.workspace.rootPath,
    };

    yield {
      type: "session_started",
      session,
    };

    yield {
      type: "turn_started",
      turnId: "turn-001",
      prompt: input.prompt,
    };

    yield {
      type: "assistant_delta",
      messageId: "assistant-001",
      text: "我会先检查工作区上下文，",
    };

    yield {
      type: "tool_started",
      toolCallId: "tool-001",
      name: "read_workspace",
      input: {
        cwd: input.workspace.rootPath,
        openFiles: input.workspace.openFiles,
      },
    };

    yield {
      type: "context_updated",
      cwd: input.workspace.rootPath,
      openFiles: input.workspace.openFiles,
    };

    yield {
      type: "tool_finished",
      toolCallId: "tool-001",
      ok: true,
      output: "workspace context loaded",
    };

    yield {
      type: "assistant_delta",
      messageId: "assistant-001",
      text: "然后把 Runtime 事件转成 Client 状态。",
    };

    yield {
      type: "turn_finished",
      turnId: "turn-001",
    };
  }
}
