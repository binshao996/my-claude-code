import {
  FakeRuntimeAdapter,
  createRuntimeClient,
} from "./runtime-client";
import {
  initialClientEventState,
  reduceRuntimeEvent,
} from "./event-state";
import { InMemorySessionStore } from "./session-store";
import {
  createWorkspace,
  toRuntimeWorkspaceContext,
} from "./workspace";

async function main(): Promise<void> {
  const workspace = createWorkspace({
    id: "workspace-demo",
    name: "Client Course Demo",
    rootPath: "/demo/client-course",
    openFiles: ["src/runtime-client.ts", "src/event-state.ts"],
  });

  const runtimeClient = createRuntimeClient(new FakeRuntimeAdapter());
  const sessionStore = new InMemorySessionStore();
  let state = initialClientEventState;

  const events = runtimeClient.send({
    prompt: "把 Runtime 事件流接到 Client 状态模型。",
    workspace: toRuntimeWorkspaceContext(workspace),
  });

  for await (const event of events) {
    state = reduceRuntimeEvent(state, event);
    console.log(`[${event.type}]`, JSON.stringify(state, null, 2));
  }

  if (state.session) {
    sessionStore.save({
      sessionId: state.session.sessionId,
      workspaceId: workspace.id,
      title: "Runtime event state demo",
      state,
      updatedAt: new Date().toISOString(),
    });
  }

  console.log("stored sessions:", sessionStore.listByWorkspace(workspace.id).length);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
});
