import type { RuntimeAdapter, RuntimeEvent, RuntimeUserInput } from "../domain";

const delay = (ms: number) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

export class FakeRuntimeAdapter implements RuntimeAdapter {
  async *startSession(input: RuntimeUserInput): AsyncGenerator<RuntimeEvent, void> {
    const sessionId = `client-${Date.now().toString(36)}`;

    yield {
      type: "session_started",
      session: {
        sessionId,
        transcriptPath: `${input.cwd}/.client/transcripts/${sessionId}.jsonl`,
        cwd: input.cwd,
      },
    };

    await delay(180);
    yield {
      type: "turn_started",
      turnId: "turn-enterprise-001",
      prompt: input.prompt,
    };

    await delay(220);
    yield {
      type: "plan_updated",
      items: [
        { id: "p1", title: "绑定 workspace cwd 与 open files", status: "done" },
        { id: "p2", title: "通过 tool timeline 暴露 Runtime 行为", status: "running" },
        { id: "p3", title: "生成 patch 并等待权限治理", status: "pending" },
      ],
    };

    await delay(180);
    yield {
      type: "assistant_delta",
      messageId: "assistant-enterprise-001",
      text: "我会按 Client 教程链路处理：先读取 workspace，",
    };

    await delay(180);
    yield {
      type: "tool_started",
      toolCallId: "tool-read-workspace",
      name: "read_workspace",
      input: {
        cwd: input.cwd,
        openFiles: input.openFiles,
      },
    };

    await delay(260);
    yield {
      type: "tool_finished",
      toolCallId: "tool-read-workspace",
      ok: true,
      output: "workspace context loaded",
    };

    await delay(180);
    yield {
      type: "assistant_delta",
      messageId: "assistant-enterprise-001",
      text: "再生成可审计 diff，并把写入动作放进权限队列。",
    };

    await delay(240);
    yield {
      type: "permission_requested",
      request: {
        id: "perm-write-file",
        toolName: "write_file",
        reason: "Agent 准备写入 src/App.tsx，需要按企业策略审批",
        risk: "medium",
        status: "pending",
      },
    };

    await delay(220);
    yield {
      type: "diff_ready",
      diff: {
        id: "diff-runtime",
        filePath: "src/App.tsx",
        title: "Wire enterprise governance status",
        before: `const status = "runtime-ready";`,
        after: `const status = "runtime-ready";\nconst governance = "policy-reviewed";`,
        status: "pending",
      },
    };

    await delay(160);
    yield {
      type: "terminal_output",
      commandId: "agent-check",
      chunk: "agent check queued: pnpm typecheck",
    };

    await delay(180);
    yield {
      type: "audit_event",
      event: {
        id: "audit-runtime",
        actor: "runtime",
        action: "emitted_diff",
        target: "src/App.tsx",
        at: new Date().toISOString().slice(0, 19).replace("T", " "),
        severity: "review",
      },
    };

    await delay(180);
    yield {
      type: "turn_finished",
      turnId: "turn-enterprise-001",
    };
  }
}
