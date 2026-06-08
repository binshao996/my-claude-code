import { randomUUID } from "node:crypto";
import { parseCommandInput } from "./commandParser";
import type {
  CommandDefinition,
  CommandExecutionContext,
  CommandResult,
} from "./commandTypes";
import { appendTranscriptEntry } from "../transcript/store";
import { getSessionId } from "../session/sessionState";

export type CommandExecution =
  | { handled: false }
  | {
      handled: true;
      command: CommandDefinition;
      result: CommandResult;
    };

export async function executeCommandInput(
  input: string,
  context: CommandExecutionContext,
): Promise<CommandExecution> {
  const parsed = parseCommandInput(input);
  if (!parsed) return { handled: false };

  const command = context.commands.find(parsed.name);

  if (!command) {
    return {
      handled: true,
      command: unknownCommandDef(parsed.name),
      result: {
        type: "text",
        text: `Unknown command: ${parsed.name}`,
      },
    };
  }

  // 25add: Record command execution to transcript
  void recordCommandEntry(command.name, parsed.args, command.source);

  try {
    if (command.type === "local") {
      const result = await command.run(parsed.args, context);

      // Record text output to transcript
      if (result.type === "text") {
        void recordCommandOutputEntry(command.name, result.text);
      }

      return { handled: true, command, result };
    }

    // Prompt command: get prompt, inject as meta user message
    const prompt = await command.getPrompt(parsed.args, context);

    const messages = [
      {
        id: randomUUID(),
        role: "user" as const,
        content: `/${command.name} ${parsed.args}`.trim(),
      },
      {
        id: randomUUID(),
        role: "user" as const,
        isMeta: true,
        content: prompt,
      },
    ];

    // Add allowedTools meta message if applicable
    if (command.allowedTools && command.allowedTools.length > 0) {
      messages.push({
        id: randomUUID(),
        role: "user" as const,
        isMeta: true,
        content: `Allowed tools for this command: ${command.allowedTools.join(", ")}`,
      });
    }

    return {
      handled: true,
      command,
      result: {
        type: "inject",
        shouldQuery: true,
        messages,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      handled: true,
      command,
      result: {
        type: "text",
        text: `Command /${command.name} failed: ${message}`,
      },
    };
  }
}

function unknownCommandDef(name: string): CommandDefinition {
  return {
    type: "local",
    name,
    source: "builtin",
    description: "Unknown command",
    async run() {
      return { type: "text", text: `Unknown command: ${name}` };
    },
  };
}

async function recordCommandEntry(
  commandName: string,
  args: string,
  source: string,
): Promise<void> {
  await appendTranscriptEntry({
    type: "meta",
    sessionId: getSessionId(),
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    key: "command",
    value: { commandName, args, source },
  });
}

async function recordCommandOutputEntry(
  commandName: string,
  output: string,
): Promise<void> {
  await appendTranscriptEntry({
    type: "meta",
    sessionId: getSessionId(),
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    key: "command_output",
    value: { commandName, output },
  });
}
