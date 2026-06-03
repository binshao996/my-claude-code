# 04 - Diff Viewer

## PR Scope

本章实现 `DiffPanel`、file list 和 hunk rows。它只消费 `DiffStore.activeDiffId`，不解析 raw patch。

完成后，fake event 能在右侧面板显示 diff badge、文件列表、hunk header、add/remove/context 行。

## 文件路径

```text
claude-code-client/
  src/
    renderer/
      components/
        diff/
          DiffPanel.tsx
          DiffFileList.tsx
          DiffHunkRows.tsx
          PatchDecisionBar.tsx
      diff/
        fixtures/fakeRuntimeDiffEvent.ts
        selectors.ts
        DiffStore.ts
```

## Selectors

文件：`src/renderer/diff/selectors.ts`

```ts
import type { DiffState } from "./DiffStore";

export function selectActiveDiff(state: DiffState) {
  return state.activeDiffId ? state.records[state.activeDiffId] ?? null : null;
}

export function selectDiffBadge(state: DiffState): string {
  const record = selectActiveDiff(state);
  if (!record) return "No diff";

  const fileCount = record.files.length;
  const additions = record.files.reduce((sum, file) => sum + file.additions, 0);
  const removals = record.files.reduce((sum, file) => sum + file.removals, 0);

  return `${fileCount} file${fileCount === 1 ? "" : "s"} +${additions} -${removals} ${record.decision.status}`;
}
```

## DiffPanel

文件：`src/renderer/components/diff/DiffPanel.tsx`

```tsx
import type { DiffRecord } from "../../diff/types";
import { DiffFileList } from "./DiffFileList";
import { PatchDecisionBar } from "./PatchDecisionBar";

export function DiffPanel({ record }: { record: DiffRecord | null }) {
  if (!record) {
    return <section className="diff-panel diff-panel-empty">No diff to review</section>;
  }

  const additions = record.files.reduce((sum, file) => sum + file.additions, 0);
  const removals = record.files.reduce((sum, file) => sum + file.removals, 0);

  return (
    <section className="diff-panel" aria-label="Review changes">
      <header className="diff-panel-header">
        <div>
          <h2>Review changes</h2>
          <span className="diff-badge">
            {record.files.length} file +{additions} -{removals} {record.decision.status}
          </span>
        </div>
        <PatchDecisionBar record={record} />
      </header>
      <DiffFileList files={record.files} />
    </section>
  );
}
```

## File List 和 Hunk Rows

文件：`src/renderer/components/diff/DiffFileList.tsx`

```tsx
import type { DiffFile } from "../../diff/types";
import { DiffHunkRows } from "./DiffHunkRows";

export function DiffFileList({ files }: { files: DiffFile[] }) {
  return (
    <div className="diff-file-list">
      {files.map(file => (
        <article className="diff-file" key={file.id}>
          <header className="diff-file-header">
            <strong>{file.newPath}</strong>
            <span>
              {file.hunks.length} hunk +{file.additions} -{file.removals}
            </span>
          </header>
          {file.hunks.map(hunk => (
            <DiffHunkRows hunk={hunk} key={hunk.id} />
          ))}
        </article>
      ))}
    </div>
  );
}
```

文件：`src/renderer/components/diff/DiffHunkRows.tsx`

```tsx
import type { DiffHunk, DiffLine } from "../../diff/types";

function marker(line: DiffLine): string {
  if (line.type === "add") return "+";
  if (line.type === "remove") return "-";
  return " ";
}

export function DiffHunkRows({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className="diff-hunk">
      <div className="diff-hunk-header">{hunk.header}</div>
      {hunk.lines.map(line => (
        <div className={`diff-line diff-line-${line.type}`} key={line.id}>
          <span className="line-number">{line.oldLineNumber ?? ""}</span>
          <span className="line-number">{line.newLineNumber ?? ""}</span>
          <span className="line-marker">{marker(line)}</span>
          <code>{line.content}</code>
        </div>
      ))}
    </div>
  );
}
```

## CSS

文件：`src/renderer/components/diff/diff.css`

```css
.diff-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.diff-badge {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px 8px;
  font-size: 12px;
}

.diff-file-header,
.diff-line {
  display: grid;
  grid-template-columns: 72px 72px 24px minmax(0, 1fr);
}

.diff-line-add {
  background: rgba(16, 185, 129, 0.12);
}

.diff-line-remove {
  background: rgba(239, 68, 68, 0.12);
}

.diff-line-context {
  background: transparent;
}
```

## 本章 Fake UI Run

文件：`src/renderer/diff/fixtures/renderFakeDiffPanel.tsx`

```tsx
import { DiffPanel } from "../../components/diff/DiffPanel";
import { fakeRuntimeDiffEvent } from "./fakeRuntimeDiffEvent";
import { createPendingDiff } from "../DiffStore";
import { parseUnifiedDiff } from "../parseUnifiedDiff";

export function RenderFakeDiffPanel() {
  const result = parseUnifiedDiff(fakeRuntimeDiffEvent.rawPatch);
  const record = result.ok ? createPendingDiff(fakeRuntimeDiffEvent, result.files) : null;
  return <DiffPanel record={record} />;
}
```

## Smoke Check

执行：

```bash
pnpm typecheck
pnpm test
pnpm dev
```

打开 `RenderFakeDiffPanel` 后，右侧 Diff 面板必须看到：

- 标题 `Review changes`。
- diff badge：`1 file +2 -1 pending`。
- file list 中有 `src/app.ts`。
- 文件行显示 `1 hunk +2 -1`。
- hunk header 显示 `@@ -1,4 +1,5 @@`。
- hunk rows 有 remove 红底行、add 绿底行、context 普通行。
- 两列行号固定宽度；新增行 old line 为空，删除行 new line 为空。
- `activeDiffId=null` 时显示 `No diff to review`，不残留上一条 diff。

## 下一章

05 会补 `PatchDecisionBar` 的 Accept / Reject 行为和状态变化。
