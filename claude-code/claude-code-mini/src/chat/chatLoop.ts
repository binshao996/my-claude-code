import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { ChatSession } from "./session";
import type { LLMConfig, LLMResponse } from "../llm/types";
import type { ToolRegistry } from "../tools";
import type { LoadedSession, SessionStore } from "../session";
import type { PlannerStore } from "../planner";
import {
  createToolInputProgress,
  finishToolInputProgress,
  formatToolInput,
  shouldPrintToolInputProgress,
  startToolInputProgress,
} from "./toolInputFormatter";
// 25add: New command system
import { CommandRegistry } from "../commands/commandRegistry";
import { executeCommandInput } from "../commands/commandExecutor";
import type {
  CommandExecutionContext,
  CommandResult,
} from "../commands/commandTypes";
import { getBuiltinCommands } from "../commands/builtinCommands";
import { pluginCommandToCommandDefinition } from "../plugins/commandAdapter";
import type { PluginRegistry } from "../plugins";

type ChatLoopOptions = {
  cwd: string;
  toolRegistry: ToolRegistry;
  maxTurns: number;
  contextWindow: number;
  loadedSession: LoadedSession;
  sessionStore: SessionStore;
  sessionStartMode: "new" | "resume" | "continue";
  planner: PlannerStore;
  pluginRegistry: PluginRegistry;
};

export async function runChatLoop(
  config: LLMConfig,
  options: ChatLoopOptions,
): Promise<void> {
  const session = new ChatSession(config, options.toolRegistry, {
    maxTurns: options.maxTurns,
    contextWindow: options.contextWindow,
    loadedSession: options.loadedSession,
    sessionStore: options.sessionStore,
    planner: options.planner,
    cwd: options.cwd,
    pluginRegistry: options.pluginRegistry,
  });
  const rl = createInterface({ input, output });
  const askUser = async (prompt: string): Promise<string> => {
    return rl.question(prompt);
  };
  options.toolRegistry.setAskUser(askUser);

  // 25add: Build command registry from builtins + plugins
  let mode: "default" | "plan" = "default";
  const commandRegistry = buildCommandRegistry(session, options, () => mode, (m) => { mode = m; });

  const cmdContext: CommandExecutionContext = {
    cwd: options.cwd,
    session,
    commands: commandRegistry.view(),
  };

  printBanner(config, options);
  printSessionBanner(options.sessionStartMode, session);

  try {
    while (true) {
      const rawInput = await rl.question("> ");
      const prompt = rawInput.trim();

      if (!prompt) {
        continue;
      }

      if (prompt === "/exit" || prompt === "/quit") {
        break;
      }

      // 25add: Try command execution
      const execution = await executeCommandInput(prompt, cmdContext);
      if (execution.handled) {
        await applyCommandResult(execution.result, session, () => mode, (m) => { mode = m; });
        continue;
      }

      // Not a command — run as normal prompt
      await runPrompt(session, prompt, mode);
    }
  } finally {
    rl.close();
  }
}

// ─── Command result application ──────────────────────────────────

async function applyCommandResult(
  result: CommandResult,
  session: ChatSession,
  getMode: () => "default" | "plan",
  setMode: (mode: "default" | "plan") => void,
): Promise<void> {
  if (result.type === "skip") {
    return;
  }

  if (result.type === "text") {
    console.log(result.text);
    return;
  }

  if (result.type === "replaceMessages") {
    session.replaceMessages(result.messages);
    if (result.text) console.log(result.text);
    return;
  }

  if (result.type === "inject") {
    // Append injected meta messages and trigger model request
    session.appendMessages(result.messages);

    if (result.shouldQuery) {
      const mode = getMode();
      await runPrompt(session, "(command continuation)", mode);
    }
  }
}

// ─── Command registry construction ───────────────────────────────

function buildCommandRegistry(
  session: ChatSession,
  options: ChatLoopOptions,
  getMode: () => "default" | "plan",
  setMode: (mode: "default" | "plan") => void,
): CommandRegistry {
  const registry = new CommandRegistry();

  // Builtin commands
  const builtins = getBuiltinCommands({
    session,
    cwd: options.cwd,
    toolRegistry: options.toolRegistry,
    sessionStore: options.sessionStore,
    pluginRegistry: options.pluginRegistry,
    getMode,
    setMode,
    runPrompt: (s, p, m) => runPrompt(s, p, m),
  });

  for (const cmd of builtins) {
    registry.register(cmd);
  }

  // Plugin commands
  const pluginRuntime = options.pluginRegistry.getRuntime();
  for (const pc of pluginRuntime.commands) {
    try {
      registry.register(pluginCommandToCommandDefinition(pc));
    } catch {
      // Skip duplicate names — builtins take priority
    }
  }

  return registry;
}

// ─── Prompt execution ────────────────────────────────────────────

async function runPrompt(
  session: ChatSession,
  prompt: string,
  mode: "default" | "plan",
): Promise<void> {
  try {
    let finalResponse: LLMResponse | undefined;
    const toolInputProgress = createToolInputProgress();

    if (mode === "plan") {
      console.log("[plan mode]");
    }

    for await (const event of session.sendUserMessageStream(prompt, { mode })) {
      switch (event.type) {
        case "turn_start":
          console.log("");
          console.log(`[turn ${event.turn}]`);
          break;

        case "context_update":
          console.log(
            `[context] ${event.beforeTokens} -> ${event.afterTokens} tokens, compacted ${event.compactedToolResults} tool result(s), trimmed ${event.trimmedMessages} message(s)`,
          );
          break;

        case "text_delta":
          output.write(event.text);
          break;

        case "tool_use_start":
          console.log("");
          console.log("");
          console.log(`[tool_use] ${event.name}`);
          console.log("input: receiving...");
          startToolInputProgress(toolInputProgress, event.id);
          break;

        case "tool_input_delta":
          if (
            shouldPrintToolInputProgress(
              toolInputProgress,
              event.id,
              event.inputJSONLength,
            )
          ) {
            console.log(`input: receiving ${event.inputJSONLength} chars...`);
          }
          break;

        case "tool_use":
          console.log(`input: ${formatToolInput(event.toolUse.input)}`);
          finishToolInputProgress(toolInputProgress);
          break;

        case "turn_complete":
          if (event.toolUseCount > 0) {
            console.log(`[turn ${event.turn}] tool calls: ${event.toolUseCount}`);
          }
          break;

        case "tool_start":
          console.log(`[tool_start] ${event.toolUse.name}`);
          break;

        case "tool_result":
          console.log(
            `[tool_result] ${event.toolUse.name} ${
              event.result.is_error ? "error" : "ok"
            }`,
          );
          printDiff(event.rawResult?.diff);
          console.log("");
          break;

        case "max_turns_reached":
          console.log(`[max_turns] stopped after ${event.maxTurns} turns`);
          break;

        case "retry":
          console.log(
            `API retry: ${event.errorKind}, attempt ${event.attempt}/${event.maxRetries}, retrying in ${event.retryInMs}ms`,
          );
          break;

        case "model_fallback":
          console.log(
            `Model fallback: ${event.from} -> ${event.to} (${event.reason})`,
          );
          break;

        case "streaming_fallback":
          console.log("Streaming fallback: switching to non-streaming request");
          break;

        case "message_stop":
          finalResponse = event.response;
          break;
      }
    }

    console.log("");

    if (finalResponse) {
      console.log("");
      console.log(
        `tokens: ${finalResponse.inputTokens} input / ${finalResponse.outputTokens} output`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
  }
}

// ─── Display helpers ──────────────────────────────────────────────

function printBanner(config: LLMConfig, options: ChatLoopOptions): void {
  console.log("Claude Code Mini");
  console.log(`model: ${config.model}`);
  console.log(`cwd: ${options.cwd}`);
  console.log(`max turns: ${options.maxTurns}`);
  console.log("");
  console.log("Type /exit to quit, /help for available commands.");
  console.log("");
}

function printSessionBanner(
  sessionMode: "new" | "resume" | "continue",
  session: ChatSession,
): void {
  const action =
    sessionMode === "new" ? "started" : sessionMode === "resume" ? "resumed" : "continued";

  console.log(`[session] ${action} ${session.sessionId}`);
  console.log(`[transcript] ${session.transcriptPath}`);

  if (session.history.length > 0) {
    console.log(`[history] restored ${session.history.length} message(s)`);
  }
}

function printDiff(diff: string | undefined): void {
  if (!diff) return;
  console.log(diff);
}
