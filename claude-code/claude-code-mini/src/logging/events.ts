import { redactJson } from "./redact";

export type RuntimeEvent =
  | {
      type: "api_retry";
      data: {
        errorKind: string;
        attempt: number;
        maxRetries: number;
        retryInMs: number;
      };
    }
  | {
      type: "streaming_fallback";
      data: {
        reason: string;
      };
    }
  | {
      type: "model_fallback";
      data: {
        from: string;
        to: string;
        reason: string;
      };
    }
  | {
      type: "api_error";
      data: {
        kind: string;
        status?: number;
        model: string;
      };
    };

type EventListener = (event: RuntimeEvent) => void | Promise<void>;

const listeners = new Set<EventListener>();
const queuedEvents: RuntimeEvent[] = [];
let attached = false;

export function onRuntimeEvent(listener: EventListener): () => void {
  listeners.add(listener);
  attached = true;

  if (queuedEvents.length > 0) {
    const copy = queuedEvents.splice(0);
    queueMicrotask(() => {
      for (const event of copy) {
        emitRuntimeEvent(event);
      }
    });
  }

  return () => {
    listeners.delete(listener);
  };
}

export function emitRuntimeEvent(event: RuntimeEvent): void {
  const safeEvent = redactJson(event);

  if (!attached) {
    queuedEvents.push(safeEvent);
    return;
  }

  for (const listener of listeners) {
    void listener(safeEvent);
  }
}

/** Reset all state — for testing only. */
export function resetEventBus(): void {
  listeners.clear();
  queuedEvents.length = 0;
  attached = false;
}
