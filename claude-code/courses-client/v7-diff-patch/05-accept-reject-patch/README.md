# 05 - Accept / Reject Patch

## PR Scope

本章实现 `PatchDecisionBar`、Accept 和 Reject。Accept 只确认保留，Reject 用 `PatchSnapshotStore` 恢复 before content。

完成后，fake diff 可以直接点 Accept / Reject，UI 状态从 `pending` 变成 `accepted` 或 `rejected`。

## 文件路径

```text
claude-code-client/
  src/
    main/
      diff/
        PatchSnapshotStore.ts
        patchDecision.ts
    renderer/
      components/
        diff/
          PatchDecisionBar.tsx
      diff/
        fixtures/fakeRuntimeDiffEvent.ts
        DiffStore.ts
```

## Accept / Reject 主逻辑

文件：`src/main/diff/patchDecision.ts`

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DiffRecord } from "../../renderer/diff/types";
import type { PatchSnapshotStore } from "./PatchSnapshotStore";

export type Workspace = {
  rootPath: string;
};

function assertPathInsideWorkspace(workspace: Workspace, relativePath: string): string {
  const absolutePath = path.resolve(workspace.rootPath, relativePath);
  const rootPath = path.resolve(workspace.rootPath);

  if (!absolutePath.startsWith(`${rootPath}${path.sep}`) && absolutePath !== rootPath) {
    throw new Error(`path outside workspace: ${relativePath}`);
  }

  return absolutePath;
}

export function acceptPatch(record: DiffRecord): DiffRecord {
  if (record.decision.status !== "pending") return record;

  return {
    ...record,
    decision: {
      diffId: record.id,
      status: "accepted",
      decidedAt: Date.now(),
    },
  };
}

export async function rejectPatch(
  workspace: Workspace,
  record: DiffRecord,
  snapshots: PatchSnapshotStore,
): Promise<DiffRecord> {
  if (record.decision.status !== "pending") return record;

  const snapshot = snapshots.get(record.id);
  if (!snapshot || snapshot.files.length === 0) {
    throw new Error("snapshot missing");
  }

  for (const file of snapshot.files) {
    const absolutePath = assertPathInsideWorkspace(workspace, file.relativePath);
    await fs.writeFile(absolutePath, file.beforeContent, "utf8");
  }

  return {
    ...record,
    decision: {
      diffId: record.id,
      status: "rejected",
      decidedAt: Date.now(),
    },
  };
}
```

## PatchDecisionBar

文件：`src/renderer/components/diff/PatchDecisionBar.tsx`

```tsx
import type { DiffRecord } from "../../diff/types";

export function PatchDecisionBar({
  record,
  canReject = true,
  onAccept,
  onReject,
}: {
  record: DiffRecord;
  canReject?: boolean;
  onAccept?(record: DiffRecord): void;
  onReject?(record: DiffRecord): void;
}) {
  if (record.decision.status !== "pending") {
    return <span className={`patch-status patch-status-${record.decision.status}`}>{record.decision.status}</span>;
  }

  return (
    <div className="patch-decision-bar">
      <span className="patch-status patch-status-pending">pending</span>
      <button type="button" onClick={() => onAccept?.(record)}>
        Accept
      </button>
      <button type="button" disabled={!canReject} onClick={() => onReject?.(record)}>
        Reject
      </button>
    </div>
  );
}
```

## Store 更新

文件：`src/renderer/diff/DiffStore.ts`

```ts
import type { DiffState, DiffRecord } from "./types";

export function replaceRecordAfterDecision(state: DiffState, record: DiffRecord): DiffState {
  return {
    ...state,
    records: {
      ...state.records,
      [record.id]: record,
    },
    status: "reviewing",
    error: null,
  };
}
```

## 本章 Fake Decision Run

文件：`src/renderer/diff/fixtures/runFakePatchDecision.ts`

```ts
import { fakeRuntimeDiffEvent } from "./fakeRuntimeDiffEvent";
import { createPendingDiff } from "../DiffStore";
import { parseUnifiedDiff } from "../parseUnifiedDiff";
import { acceptPatch } from "../../../main/diff/patchDecision";
import { PatchSnapshotStore } from "../../../main/diff/PatchSnapshotStore";

export function runFakeAcceptDecision() {
  const parsed = parseUnifiedDiff(fakeRuntimeDiffEvent.rawPatch);
  if (!parsed.ok) throw new Error(parsed.message);

  const record = createPendingDiff(fakeRuntimeDiffEvent, parsed.files);
  return acceptPatch(record);
}

export function createFakeSnapshotStore(recordId: string) {
  const store = new PatchSnapshotStore();
  store.save({
    diffId: recordId,
    workspaceId: fakeRuntimeDiffEvent.workspaceId,
    files: fakeRuntimeDiffEvent.snapshots,
  });
  return store;
}
```

## Smoke Check

执行：

```bash
pnpm typecheck
pnpm test
pnpm dev
```

在 fake diff UI 上手动验证：

- 初始 `PatchDecisionBar` 显示 `pending`，按钮为 `Accept` 和 `Reject`。
- 点击 Accept 后，diff badge 从 `pending` 变成 `accepted`。
- Accept 后文件仍是 after 内容，不再次写文件。
- Accept 后按钮消失，只显示 `accepted` 状态。
- 重新加载 fake diff，点击 Reject 后文件恢复 snapshot 的 `beforeContent`。
- Reject 后 diff badge 从 `pending` 变成 `rejected`。
- snapshot 缺失时 Reject 按钮禁用，或点击后显示 `snapshot missing`。
- workspace 外路径抛出 `path outside workspace`，不能写入文件。
- 重复点击 Accept / Reject 不产生第二次 decision。

## 下一章

06 会在 Accept / Reject 后刷新 Editor，并写入 Agent Workspace timeline。
