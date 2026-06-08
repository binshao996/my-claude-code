import { FakeRuntimeAdapter } from "../runtime/fakeRuntime";
import { clientReducer, createInitialClientState } from "../store/clientStore";
import type { ClientState } from "../domain";

async function main() {
  const runtime = new FakeRuntimeAdapter();
  let state: ClientState = createInitialClientState();

  for await (const event of runtime.startSession({
    prompt: "smoke check enterprise client flow",
    cwd: "/tmp/claude-code-client",
    openFiles: ["src/App.tsx"],
  })) {
    state = clientReducer(state, { type: "runtime_event", event });
  }

  assert(state.chat.messages.some((message) => message.role === "assistant" && message.status === "complete"), "assistant message completed");
  assert(state.diff.proposals.some((proposal) => proposal.id === "diff-runtime"), "runtime diff proposal exists");
  assert(state.agent.permissions.some((permission) => permission.id === "perm-write-file"), "permission request exists");
  assert(state.governance.audits.some((audit) => audit.id === "audit-runtime"), "runtime audit exists");
  assert(!state.runtime.isRunning, "runtime is idle after turn");

  console.log("smoke ok: runtime event stream updates chat, diff, permission, audit");
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Smoke check failed: ${message}`);
  }
}

void main();
