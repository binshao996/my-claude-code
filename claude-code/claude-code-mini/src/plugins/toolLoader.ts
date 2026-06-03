// 19add: Plugin tool loader — dynamic import TypeScript modules
import { pathToFileURL } from "node:url";
import { assertInsidePluginRoot } from "./manifest";
import type { PluginManifest, PluginTool } from "./types";

type ToolModule = {
  default?: PluginTool;
};

function assertPluginTool(value: unknown, source: string): asserts value is PluginTool {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Tool module ${source} must export a default object.`);
  }

  const tool = value as Partial<PluginTool>;
  if (typeof tool.name !== "string") {
    throw new Error(`Tool module ${source} is missing name.`);
  }
  if (typeof tool.description !== "string") {
    throw new Error(`Tool module ${source} is missing description.`);
  }
  if (typeof tool.run !== "function") {
    throw new Error(`Tool module ${source} is missing run().`);
  }
}

export async function loadPluginTools(
  pluginRoot: string,
  manifest: PluginManifest,
): Promise<PluginTool[]> {
  const tools = manifest.tools ?? {};
  const result: PluginTool[] = [];

  for (const [toolName, toolManifest] of Object.entries(tools)) {
    const filePath = await assertInsidePluginRoot(pluginRoot, toolManifest.source);
    const mod = (await import(pathToFileURL(filePath).href)) as ToolModule;
    const exported = mod.default;

    assertPluginTool(exported, toolManifest.source);

    result.push({
      ...exported,
      name: `${manifest.name}.${toolName}`,
      description: toolManifest.description ?? exported.description,
    });
  }

  return result;
}
