import { stdout } from "node:process";
import {
  Command as CommanderCommand,
  InvalidArgumentError,
} from "commander";
import { ChatSession } from "./chat/session";
import { runChatLoop } from "./chat/chatLoop";
import { loadLLMConfig } from "./llm/config";
import type { LLMConfig, LLMResponse } from "./llm/types";
import { CLI_NAME, PRODUCT_NAME, VERSION } from "./constants";
import {
  createDefaultToolRegistry,
  type ToolContext,
  type ToolRegistry,
} from "./tools";
import { SessionStore, type LoadedSession, type SessionListItem } from "./session";
import { PlannerStore } from "./planner";
import {
  createToolInputProgress,
  finishToolInputProgress,
  formatToolInput,
  shouldPrintToolInputProgress,
  startToolInputProgress,
} from "./chat/toolInputFormatter";
// 15add: 导入权限模块
import { parseSandboxMode, SandboxPolicyEngine, type SandboxMode } from "./sandbox";
import { PermissionStore, type AskUser } from "./permissions";
// 19add: 插件系统 — 安装、加载、注入上下文
import { installPluginFromPath, PluginRegistry } from "./plugins";

type RootOptions = {
  contextWindow: number;
  print?: boolean;
  cwd: string;
  model?: string;
  maxTurns: number;
  session?: string;
  resume?: string;
  continue?: boolean;
  listSessions?: boolean;
  sandbox?: string;
  commandTimeout?: number;
};

type SessionStartMode = "new" | "resume" | "continue";

type ResolvedStartupSession = {
  mode: SessionStartMode;
  loadedSession: LoadedSession;
};

const DEFAULT_CONTEXT_WINDOW = 32_000;

export async function main(argv = process.argv): Promise<CommanderCommand> {
  const program = new CommanderCommand();

  program
    .name(CLI_NAME)
    .description(
      `${PRODUCT_NAME} - starts a coding-agent session by default, use -p/--print for non-interactive output`,
    )
    .argument("[prompt...]", "Your prompt")
    .helpOption("-h, --help", "Display help for command")
    .option(
      "-p, --print",
      "Print response and exit. This will become the headless mode in later chapters.",
      false,
    )
    .option("--cwd <path>", "Working directory for the session", process.cwd())
    .option("--model <model>", "Override the model for this request")
    .option(
      "--max-turns <number>",
      "Maximum model/tool iterations per user prompt",
      parsePositiveInteger,
      8,
    )
    .option(
      "--context-window <tokens>",
      "Estimated input context window for Claude Code Mini.",
      parsePositiveInteger,
      DEFAULT_CONTEXT_WINDOW,
    )
    .option("--session <id>", "Use a specific session id for a new session.")
    .option("--resume <id>", "Resume a session by id.")
    .option("--continue", "Continue the most recent session in the current project.")
    .option("--list-sessions", "List sessions for the current project.")
    .option("--sandbox <mode>", "Sandbox mode: read_only | workspace_write | dangerous", "read_only")
    .option("--command-timeout <ms>", "Command timeout in milliseconds", parsePositiveInteger, 30_000)
    .version(`${VERSION} (${PRODUCT_NAME})`, "-v, --version", "Output the version number")
    .action(async (promptParts: string[] | undefined, options: RootOptions) => {
      await handlePrompt(promptParts ?? [], options);
    });

  // 19add: plugin install subcommand — install from local path
  program
    .command("plugin")
    .command("install")
    .argument("<path>", "Path to plugin directory")
    .action(async (pluginPath: string) => {
      try {
        const name = await installPluginFromPath(pluginPath);
        console.log(`Installed plugin: ${name}. Run /reload-plugins in REPL to apply.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exitCode = 1;
      }
    });

  await program.parseAsync(argv);
  return program;
}

async function handlePrompt(
  promptParts: string[],
  options: RootOptions,
): Promise<void> {
  const prompt = promptParts.join(" ").trim();

  try {
    const config = loadLLMConfig();
    if (options.model) {
      config.model = options.model;
    }

    const sessionStore = new SessionStore(options.cwd);

    if (options.listSessions) {
      printSessionList(await sessionStore.listSessions());
      return;
    }

    const startupSession = await resolveStartupSession(sessionStore, {
      session: options.session,
      resume: options.resume,
      continue: options.continue,
    });

    const planner = new PlannerStore(
      startupSession.loadedSession.metadata.sessionId,
      startupSession.loadedSession.plan,
    );
    // 19add: 创建 PluginRegistry 并在启动时加载已安装插件
    const pluginRegistry = new PluginRegistry();
    await pluginRegistry.reload();

    // 15add: no-op askUser for non-interactive path; chatLoop injects real one via setAskUser()
    const noOpAskUser: AskUser = async () => "no";
    const toolRegistry = createSessionToolRegistry(
      options.cwd,
      planner,
      parseSandboxMode(options.sandbox),
      options.commandTimeout ?? 30_000,
      noOpAskUser,
      // 19add: 插件工具注入到 ToolRegistry
      pluginRegistry,
    )
    if (prompt) {
      const session = new ChatSession(config, toolRegistry, {
        maxTurns: options.maxTurns,
        contextWindow: options.contextWindow,
        loadedSession: startupSession.loadedSession,
        sessionStore,
        planner,
        // 17add: MemoryStore 需要 cwd 加载项目记忆文件
        cwd: options.cwd,
        // 19add: PluginRegistry 注入插件上下文 + 命令
        pluginRegistry,
      });

      await runSinglePrompt(session, prompt, options);
      return;
    }

    if (options.print) {
      console.error("Error: -p/--print requires a prompt.");
      process.exitCode = 1;
      return;
    }

    if (!process.stdin.isTTY) {
      console.error("Error: interactive mode requires a TTY. Pass a prompt or use -p.");
      process.exitCode = 1;
      return;
    }

    await runChatLoop(config, {
      cwd: options.cwd,
      toolRegistry,
      maxTurns: options.maxTurns,
      contextWindow: options.contextWindow,
      loadedSession: startupSession.loadedSession,
      sessionStore,
      sessionStartMode: startupSession.mode,
      planner,
      // 19add: PluginRegistry 注入插件上下文 + 命令
      pluginRegistry,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

async function runSinglePrompt(
  session: ChatSession,
  prompt: string,
  options: RootOptions,
): Promise<void> {
  let finalResponse: LLMResponse | undefined;
  const toolInputProgress = createToolInputProgress();

  for await (const event of session.sendUserMessageStream(prompt)) {
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
        stdout.write(event.text);
        break;

      case "tool_use_start":
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

  if (!options.print && finalResponse) {
    console.log("");
    console.log(`model: ${finalResponse.model}`);
    console.log(
      `tokens: ${finalResponse.inputTokens} input / ${finalResponse.outputTokens} output`,
    );
    console.log(`cwd: ${options.cwd}`);
    console.log(`max turns: ${options.maxTurns}`);
  }
}

function createSessionToolRegistry(
  cwd: string,
  planner: PlannerStore,
  sandboxMode: SandboxMode,
  commandTimeoutMs: number,
  // 15add: askUser 注入 ToolContext，供 promptForToolApproval 复用
  askUser: AskUser,
  // 19add: PluginRegistry 注入插件工具
  pluginRegistry: PluginRegistry,
): ToolRegistry {
  const sandbox = new SandboxPolicyEngine({
    cwd,
    mode: sandboxMode,
    commandTimeoutMs,
    maxOutputBytes: 64 * 1024,
  });

  // 15add: 创建 PermissionStore，本会话 always allow 记录
  const permissions = new PermissionStore();

  const readFileState: ToolContext["readFileState"] = new Map();

  return createDefaultToolRegistry({
    cwd,
    readFileState,
    sessionId: "",  // 由 ChatSession 在实际使用时填充
    messages: [],
    planner,
    sandbox,
    permissions,  // 15add
    askUser,      // 15add
    // 19add: 注册插件工具
    pluginTools: pluginRegistry.getTools(),
  });
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Expected a positive integer.");
  }

  return parsed;
}

function printDiff(diff: string | undefined): void {
  if (!diff) {
    return;
  }

  console.log(diff);
}

async function resolveStartupSession(
  sessionStore: SessionStore,
  options: {
    session?: string;
    resume?: string;
    continue?: boolean;
  },
): Promise<ResolvedStartupSession> {
  if (options.resume && options.continue) {
    throw new Error("Use either --resume or --continue, not both.");
  }

  if (options.session && (options.resume || options.continue)) {
    throw new Error("--session can only be used when starting a new session.");
  }

  if (options.resume) {
    const loadedSession = await sessionStore.loadSession(options.resume);

    if (!loadedSession) {
      throw new Error(`Session not found: ${options.resume}`);
    }

    return {
      mode: "resume",
      loadedSession,
    };
  }

  if (options.continue) {
    const loadedSession = await sessionStore.getLatestSession();

    if (!loadedSession) {
      throw new Error("No session found to continue.");
    }

    return {
      mode: "continue",
      loadedSession,
    };
  }

  return {
    mode: "new",
    loadedSession: await sessionStore.createSession(options.session),
  };
}

function printSessionList(sessions: readonly SessionListItem[]): void {
  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  console.log("Session ID                            Updated At                 Messages  First Prompt");

  for (const session of sessions) {
    console.log(
      `${session.sessionId.padEnd(36)}  ${session.updatedAt.padEnd(24)}  ${String(
        session.messageCount,
      ).padStart(8)}  ${session.firstPrompt}`,
    );
  }
}
