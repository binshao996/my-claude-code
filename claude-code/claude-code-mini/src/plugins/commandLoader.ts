// 19add: Plugin command loader — read markdown files, substitute $ARGUMENTS
import { readFile } from "node:fs/promises";
import { assertInsidePluginRoot } from "./manifest";
import type { PluginCommand, PluginManifest } from "./types";

function substituteArguments(content: string, args: string): string {
  return content.replaceAll("$ARGUMENTS", args);
}

export async function loadPluginCommands(
  pluginRoot: string,
  manifest: PluginManifest,
): Promise<PluginCommand[]> {
  const commands = manifest.commands ?? {};
  const result: PluginCommand[] = [];

  for (const [commandName, command] of Object.entries(commands)) {
    const filePath = await assertInsidePluginRoot(pluginRoot, command.source);
    const content = await readFile(filePath, "utf8");
    const runtimeName = `${manifest.name}:${commandName}`;

    result.push({
      name: runtimeName,
      description: command.description ?? `Command from ${manifest.name}`,
      argumentHint: command.argumentHint,
      // 20add: pass model override from manifest
      model: command.model,
      async getPrompt(args) {
        return [
          {
            role: "user",
            content: substituteArguments(content, args),
          },
        ];
      },
    });
  }

  return result;
}
