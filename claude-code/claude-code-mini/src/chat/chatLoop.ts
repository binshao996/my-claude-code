import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { ChatSession } from "./session";
import type { LLMConfig, LLMResponse } from "../llm/types";
import type { ToolRegistry } from "../tools";
import type { LoadedSession, SessionStore } from "../session";
import { renderPlan, type PlannerStore } from "../planner";
import {
  createToolInputProgress,
  finishToolInputProgress,
  formatToolInput,
  shouldPrintToolInputProgress,
  startToolInputProgress,
} from "./toolInputFormatter";
// 17add: memory slash commands
import { appendLocalMemory } from "../memory";
// 19add: 插件系统 — CommandRegistry, PluginRegistry, plugin 命令
import { CommandRegistry } from "../commands/commandRegistry";
import { listInstalledPlugins, setPluginEnabled } from "../plugins";
import type { PluginRegistry } from "../plugins";
// 20add: 模型路由命令
import { modelRouter, renderModelRoutes, setSessionModelOverride } from "../models";

type ChatLoopOptions = {
  cwd: string;
  toolRegistry: ToolRegistry;
  maxTurns: number;
  contextWindow: number;
  loadedSession: LoadedSession;
  sessionStore: SessionStore;
  sessionStartMode: "new" | "resume" | "continue";
  planner: PlannerStore;
  // 19add: PluginRegistry 用于 /plugin /reload-plugins 命令
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
    // 17add: MemoryStore 需要 cwd 加载项目记忆文件
    cwd: options.cwd,
    // 19add: PluginRegistry 注入
    pluginRegistry: options.pluginRegistry,
  });
  const rl = createInterface({ input, output });
  // 15add: inject askUser into ToolContext so toolRunner can prompt for approval
  const askUser = async (prompt: string): Promise<string> => {
    return rl.question(prompt);
  };
  options.toolRegistry.setAskUser(askUser);

  console.log("Claude Code Mini");
  console.log(`model: ${config.model}`);
  console.log(`cwd: ${options.cwd}`);
  console.log(`max turns: ${options.maxTurns}`);
  console.log("");
  console.log("Type /exit to quit, /clear to reset conversation.");
  console.log("Type /tools to list tools, /tool <name> <json> to run one.");
  console.log("Type /plan to enter plan mode, /plan show to view it.");
  console.log("");

  // 19add: 创建 CommandRegistry，注册内置命令 + 插件命令
  const commands = new CommandRegistry();
  let mode: "default" | "plan" = "default";

  registerBuiltinCommands(commands, session, options, () => mode);
  registerPluginCommands(commands, session, options.pluginRegistry, options.toolRegistry);

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

      // 19add: 委托 CommandRegistry 处理所有 / 命令
      const handled = await commands.run(prompt);
      if (handled) continue;

      // 19add: /plan 状态过渡（进入 plan mode，不能简单用 CommandRegistry）
      if (prompt === "/plan" && mode !== "plan") {
        mode = "plan";
        console.log("Enabled plan mode. Describe the task to plan.");
        continue;
      }

      if (mode === "plan") {
        await runPrompt(session, prompt, mode);
        continue;
      }

      // 19add: 非命令输入 → 走 Agent Loop
      await runPrompt(session, prompt, mode);
    }
  } finally {
    rl.close();
  }
}

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

        // 21add: retry/fallback events from resilient client
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

function printSessionBanner(
  mode: "new" | "resume" | "continue",
  session: ChatSession,
): void {
  const action =
    mode === "new" ? "started" : mode === "resume" ? "resumed" : "continued";

  console.log(`[session] ${action} ${session.sessionId}`);
  console.log(`[transcript] ${session.transcriptPath}`);

  if (session.history.length > 0) {
    console.log(`[history] restored ${session.history.length} message(s)`);
  }
}

function printTools(toolRegistry: ToolRegistry): void {
  for (const tool of toolRegistry.list()) {
    console.log(`- ${tool.name}: ${tool.description}`);
  }
}

async function runManualTool(
  prompt: string,
  toolRegistry: ToolRegistry,
): Promise<void> {
  const { name, input } = parseToolCommand(prompt);
  const result = await toolRegistry.execute(name, input);

  console.log(result.content);
  printDiff(result.diff);

  if (result.metadata) {
    console.log(JSON.stringify(result.metadata, null, 2));
  }
}

function parseToolCommand(prompt: string): { name: string; input: unknown } {
  const rest = prompt.slice("/tool ".length).trim();
  const firstSpaceIndex = rest.indexOf(" ");

  if (firstSpaceIndex === -1) {
    return {
      name: rest,
      input: {},
    };
  }

  const name = rest.slice(0, firstSpaceIndex).trim();
  const json = rest.slice(firstSpaceIndex + 1).trim();

  return {
    name,
    input: json ? JSON.parse(json) : {},
  };
}

function printDiff(diff: string | undefined): void {
  if (!diff) {
    return;
  }

  console.log(diff);
}

// 17add: /memory — 打印当前加载的所有记忆文件
async function printMemory(session: ChatSession): Promise<void> {
  const files = await session.memory.listFiles();
  if (files.length === 0) {
    console.log("No memory files loaded.");
    return;
  }

  console.log("Loaded memory files:");
  for (const file of files) {
    console.log(`- ${file.scope.padEnd(7)} ${file.path}`);
  }
}

// 17add: /remember — 追加内容到 CLAUDE.local.md 并刷新缓存
async function remember(session: ChatSession, text: string): Promise<void> {
  const path = await appendLocalMemory(session.memory.cwd, text);
  await session.memory.reload();
  console.log(`Saved local memory: ${path}`);
}

// 18add: /context — 展示当前上下文 token 预算使用情况
async function printContext(session: ChatSession): Promise<void> {
  const memoryPrompt = await session.memory.getPrompt();
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

  console.log(lines.join("\n"));
}

function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}

// 19add: 注册内置 slash command 到 CommandRegistry
function registerBuiltinCommands(
  commands: CommandRegistry,
  session: ChatSession,
  options: ChatLoopOptions,
  getMode: () => "default" | "plan",
): void {
  let currentMode = getMode;
  // Override mode getter with mutable ref
  let modeRef = { value: "default" as "default" | "plan" };

  commands.register("clear", async () => {
    session.clear();
    console.log("Conversation cleared.");
  });

  commands.register("tools", async () => {
    printTools(options.toolRegistry);
  });

  commands.register("context", async () => {
    await printContext(session);
  });

  commands.register("memory", async () => {
    await printMemory(session);
  });

  commands.register("remember", async (args) => {
    if (!args) {
      console.log("Usage: /remember <content>");
      return;
    }
    await remember(session, args);
  });

  commands.register("plan", async (args) => {
    if (!args) {
      if (modeRef.value !== "plan") {
        modeRef.value = "plan";
        console.log("Enabled plan mode. Describe the task to plan.");
        return;
      }
      const plan = session.currentPlan;
      console.log(plan ? renderPlan(plan) : "Already in plan mode. No plan written yet.");
      return;
    }

    if (args === "show") {
      console.log(renderPlan(session.currentPlan));
      return;
    }

    if (args === "clear") {
      const cleared = session.clearPlan();
      await options.sessionStore.appendPlan(session.sessionId, cleared.plan);
      console.log("Plan cleared.");
      return;
    }

    if (args === "exit") {
      modeRef.value = "default";
      console.log("Exited plan mode.");
      return;
    }

    // /plan <args> — run as plan mode prompt
    modeRef.value = "plan";
    await runPrompt(session, args, "plan");
  });

  commands.register("tool", async (args) => {
    if (!args) {
      console.log("Usage: /tool <name> [json]");
      return;
    }
    await runManualTool(`/tool ${args}`, options.toolRegistry);
  });

  // 20add: /models — display model route table
  commands.register("models", async () => {
    console.log(renderModelRoutes());
  });

  // 20add: /model — show or set session main model
  commands.register("model", async (args) => {
    if (!args) {
      const current = modelRouter.resolve({ role: "main" });
      console.log(`Current main model: ${current.model}`);
      console.log(`Reason: ${current.reason}`);
      return;
    }

    if (args === "default") {
      setSessionModelOverride(null);
      const current = modelRouter.resolve({ role: "main" });
      console.log(`Main model reset to default: ${current.model}`);
      return;
    }

    setSessionModelOverride(args);
    const current = modelRouter.resolve({ role: "main" });
    console.log(`Main model set to: ${current.model}`);
  });
}

// 19add: 注册插件命令到 CommandRegistry
function registerPluginCommands(
  commands: CommandRegistry,
  session: ChatSession,
  pluginRegistry: PluginRegistry,
  toolRegistry: ToolRegistry,
): void {
  // /reload-plugins
  commands.register("reload-plugins", async () => {
    const runtime = await pluginRegistry.reload();
    // 19add: 刷新后更新 ToolRegistry 中的插件工具
    reloadPluginTools(toolRegistry, pluginRegistry);
    console.log(
      [
        `Reloaded ${runtime.enabledCount} plugins.`,
        `Commands: ${runtime.commands.length}`,
        `Tools: ${runtime.tools.length}`,
        runtime.errors.length > 0 ? `Errors: ${runtime.errors.length}` : null,
      ].filter(Boolean).join("\n"),
    );
  });

  // /plugin [list|enable|disable] — install 走 CLI 子命令，REPL 内不支持
  commands.register("plugin", async (args) => {
    if (!args || args === "list") {
      const installed = await listInstalledPlugins();
      const rows = Object.values(installed.plugins);

      if (rows.length === 0) {
        console.log("No plugins installed.");
        return;
      }

      console.log("Installed plugins:");
      for (const plugin of rows) {
        const state = plugin.enabled ? "enabled" : "disabled";
        console.log(`- ${plugin.name}  ${state}  ${plugin.version ?? "unknown"}`);
      }
      return;
    }

    const [action, target] = args.trim().split(/\s+/);
    if (!action) {
      console.log("Usage: /plugin [list|enable|disable]");
      return;
    }

    if (action === "enable") {
      if (!target) {
        console.log("Usage: /plugin enable <name>");
        return;
      }
      await setPluginEnabled(target, true);
      console.log(`Enabled plugin: ${target}. Run /reload-plugins to apply.`);
      return;
    }

    if (action === "disable") {
      if (!target) {
        console.log("Usage: /plugin disable <name>");
        return;
      }
      await setPluginEnabled(target, false);
      console.log(`Disabled plugin: ${target}. Run /reload-plugins to apply.`);
      return;
    }

    console.log("Usage: /plugin [list|enable|disable]");
  });

  // 19add: 注册插件自定义命令
  for (const cmd of pluginRegistry.getRuntime().commands) {
    commands.register(cmd.name, async (args) => {
      const msgs = await cmd.getPrompt(args);
      // 19add: 将插件命令的 prompt 作为 user message 注入并执行
      for (const msg of msgs) {
        await runPrompt(session, typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content), "default");
      }
    });
  }
}

// 19add: 重新加载插件工具到 ToolRegistry（需外部传入引用）
function reloadPluginTools(
  toolRegistry: ToolRegistry,
  pluginRegistry: PluginRegistry,
): void {
  // 插件工具通过 PluginTool 接口运行，此处留空 —
  // 当前设计: 插件工具在 createSessionToolRegistry 时注册，
  // 动态刷新需额外机制; 先通过重启会话生效
  const tools = pluginRegistry.getTools();
  if (tools.length > 0) {
    console.log(`Plugin tools loaded: ${tools.length}. Restart session to apply.`);
  }
}
