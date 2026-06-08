import type { PluginCommand } from "./types";
import type { PromptCommand } from "../commands/commandTypes";

export function pluginCommandToCommandDefinition(
  pluginCommand: PluginCommand,
): PromptCommand {
  return {
    type: "prompt",
    name: pluginCommand.name,
    source: "plugin",
    description: pluginCommand.description,
    argumentHint: pluginCommand.argumentHint,
    async getPrompt(args) {
      const msgs = await pluginCommand.getPrompt(args);
      // Join all message contents into a single prompt string
      return msgs
        .map((msg) =>
          typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        )
        .join("\n\n");
    },
  };
}
