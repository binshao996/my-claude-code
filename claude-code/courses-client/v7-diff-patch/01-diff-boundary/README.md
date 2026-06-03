# 01 - Diff 边界

## PR Scope

本章只做 Runtime diff 捕获，不实现 parser 和 viewer。

完成后，即使 Runtime 没有真实写文件，也能用 fake event 在 Agent Workspace 看到一条 `Diff captured` timeline entry，并看到 diff badge。

## 文件路径

```text
claude-code-client/
  src/
    main/
      diff/
        PatchService.ts
    renderer/
      diff/
        fixtures/fakeRuntimeDiffEvent.ts
        types.ts
        DiffStore.ts
    workspace/
      patchTimeline.ts
```

## Runtime Diff Event 类型

文件：`src/renderer/diff/types.ts`

```ts
export type RuntimeDiffSnapshotFile = {
  relativePath: string;
  beforeContent: string;
  afterContent: string;
};

export type RuntimeDiffEvent = {
  type: "runtime.tool_result";
  workspaceId: string;
  sessionId: string;
  toolUseId: string;
  toolName: string;
  createdAt: number;
  rawPatch: string;
  snapshots: RuntimeDiffSnapshotFile[];
};
```

## 本章 Fake Event

文件：`src/renderer/diff/fixtures/fakeRuntimeDiffEvent.ts`

```ts
import type { RuntimeDiffEvent } from "../types";

export const fakeRuntimeDiffEvent: RuntimeDiffEvent = {
  type: "runtime.tool_result",
  workspaceId: "workspace-demo",
  sessionId: "session-demo",
  toolUseId: "toolu_demo_edit_001",
  toolName: "edit_file",
  createdAt: 1_700_000_000_000,
  rawPatch: [
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,4 +1,5 @@",
    " export function title() {",
    '-  return "Claude Code Mini";',
    '+  return "Claude Code Client";',
    " }",
    "+export const diffEnabled = true;",
  ].join("\n"),
  snapshots: [
    {
      relativePath: "src/app.ts",
      beforeContent: 'export function title() {\n  return "Claude Code Mini";\n}\n',
      afterContent:
        'export function title() {\n  return "Claude Code Client";\n}\nexport const diffEnabled = true;\n',
    },
  ],
};
```

## PatchService 捕获边界

文件：`src/main/diff/PatchService.ts`

```ts
import type { RuntimeDiffEvent } from "../../renderer/diff/types";

type RuntimeToolResult = {
  workspaceId: string;
  sessionId: string;
  toolUseId: string;
  toolName: string;
  diff?: string;
  snapshots?: RuntimeDiffEvent["snapshots"];
};

export function captureRuntimeDiff(result: RuntimeToolResult): RuntimeDiffEvent | null {
  if (!result.diff) return null;

  return {
    type: "runtime.tool_result",
    workspaceId: result.workspaceId,
    sessionId: result.sessionId,
    toolUseId: result.toolUseId,
    toolName: result.toolName,
    createdAt: Date.now(),
    rawPatch: result.diff,
    snapshots: result.snapshots ?? [],
  };
}
```

## Timeline Entry

文件：`src/workspace/patchTimeline.ts`

```ts
import type { RuntimeDiffEvent } from "../renderer/diff/types";

export function diffCapturedToTimelineEvent(event: RuntimeDiffEvent) {
  const fileCount = event.snapshots.length;

  return {
    id: `diff-captured:${event.toolUseId}`,
    type: "diff.captured" as const,
    title: "Diff captured",
    detail: `${fileCount} file${fileCount === 1 ? "" : "s"} from ${event.toolName}`,
    badge: "pending",
    createdAt: event.createdAt,
  };
}
```

## Demo 接入

文件：`src/renderer/diff/DiffStore.ts`

```ts
import { fakeRuntimeDiffEvent } from "./fixtures/fakeRuntimeDiffEvent";
import { diffCapturedToTimelineEvent } from "../workspace/patchTimeline";

export function loadFakeDiffForChapter01(addTimelineEntry: (entry: ReturnType<typeof diffCapturedToTimelineEvent>) => void) {
  const timelineEntry = diffCapturedToTimelineEvent(fakeRuntimeDiffEvent);
  addTimelineEntry(timelineEntry);
}
```

## Smoke Check

执行：

```bash
pnpm typecheck
pnpm test
pnpm dev
```

在 demo 按钮或 dev console 调用 `loadFakeDiffForChapter01(addTimelineEntry)` 后，必须看到：

- Agent Workspace timeline 新增 `Diff captured`。
- timeline entry 上有 diff badge：`pending`。
- entry detail 显示 `1 file from edit_file`。
- entry metadata 能看到 `toolu_demo_edit_001`。
- 没有 `diff` 的 tool result 不产生 timeline entry。
- UI 仍然没有 DiffPanel；本章只证明 Runtime diff event 进入 Client。

## 下一章

02 会把 captured event 变成 `DiffRecord`，并补 `DiffStore` 和 `PatchSnapshotStore`。
