# 02 - Diff 数据模型

## PR Scope

本章把 01 的 `RuntimeDiffEvent` 存成稳定状态：`DiffStore` 管 UI，`PatchSnapshotStore` 管 Reject 需要的 before / after 内容。

完成后，fake event 不需要 parser，也能在调试面板看到 pending diff、file list 和 snapshot。

## 文件路径

```text
claude-code-client/
  src/
    main/
      diff/
        PatchSnapshotStore.ts
    renderer/
      diff/
        fixtures/fakeRuntimeDiffEvent.ts
        types.ts
        DiffStore.ts
        selectors.ts
```

## Types

文件：`src/renderer/diff/types.ts`

```ts
export type DiffLineType = "context" | "add" | "remove";
export type PatchDecisionStatus = "pending" | "accepted" | "rejected";

export type DiffLine = {
  id: string;
  type: DiffLineType;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
};

export type DiffHunk = {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type DiffFile = {
  id: string;
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
  additions: number;
  removals: number;
};

export type PatchDecision = {
  diffId: string;
  status: PatchDecisionStatus;
  decidedAt: number | null;
};

export type DiffSource = {
  workspaceId: string;
  sessionId: string;
  toolUseId: string;
  toolName: string;
};

export type DiffRecord = {
  id: string;
  source: DiffSource;
  files: DiffFile[];
  rawPatch: string;
  decision: PatchDecision;
  createdAt: number;
};
```

## PatchSnapshotStore

文件：`src/main/diff/PatchSnapshotStore.ts`

```ts
import type { RuntimeDiffSnapshotFile } from "../../renderer/diff/types";

export type PatchSnapshot = {
  diffId: string;
  workspaceId: string;
  files: RuntimeDiffSnapshotFile[];
};

export class PatchSnapshotStore {
  private snapshots = new Map<string, PatchSnapshot>();

  save(snapshot: PatchSnapshot): void {
    this.snapshots.set(snapshot.diffId, snapshot);
  }

  get(diffId: string): PatchSnapshot | null {
    return this.snapshots.get(diffId) ?? null;
  }

  hasAllFiles(diffId: string): boolean {
    const snapshot = this.snapshots.get(diffId);
    return Boolean(snapshot && snapshot.files.length > 0);
  }
}
```

## DiffStore

文件：`src/renderer/diff/DiffStore.ts`

```ts
import type { DiffFile, DiffRecord, PatchDecisionStatus, RuntimeDiffEvent } from "./types";

export type DiffState = {
  records: Record<string, DiffRecord>;
  activeDiffId: string | null;
  status: "idle" | "reviewing" | "applying" | "error";
  error: string | null;
};

export const initialDiffState: DiffState = {
  records: {},
  activeDiffId: null,
  status: "idle",
  error: null,
};

export function createPendingDiff(event: RuntimeDiffEvent, files: DiffFile[]): DiffRecord {
  const diffId = `diff:${event.toolUseId}`;

  return {
    id: diffId,
    source: {
      workspaceId: event.workspaceId,
      sessionId: event.sessionId,
      toolUseId: event.toolUseId,
      toolName: event.toolName,
    },
    files,
    rawPatch: event.rawPatch,
    decision: {
      diffId,
      status: "pending",
      decidedAt: null,
    },
    createdAt: event.createdAt,
  };
}

export function addPendingDiff(state: DiffState, record: DiffRecord): DiffState {
  return {
    ...state,
    records: { ...state.records, [record.id]: record },
    activeDiffId: record.id,
    status: "reviewing",
    error: null,
  };
}

export function markDecision(
  state: DiffState,
  diffId: string,
  status: Exclude<PatchDecisionStatus, "pending">,
): DiffState {
  const record = state.records[diffId];
  if (!record || record.decision.status !== "pending") return state;

  return {
    ...state,
    records: {
      ...state.records,
      [diffId]: {
        ...record,
        decision: { diffId, status, decidedAt: Date.now() },
      },
    },
  };
}

export function setPatchError(state: DiffState, message: string): DiffState {
  return { ...state, status: "error", error: message };
}
```

## 本章 Fake Files

parser 还没实现，本章先从 fake event 的 snapshots 生成 file list。

文件：`src/renderer/diff/fixtures/fakeDiffFiles.ts`

```ts
import type { DiffFile } from "../types";

export const fakeDiffFiles: DiffFile[] = [
  {
    id: "file:src/app.ts",
    oldPath: "src/app.ts",
    newPath: "src/app.ts",
    additions: 2,
    removals: 1,
    hunks: [],
  },
];
```

文件：`src/renderer/diff/fixtures/loadFakeDiffRecord.ts`

```ts
import { fakeRuntimeDiffEvent } from "./fakeRuntimeDiffEvent";
import { fakeDiffFiles } from "./fakeDiffFiles";
import { addPendingDiff, createPendingDiff, initialDiffState } from "../DiffStore";
import { PatchSnapshotStore } from "../../../main/diff/PatchSnapshotStore";

export function loadFakeDiffRecord() {
  const record = createPendingDiff(fakeRuntimeDiffEvent, fakeDiffFiles);
  const snapshots = new PatchSnapshotStore();

  snapshots.save({
    diffId: record.id,
    workspaceId: fakeRuntimeDiffEvent.workspaceId,
    files: fakeRuntimeDiffEvent.snapshots,
  });

  return {
    state: addPendingDiff(initialDiffState, record),
    snapshots,
  };
}
```

## Smoke Check

执行：

```bash
pnpm typecheck
pnpm test
pnpm dev
```

调用 `loadFakeDiffRecord()` 后，必须看到：

- diff badge 显示 `pending`。
- store dev panel 里 `state.activeDiffId=diff:toolu_demo_edit_001`。
- file list 显示 `src/app.ts`，统计为 `+2 -1`。
- `state.records[state.activeDiffId].decision.status` 是 `pending`。
- `snapshots.get(state.activeDiffId)` 能读到 `beforeContent` 和 `afterContent`。
- 切换 workspace 后，`workspace-demo` 之外的 active diff 不展示。
- snapshot 缺失时，Reject 入口显示 `snapshot missing`，不能继续执行。

## 下一章

03 会实现 `parseUnifiedDiff(rawPatch)`，把 fake rawPatch 解析成 hunk rows。
