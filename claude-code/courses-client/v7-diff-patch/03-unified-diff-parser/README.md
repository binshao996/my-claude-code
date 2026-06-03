# 03 - Unified Diff 解析

## PR Scope

本章实现 `parseUnifiedDiff(rawPatch)`。输入是 01 的 `RuntimeDiffEvent.rawPatch`，输出是 02 的 `DiffFile[]`。

完成后，fake patch 可以在没有真实 Runtime 写文件时解析出 file list、hunk rows、add/remove/context 行。

## 文件路径

```text
claude-code-client/
  src/
    renderer/
      diff/
        fixtures/fakeRuntimeDiffEvent.ts
        parseUnifiedDiff.ts
        DiffStore.ts
        types.ts
```

## Parser

文件：`src/renderer/diff/parseUnifiedDiff.ts`

```ts
import type { DiffFile, DiffHunk, DiffLine, DiffLineType } from "./types";

type ParseResult =
  | { ok: true; files: DiffFile[] }
  | { ok: false; message: string };

function lineId(fileIndex: number, hunkIndex: number, lineIndex: number): string {
  return `line:${fileIndex}:${hunkIndex}:${lineIndex}`;
}

function parseLine(
  rawLine: string,
  oldLine: number,
  newLine: number,
): { line: Omit<DiffLine, "id">; oldLine: number; newLine: number } {
  const marker = rawLine[0];
  const content = rawLine.slice(1);

  if (marker === "+") {
    return {
      line: { type: "add", oldLineNumber: null, newLineNumber: newLine, content },
      oldLine,
      newLine: newLine + 1,
    };
  }

  if (marker === "-") {
    return {
      line: { type: "remove", oldLineNumber: oldLine, newLineNumber: null, content },
      oldLine: oldLine + 1,
      newLine,
    };
  }

  const contextContent = marker === " " ? content : rawLine;
  return {
    line: {
      type: "context" satisfies DiffLineType,
      oldLineNumber: oldLine,
      newLineNumber: newLine,
      content: contextContent,
    },
    oldLine: oldLine + 1,
    newLine: newLine + 1,
  };
}

export function parseUnifiedDiff(rawPatch: string): ParseResult {
  const rows = rawPatch.split(/\r?\n/).filter(row => row !== "");
  const files: DiffFile[] = [];
  let currentFile: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const row of rows) {
    if (row.startsWith("--- a/")) {
      currentFile = {
        id: `file:${files.length}`,
        oldPath: row.slice("--- a/".length),
        newPath: "",
        hunks: [],
        additions: 0,
        removals: 0,
      };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    if (row.startsWith("+++ b/")) {
      if (!currentFile) return { ok: false, message: "new file header without old file header" };
      currentFile.newPath = row.slice("+++ b/".length);
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (hunkMatch) {
      if (!currentFile) return { ok: false, message: "hunk without file header" };

      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
      currentHunk = {
        id: `hunk:${files.length - 1}:${currentFile.hunks.length}`,
        header: row,
        oldStart: oldLine,
        oldLines: Number(hunkMatch[2] ?? "1"),
        newStart: newLine,
        newLines: Number(hunkMatch[4] ?? "1"),
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentFile || !currentHunk) continue;

    const parsed = parseLine(row, oldLine, newLine);
    oldLine = parsed.oldLine;
    newLine = parsed.newLine;

    const line: DiffLine = {
      id: lineId(files.length - 1, currentFile.hunks.length - 1, currentHunk.lines.length),
      ...parsed.line,
    };
    currentHunk.lines.push(line);

    if (line.type === "add") currentFile.additions++;
    if (line.type === "remove") currentFile.removals++;
  }

  if (files.length === 0) return { ok: false, message: "Cannot parse diff" };
  if (files.some(file => file.newPath === "" || file.hunks.length === 0)) {
    return { ok: false, message: "Cannot parse diff" };
  }

  return { ok: true, files };
}
```

## 本章 Fake Parser Run

文件：`src/renderer/diff/fixtures/parseFakeRuntimeDiff.ts`

```ts
import { fakeRuntimeDiffEvent } from "./fakeRuntimeDiffEvent";
import { parseUnifiedDiff } from "../parseUnifiedDiff";

export function parseFakeRuntimeDiff() {
  return parseUnifiedDiff(fakeRuntimeDiffEvent.rawPatch);
}
```

## 写入 DiffStore

文件：`src/renderer/diff/DiffStore.ts`

```ts
import { parseUnifiedDiff } from "./parseUnifiedDiff";
import type { DiffState, RuntimeDiffEvent } from "./types";

export function addRuntimeDiffEvent(state: DiffState, event: RuntimeDiffEvent): DiffState {
  const result = parseUnifiedDiff(event.rawPatch);

  if (!result.ok) {
    return setPatchError(state, result.message);
  }

  return addPendingDiff(state, createPendingDiff(event, result.files));
}
```

## Smoke Check

执行：

```bash
pnpm typecheck
pnpm test
pnpm dev
```

调用 `parseFakeRuntimeDiff()` 后，必须看到：

- parser 返回 `ok=true`。
- file list 有 1 个文件：`src/app.ts`。
- diff badge 显示 `+2 -1`。
- hunk rows 显示 header：`@@ -1,4 +1,5 @@`。
- hunk rows 里有 1 行 remove：`return "Claude Code Mini";`。
- hunk rows 里有 2 行 add：`return "Claude Code Client";` 和 `export const diffEnabled = true;`。
- context 行显示函数声明和 `}`。
- 传入非法 patch 时，DiffStore 状态变为 `error`，UI 显示 `Cannot parse diff`，不显示空白 DiffPanel。

## 下一章

04 会实现 `DiffPanel`，把 parsed diff 渲染成用户能审查的 UI。
