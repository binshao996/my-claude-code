import { structuredPatch, type StructuredPatchHunk } from "diff";

const CONTEXT_LINES = 3;
const DIFF_TIMEOUT_MS = 5_000;

const AMPERSAND_TOKEN = "<<:AMPERSAND_TOKEN:>>";
const DOLLAR_TOKEN = "<<:DOLLAR_TOKEN:>>";

export type UnifiedDiffInput = {
  filePath: string;
  oldContent: string;
  newContent: string;
};

export type UnifiedDiffResult = {
  patch: string;
  additions: number;
  removals: number;
};

export function createUnifiedDiff(input: UnifiedDiffInput): UnifiedDiffResult {
  const hunks = getPatchFromContents(input);

  return {
    patch: formatUnifiedDiff(input.filePath, hunks),
    additions: countLines(hunks, "+"),
    removals: countLines(hunks, "-"),
  };
}

function getPatchFromContents({
  filePath,
  oldContent,
  newContent,
}: UnifiedDiffInput): StructuredPatchHunk[] {
  const result = structuredPatch(
    filePath,
    filePath,
    escapeForDiff(oldContent),
    escapeForDiff(newContent),
    undefined,
    undefined,
    {
      context: CONTEXT_LINES,
      timeout: DIFF_TIMEOUT_MS,
    },
  );

  if (!result) {
    return [];
  }

  return result.hunks.map(hunk => ({
    ...hunk,
    lines: hunk.lines.map(unescapeFromDiff),
  }));
}

function formatUnifiedDiff(
  filePath: string,
  hunks: StructuredPatchHunk[],
): string {
  if (hunks.length === 0) {
    return "";
  }

  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`];

  for (const hunk of hunks) {
    lines.push(formatHunkHeader(hunk));
    lines.push(...hunk.lines);
  }

  return lines.join("\n");
}

function formatHunkHeader(hunk: StructuredPatchHunk): string {
  return `@@ -${formatRange(hunk.oldStart, hunk.oldLines)} +${formatRange(
    hunk.newStart,
    hunk.newLines,
  )} @@`;
}

function formatRange(start: number, lines: number): string {
  return lines === 1 ? String(start) : `${start},${lines}`;
}

function countLines(hunks: StructuredPatchHunk[], prefix: "+" | "-"): number {
  return hunks.reduce(
    (total, hunk) =>
      total +
      hunk.lines.filter(line => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}`))
        .length,
    0,
  );
}

function escapeForDiff(value: string): string {
  return value.replaceAll("&", AMPERSAND_TOKEN).replaceAll("$", DOLLAR_TOKEN);
}

function unescapeFromDiff(value: string): string {
  return value.replaceAll(AMPERSAND_TOKEN, "&").replaceAll(DOLLAR_TOKEN, "$");
}
