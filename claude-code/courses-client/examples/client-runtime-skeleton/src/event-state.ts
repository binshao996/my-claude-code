import type { RuntimeEvent, RuntimeSessionInfo } from "./runtime-client";

export type ClientMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "complete";
};

export type ToolActivity = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output: string | null;
  status: "running" | "success" | "error";
};

export type ClientEventState = {
  session: RuntimeSessionInfo | null;
  activeTurnId: string | null;
  isRunning: boolean;
  messages: ClientMessage[];
  activities: ToolActivity[];
  context: {
    cwd: string | null;
    openFiles: string[];
  };
};

export const initialClientEventState: ClientEventState = {
  session: null,
  activeTurnId: null,
  isRunning: false,
  messages: [],
  activities: [],
  context: {
    cwd: null,
    openFiles: [],
  },
};

export function reduceRuntimeEvent(state: ClientEventState, event: RuntimeEvent): ClientEventState {
  switch (event.type) {
    case "session_started":
      return {
        ...state,
        session: event.session,
        context: {
          ...state.context,
          cwd: event.session.cwd,
        },
      };

    case "turn_started":
      return {
        ...state,
        activeTurnId: event.turnId,
        isRunning: true,
        messages: [
          ...state.messages,
          {
            id: `user-${event.turnId}`,
            role: "user",
            content: event.prompt,
            status: "complete",
          },
        ],
      };

    case "assistant_delta":
      return {
        ...state,
        messages: appendAssistantDelta(state.messages, event.messageId, event.text),
      };

    case "tool_started":
      return {
        ...state,
        activities: [
          ...state.activities,
          {
            id: event.toolCallId,
            name: event.name,
            input: event.input,
            output: null,
            status: "running",
          },
        ],
      };

    case "tool_finished":
      return {
        ...state,
        activities: state.activities.map((activity) =>
          activity.id === event.toolCallId
            ? {
                ...activity,
                output: event.output,
                status: event.ok ? "success" : "error",
              }
            : activity,
        ),
      };

    case "context_updated":
      return {
        ...state,
        context: {
          cwd: event.cwd,
          openFiles: event.openFiles,
        },
      };

    case "turn_finished":
      return {
        ...state,
        activeTurnId: null,
        isRunning: false,
        messages: state.messages.map((message) =>
          message.role === "assistant" && message.status === "streaming"
            ? {
                ...message,
                status: "complete",
              }
            : message,
        ),
      };
  }
}

function appendAssistantDelta(messages: ClientMessage[], messageId: string, text: string): ClientMessage[] {
  const existing = messages.find((message) => message.id === messageId);

  if (!existing) {
    return [
      ...messages,
      {
        id: messageId,
        role: "assistant",
        content: text,
        status: "streaming",
      },
    ];
  }

  return messages.map((message) =>
    message.id === messageId
      ? {
          ...message,
          content: `${message.content}${text}`,
        }
      : message,
  );
}
