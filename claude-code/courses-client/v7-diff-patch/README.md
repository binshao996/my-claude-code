# V7 - Diff & Patch

V7 把 Agent 的一次代码修改做成一个可审查的 feature PR：Runtime 产出 diff，Client 捕获、解析、展示，用户 Accept 或 Reject 后刷新 Editor，并在 Agent Workspace 里留下 timeline entry。

每一章都必须能在没有真实 Runtime 写文件的情况下，用 fake event / fixture 跑出明确 UI 效果。

## 章节拆分

| 章节 | 主题 | 本章完成后的 UI |
| --- | --- | --- |
| 01 | [Diff 边界](./01-diff-boundary/README.md) | Agent Workspace 出现 `Diff captured` timeline entry 和 diff badge |
| 02 | [Diff 数据模型](./02-diff-domain-model/README.md) | store dev panel 能看到 pending record、file list 和 snapshot |
| 03 | [Unified Diff 解析](./03-unified-diff-parser/README.md) | fake patch 解析成 file list、hunk rows、add/remove/context 行 |
| 04 | [Diff Viewer](./04-diff-viewer/README.md) | DiffPanel 显示 diff badge、file list、hunk rows |
| 05 | [Accept / Reject Patch](./05-accept-reject-patch/README.md) | PatchDecisionBar 显示 pending / accepted / rejected 状态 |
| 06 | [Editor / Agent Bridge](./06-editor-agent-bridge/README.md) | 决策后 Editor refresh，并新增 timeline entry |

## V7 代码骨架

把 V7 代码集中放在 Client 侧，不重写 Runtime 编辑工具：

```text
claude-code-client/
  src/
    main/
      diff/
        PatchSnapshotStore.ts
        PatchService.ts
        patchDecision.ts
      ipc/
        diffIpc.ts
    renderer/
      diff/
        fixtures/
          fakeRuntimeDiffEvent.ts
        types.ts
        parseUnifiedDiff.ts
        DiffStore.ts
        selectors.ts
      components/
        diff/
          DiffPanel.tsx
          DiffFileList.tsx
          DiffHunkRows.tsx
          PatchDecisionBar.tsx
      editor/
        refreshEditorsAfterPatch.ts
      workspace/
        patchTimeline.ts
```

## Runtime Fake Event

所有章节都复用这个 fixture。没有真实 Runtime 修改文件时，直接 dispatch 它也必须能跑 UI。

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

## 最小端到端链路

```text
fakeRuntimeDiffEvent / ToolResult.diff
  -> PatchService.captureRuntimeDiff
  -> PatchSnapshotStore.save
  -> parseUnifiedDiff
  -> DiffStore.addPendingDiff
  -> DiffPanel
  -> PatchDecisionBar.accept / reject
  -> refreshEditorsAfterPatch
  -> Agent Workspace timeline
```

## Smoke Check 总表

每章完成后都跑最快检查：

```bash
pnpm typecheck
pnpm test
pnpm dev
```

可见 UI 必须满足：

- `Diff captured` 后出现 diff badge：`1 file`、`+2 -1`、`pending`。
- file list 显示 `src/app.ts`。
- hunk rows 显示 `@@ -1,4 +1,5 @@`、删除行、添加行、context 行。
- Accept 后 `PatchDecisionBar` 从 `pending` 变成 `accepted`，按钮消失。
- Reject 后 `PatchDecisionBar` 从 `pending` 变成 `rejected`，文件恢复 snapshot.beforeContent。
- Agent Workspace timeline 出现 `Patch accepted` 或 `Patch rejected`。
- 已打开的 editor tab 在决策后 reload；dirty buffer 必须阻断 refresh 并显示提示。

## V7 不做

- partial hunk accept / reject。
- side-by-side Monaco DiffEditor 深度集成。
- 多文件 patch 原子事务。
- 三方 merge 和冲突解决。
- 历史 diff 回放。这个放到 V8 Multi Session。
