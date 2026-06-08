import { onRuntimeEvent } from "./events";
import { writeDebugLog } from "./debugLog";
import { recordTranscriptEvent } from "../transcript/store";

export function installRuntimeEventSinks(): void {
  onRuntimeEvent(event => {
    void recordTranscriptEvent({
      event: event.type,
      data: event.data,
    });

    if (event.type === "api_retry") {
      void writeDebugLog(
        "warn",
        `api_retry errorKind=${event.data.errorKind} attempt=${event.data.attempt} retryInMs=${event.data.retryInMs}`,
      );
      return;
    }

    if (event.type === "model_fallback") {
      void writeDebugLog(
        "warn",
        `model_fallback from=${event.data.from} to=${event.data.to} reason=${event.data.reason}`,
      );
      return;
    }

    void writeDebugLog("info", `${event.type} ${JSON.stringify(event.data)}`);
  });
}
