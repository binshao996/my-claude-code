// 19add: Plugin context loader — read context files, apply token budget
import { readFile } from "node:fs/promises";
import { assertInsidePluginRoot } from "./manifest";
import type { PluginContextSnippet, PluginManifest } from "./types";
import { truncateTextToTokens } from "../context/truncate";

export async function loadPluginContext(
  pluginRoot: string,
  manifest: PluginManifest,
): Promise<PluginContextSnippet[]> {
  const snippets: PluginContextSnippet[] = [];

  for (const source of manifest.context ?? []) {
    const filePath = await assertInsidePluginRoot(pluginRoot, source);
    const raw = await readFile(filePath, "utf8");
    const content = truncateTextToTokens(raw, 4_000).text;

    snippets.push({
      pluginName: manifest.name,
      path: source,
      content,
    });
  }

  return snippets;
}

export function renderPluginContext(snippets: PluginContextSnippet[]): string | null {
  if (snippets.length === 0) return null;

  const sections = snippets.map((snippet) => {
    return `Plugin context from ${snippet.pluginName}:${snippet.path}\n\n${snippet.content}`;
  });

  return sections.join("\n\n");
}
