import type { ChatSession } from "../chat/session";
import { renderPlan } from "../planner";
import { appendLocalMemory } from "../memory";
import type { ToolRegistry } from "../tools";
import type { SessionStore } from "../session";
import { modelRouter, renderModelRoutes, setSessionModelOverride } from "../models";
import { runDebugCommand } from "./debug";
import { runTranscriptCommand } from "./transcript";
import { runSessionsCommand } from "./sessions";
import { runContinueCommand, runResumeCommand } from "./resume";
import { runCompactCommand } from "./compact";
import { listInstalledPlugins, setPluginEnabled } from "../plugins";
import type { PluginRegistry } from "../plugins";
import type {
  CommandDefinition,
  CommandExecutionContext,
  LocalCommand,
} from "./commandTypes";

export type BuiltinCommandsOptions = {
  session: ChatSession;
  cwd: string;
  toolRegistry: ToolRegistry;
  sessionStore: SessionStore;
  pluginRegistry: PluginRegistry;
  getMode: () => "default" | "plan";
  setMode: (mode: "default" | "plan") => void;
  runPrompt: (session: ChatSession, prompt: string, mode: "default" | "plan") => Promise<void>;
};

export function getBuiltinCommands(opts: BuiltinCommandsOptions): CommandDefinition[] {
  return [
    buildClearCommand(opts.session),
    buildToolsCommand(opts.toolRegistry),
    buildContextCommand(opts.session),
    buildMemoryCommand(opts.session),
    buildRememberCommand(opts.session),
    buildPlanCommand(opts),
    buildToolCommand(opts.toolRegistry),
    buildDebugCommand(),
    buildTranscriptCommand(),
    buildSessionsCommand(opts.cwd),
    buildContinueCommand(opts),
    buildResumeCommand(opts),
    buildCompactCommand(opts.session),
    buildModelsCommand(),
    buildModelCommand(),
    buildReloadPluginsCommand(opts),
    buildPluginCommand(),
  ];
}

// ─── Individual command builders ──────────────────────────────────

function buildClearCommand(session: ChatSession): LocalCommand {
  return {
    type: "local",
    name: "clear",
    source: "builtin",
    description: "Clear the conversation history",
    async run() {
      session.clear();
      return { type: "text", text: "Conversation cleared." };
    },
  };
}

function buildToolsCommand(toolRegistry: ToolRegistry): LocalCommand {
  return {
    type: "local",
    name: "tools",
    source: "builtin",
    description: "List available tools",
    async run() {
      const tools = toolRegistry.list();
      const lines = tools.map((t) => `- ${t.name}: ${t.description}`);
      return { type: "text", text: lines.join("\n") };
    },
  };
}

function buildContextCommand(session: ChatSession): LocalCommand {
  return {
    type: "local",
    name: "context",
    source: "builtin",
    description: "Show context usage and token budget",
    async run() {
      return { type: "text", text: await buildContextText(session) };
    },
  };
}

function buildMemoryCommand(session: ChatSession): LocalCommand {
  return {
    type: "local",
    name: "memory",
    source: "builtin",
    description: "List loaded memory files",
    async run() {
      const files = await session.memory.listFiles();
      if (files.length === 0) {
        return { type: "text", text: "No memory files loaded." };
      }
      const lines = ["Loaded memory files:"];
      for (const file of files) {
        lines.push(`- ${file.scope.padEnd(7)} ${file.path}`);
      }
      return { type: "text", text: lines.join("\n") };
    },
  };
}

function buildRememberCommand(session: ChatSession): LocalCommand {
  return {
    type: "local",
    name: "remember",
    source: "builtin",
    argumentHint: "<content>",
    description: "Append content to CLAUDE.local.md",
    async run(args) {
      if (!args) {
        return { type: "text", text: "Usage: /remember <content>" };
      }
      const path = await appendLocalMemory(session.memory.cwd, args);
      await session.memory.reload();
      return { type: "text", text: `Saved local memory: ${path}` };
    },
  };
}

function buildPlanCommand(opts: BuiltinCommandsOptions): LocalCommand {
  return {
    type: "local",
    name: "plan",
    source: "builtin",
    argumentHint: "[show|clear|exit|<prompt>]",
    description: "Enter plan mode or manage the current plan",
    async run(args, context) {
      if (!args) {
        if (opts.getMode() !== "plan") {
          opts.setMode("plan");
          return { type: "text", text: "Enabled plan mode. Describe the task to plan." };
        }
        const plan = context.session.currentPlan;
        return { type: "text", text: plan ? renderPlan(plan) : "Already in plan mode. No plan written yet." };
      }

      if (args === "show") {
        const plan = context.session.currentPlan;
        return { type: "text", text: renderPlan(plan) };
      }

      if (args === "clear") {
        const cleared = context.session.clearPlan();
        await opts.sessionStore.appendPlan(context.session.sessionId, cleared.plan);
        return { type: "text", text: "Plan cleared." };
      }

      if (args === "exit") {
        opts.setMode("default");
        return { type: "text", text: "Exited plan mode." };
      }

      // Treat as plan mode prompt
      opts.setMode("plan");
      await opts.runPrompt(context.session, args, "plan");
      return { type: "skip" };
    },
  };
}

function buildToolCommand(toolRegistry: ToolRegistry): LocalCommand {
  return {
    type: "local",
    name: "tool",
    source: "builtin",
    argumentHint: "<name> [json]",
    description: "Run a single tool manually",
    async run(args) {
      if (!args) {
        return { type: "text", text: "Usage: /tool <name> [json]" };
      }
      const rest = args.trim();
      const firstSpace = rest.indexOf(" ");
      const name = firstSpace === -1 ? rest : rest.slice(0, firstSpace).trim();
      const json = firstSpace === -1 ? "{}" : rest.slice(firstSpace + 1).trim();
      let input: unknown = {};
      try {
        input = JSON.parse(json);
      } catch {
        return { type: "text", text: `Invalid JSON: ${json}` };
      }
      const result = await toolRegistry.execute(name, input);
      const lines = [result.content];
      if (result.diff) lines.push(result.diff);
      return { type: "text", text: lines.join("\n") };
    },
  };
}

function buildDebugCommand(): LocalCommand {
  return {
    type: "local",
    name: "debug",
    source: "builtin",
    argumentHint: "[on|off]",
    description: "Toggle debug logging",
    async run(args) {
      return { type: "text", text: runDebugCommand(args ? args.split(/\s+/) : []) };
    },
  };
}

function buildTranscriptCommand(): LocalCommand {
  return {
    type: "local",
    name: "transcript",
    source: "builtin",
    description: "Show the current transcript file path",
    async run() {
      return { type: "text", text: runTranscriptCommand() };
    },
  };
}

function buildSessionsCommand(cwd: string): LocalCommand {
  return {
    type: "local",
    name: "sessions",
    source: "builtin",
    description: "List recent sessions for this project",
    async run() {
      return { type: "text", text: await runSessionsCommand(cwd) };
    },
  };
}

function buildContinueCommand(opts: BuiltinCommandsOptions): LocalCommand {
  return {
    type: "local",
    name: "continue",
    source: "builtin",
    description: "Continue the most recent session",
    async run() {
      const result = await runContinueCommand(opts.cwd);
      opts.session.replaceMessages(result.messages);
      return {
        type: "replaceMessages",
        messages: result.messages,
        text: `Continued session ${result.sessionId} (${result.messages.length} messages restored)`,
      };
    },
  };
}

function buildResumeCommand(opts: BuiltinCommandsOptions): LocalCommand {
  return {
    type: "local",
    name: "resume",
    source: "builtin",
    argumentHint: "<sessionId | path>",
    description: "Resume a saved conversation",
    async run(args) {
      if (!args) {
        return {
          type: "text",
          text: "Usage: /resume <sessionId | transcript.jsonl>",
        };
      }
      const result = await runResumeCommand(args, opts.cwd);
      opts.session.replaceMessages(result.messages);
      return {
        type: "replaceMessages",
        messages: result.messages,
        text: `Resumed session ${result.sessionId} (${result.messages.length} messages restored)`,
      };
    },
  };
}

function buildCompactCommand(session: ChatSession): LocalCommand {
  return {
    type: "local",
    name: "compact",
    source: "builtin",
    argumentHint: "[instructions]",
    description: "Compact current conversation",
    async run(args) {
      const customInstructions = args?.trim() || undefined;
      return { type: "text", text: await runCompactCommand(session, customInstructions) };
    },
  };
}

function buildModelsCommand(): LocalCommand {
  return {
    type: "local",
    name: "models",
    source: "builtin",
    description: "Display model route table",
    async run() {
      return { type: "text", text: renderModelRoutes() };
    },
  };
}

function buildModelCommand(): LocalCommand {
  return {
    type: "local",
    name: "model",
    source: "builtin",
    argumentHint: "[model-name|default]",
    description: "Show or override the current main model",
    async run(args) {
      if (!args) {
        const current = modelRouter.resolve({ role: "main" });
        return {
          type: "text",
          text: `Current main model: ${current.model}\nReason: ${current.reason}`,
        };
      }
      if (args === "default") {
        setSessionModelOverride(null);
        const current = modelRouter.resolve({ role: "main" });
        return { type: "text", text: `Main model reset to default: ${current.model}` };
      }
      setSessionModelOverride(args);
      const current = modelRouter.resolve({ role: "main" });
      return { type: "text", text: `Main model set to: ${current.model}` };
    },
  };
}

function buildReloadPluginsCommand(opts: BuiltinCommandsOptions): LocalCommand {
  return {
    type: "local",
    name: "reload-plugins",
    source: "builtin",
    description: "Reload plugin commands and tools",
    async run() {
      const runtime = await opts.pluginRegistry.reload();
      const lines = [
        `Reloaded ${runtime.enabledCount} plugins.`,
        `Commands: ${runtime.commands.length}`,
        `Tools: ${runtime.tools.length}`,
        runtime.errors.length > 0 ? `Errors: ${runtime.errors.length}` : null,
      ].filter(Boolean) as string[];
      return { type: "text", text: lines.join("\n") };
    },
  };
}

function buildPluginCommand(): LocalCommand {
  return {
    type: "local",
    name: "plugin",
    source: "builtin",
    argumentHint: "[list|enable <name>|disable <name>]",
    description: "Manage installed plugins",
    async run(args) {
      if (!args || args === "list") {
        const installed = await listInstalledPlugins();
        const rows = Object.values(installed.plugins);
        if (rows.length === 0) {
          return { type: "text", text: "No plugins installed." };
        }
        const lines = ["Installed plugins:"];
        for (const plugin of rows) {
          const state = plugin.enabled ? "enabled" : "disabled";
          lines.push(`- ${plugin.name}  ${state}  ${plugin.version ?? "unknown"}`);
        }
        return { type: "text", text: lines.join("\n") };
      }

      const [action, target] = args.trim().split(/\s+/);
      if (action === "enable" && target) {
        await setPluginEnabled(target, true);
        return { type: "text", text: `Enabled plugin: ${target}. Run /reload-plugins to apply.` };
      }
      if (action === "disable" && target) {
        await setPluginEnabled(target, false);
        return { type: "text", text: `Disabled plugin: ${target}. Run /reload-plugins to apply.` };
      }

      return { type: "text", text: "Usage: /plugin [list|enable|disable]" };
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────

function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}

async function buildContextText(session: ChatSession): Promise<string> {
  const memoryPrompt = (await session.memory.getPrompt()) ?? "";
  const runtimeContext = session.buildRuntimeContext();

  const prepared = session.contextPreparer.prepare({
    systemPrompt: session.baseSystemPrompt,
    memoryPrompt,
    runtimeContext,
    messages: session.history as import("../llm/types").ChatMessage[],
  });

  const lines: string[] = [];
  lines.push("Context Usage");
  lines.push("");
  lines.push(`Window: ${formatTokens(prepared.contextWindowTokens)} tokens`);
  lines.push(`Effective input budget: ${formatTokens(prepared.effectiveInputBudget)} tokens`);
  lines.push(`Estimated used: ${formatTokens(prepared.totalTokens)} tokens`);
  lines.push("");
  lines.push("Category             Tokens");

  for (const category of prepared.categories) {
    lines.push(`${category.name.padEnd(20)} ${formatTokens(category.tokens)}`);
  }

  if (prepared.truncated) {
    lines.push("");
    lines.push("Some context was truncated for this request.");
  }

  const compactStats = session.getCompactStats();
  if (compactStats.hasCompactBoundary) {
    lines.push("");
    lines.push(`Compactions: ${compactStats.compactCount}`);
    lines.push(`Messages after last compact: ${compactStats.messagesAfterLastCompact}`);
    if (compactStats.lastCompactAt) {
      lines.push(`Last compact: ${compactStats.lastCompactAt}`);
    }
  }

  return lines.join("\n");
}
