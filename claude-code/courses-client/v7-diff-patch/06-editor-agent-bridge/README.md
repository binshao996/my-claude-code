# 06 - Editor / Agent Bridge

## PR Scope

本章把 patch decision 接到 Editor 和 Agent Workspace：Accept / Reject 完成后刷新受影响 editor tab，并写入 timeline entry。

完成后，fake decision 也能看到 `Patch accepted` / `Patch rejected` timeline entry 和 editor refresh 记录。

## 文件路径

```text
claude-code-client/
  src/
    renderer/
      editor/
        refreshEditorsAfterPatch.ts
      workspace/
        patchTimeline.ts
      diff/
        fixtures/fakeRuntimeDiffEvent.ts
        DiffStore.ts
    main/
      diff/
        patchDecision.ts
```

## Editor Refresh Bridge

文件：`src/renderer/editor/refreshEditorsAfterPatch.ts`

```ts
import type { DiffRecord } from "../diff/types";

export type EditorRefreshApi = {
  isDirty(relativePath: string): boolean;
  reloadFile(relativePath: string): Promise<void>;
  showBlockingMessage(message: string): void;
};

export async function refreshEditorsAfterPatch(
  editorApi: EditorRefreshApi,
  record: DiffRecord,
): Promise<void> {
  for (const file of record.files) {
    if (editorApi.isDirty(file.newPath)) {
      editorApi.showBlockingMessage(
        `${file.newPath} has unsaved changes. Save or discard them before refreshing.`,
      );
      throw new Error(`dirty buffer: ${file.newPath}`);
    }
  }

  for (const file of record.files) {
    await editorApi.reloadFile(file.newPath);
  }
}
```

## Patch Audit 和 Timeline

文件：`src/renderer/workspace/patchTimeline.ts`

```ts
import type { DiffRecord } from "../diff/types";

export type PatchAuditRecord = {
  id: string;
  diffId: string;
  workspaceId: string;
  sessionId: string;
  decision: "accepted" | "rejected";
  files: string[];
  decidedAt: number;
};

export function createPatchAuditRecord(record: DiffRecord): PatchAuditRecord {
  if (record.decision.status === "pending" || record.decision.decidedAt === null) {
    throw new Error("patch decision is still pending");
  }

  return {
    id: `patch-audit:${record.id}`,
    diffId: record.id,
    workspaceId: record.source.workspaceId,
    sessionId: record.source.sessionId,
    decision: record.decision.status,
    files: record.files.map(file => file.newPath),
    decidedAt: record.decision.decidedAt,
  };
}

export function patchDecisionToTimelineEvent(audit: PatchAuditRecord) {
  return {
    id: `timeline:${audit.id}`,
    type: "patch.decision" as const,
    title: `Patch ${audit.decision}`,
    detail: audit.files.join(", "),
    badge: audit.decision,
    createdAt: audit.decidedAt,
  };
}
```

## 决策后串联

文件：`src/renderer/diff/completePatchDecision.ts`

```ts
import type { DiffRecord } from "./types";
import type { EditorRefreshApi } from "../editor/refreshEditorsAfterPatch";
import { refreshEditorsAfterPatch } from "../editor/refreshEditorsAfterPatch";
import { createPatchAuditRecord, patchDecisionToTimelineEvent } from "../workspace/patchTimeline";

export async function completePatchDecision({
  record,
  editorApi,
  addTimelineEntry,
}: {
  record: DiffRecord;
  editorApi: EditorRefreshApi;
  addTimelineEntry(event: ReturnType<typeof patchDecisionToTimelineEvent>): void;
}) {
  await refreshEditorsAfterPatch(editorApi, record);

  const audit = createPatchAuditRecord(record);
  addTimelineEntry(patchDecisionToTimelineEvent(audit));

  return audit;
}
```

## Service / Store / UI Skeleton

本章的骨架不是新增一个独立页面，而是把三处已有状态串起来：

- service：`completePatchDecision()` 负责执行刷新和 audit 串联。
- store：`DiffStore` 保存最终 decision，Agent Workspace timeline 接收 `patch.decision`。
- UI：`DiffPanel` 的 decision badge 变化后，Editor tab 显示 refreshed 状态。

## 本章 Fake Bridge Run

文件：`src/renderer/diff/fixtures/runFakeEditorBridge.ts`

```ts
import type { EditorRefreshApi } from "../../editor/refreshEditorsAfterPatch";
import type { DiffRecord } from "../types";
import { completePatchDecision } from "../completePatchDecision";

export function createFakeEditorApi(): EditorRefreshApi & { reloaded: string[]; messages: string[] } {
  return {
    reloaded: [],
    messages: [],
    isDirty: () => false,
    async reloadFile(relativePath) {
      this.reloaded.push(relativePath);
    },
    showBlockingMessage(message) {
      this.messages.push(message);
    },
  };
}

export async function runFakeEditorBridge(record: DiffRecord) {
  const editorApi = createFakeEditorApi();
  const timeline: unknown[] = [];
  const audit = await completePatchDecision({
    record,
    editorApi,
    addTimelineEntry: event => timeline.push(event),
  });

  return { audit, reloaded: editorApi.reloaded, timeline };
}
```

## Smoke Check

执行：

```bash
pnpm typecheck
pnpm test
pnpm dev
```

完成一次 fake Accept 或 Reject 后，必须看到：

- Editor refresh log 包含 `src/app.ts`。
- 已打开的 editor tab 内容刷新到磁盘最新状态。
- dirty buffer 场景显示阻断提示：`src/app.ts has unsaved changes...`。
- dirty buffer 时不调用 `reloadFile`，不覆盖用户未保存内容。
- Agent Workspace timeline 新增 `Patch accepted` 或 `Patch rejected`。
- timeline entry badge 显示 `accepted` 或 `rejected`。
- `PatchAuditRecord.files` 包含 `src/app.ts`。
- Session timeline 可以读取 `workspaceId=workspace-demo` 和 `sessionId=session-demo`。

## V8 预告

V8 会把 Chat、Plan、Tool Timeline、Diff Decisions 统一纳入 Multi Session。V7 的输出就是 V8 可以消费的 `PatchAuditRecord` 和 `patch.decision` timeline event。
