import { AgentLoop, type AgentLoopEvent } from "../agent";
import type { ChatMessage, LLMConfig } from "../llm/types";
import type { ToolRegistry } from "../tools";
// 18add: ContextPreparer 替代裸 ContextManager，统一构建 system + 预算裁剪
import { ContextPreparer } from "../context";
import type { LoadedSession, SessionStore } from "../session";
import { PlannerStore } from "../planner";
import type { Plan } from "../planner";
// 17add: MemoryStore 注入模型请求 system context
import { MemoryStore } from "../memory";
// 19add: PluginRegistry 注入插件上下文 + 命令
import type { PluginRegistry } from "../plugins";

type ChatSessionOptions = {
  maxTurns: number;
  contextWindow: number;
  loadedSession: LoadedSession;
  sessionStore: SessionStore;
  planner: PlannerStore;
  cwd: string;
  // 19add: 插件注册中心
  pluginRegistry: PluginRegistry;
};

export type ChatSessionEvent = AgentLoopEvent;

type SendUserMessageOptions = {
  mode?: "default" | "plan";
};

export class ChatSession {
  private readonly messages: ChatMessage[];
  private readonly agentLoop: AgentLoop;
  private readonly planner: PlannerStore;
  // 17add: MemoryStore 实例，供 chatLoop 调用 /memory /remember
  readonly memory: MemoryStore;
  // 18add: ContextPreparer 统一构建 system + 预算裁剪
  readonly contextPreparer: ContextPreparer;
  // 19add: PluginRegistry 供 chatLoop 调用 /plugin /reload-plugins
  readonly pluginRegistry: PluginRegistry;

  constructor(
    config: LLMConfig,
    toolRegistry: ToolRegistry,
    private readonly options: ChatSessionOptions,
  ) {
    // 18add: ContextPreparer 自带 ContextManager 的 compaction 能力
    this.contextPreparer = new ContextPreparer();

    this.messages = [...options.loadedSession.messages];
    this.planner = options.planner;
    // 17add: 初始化 MemoryStore，基于当前工作目录加载记忆
    this.memory = new MemoryStore(options.cwd);
    // 19add: 注入 PluginRegistry
    this.pluginRegistry = options.pluginRegistry;
    this.agentLoop = new AgentLoop(config, toolRegistry, this.contextPreparer);
  }

  // 18add: 基础 system prompt — 可被子类或配置覆盖
  get baseSystemPrompt(): string {
    return "You are a helpful coding assistant. Use tools to read, write, and run code. Be concise.";
  }

  // 18add: 运行时上下文 — cwd, date, 插件上下文等运行时信息
  buildRuntimeContext(): string {
    const now = new Date().toISOString();
    // 19add: 注入插件上下文片段
    const pluginContext = this.pluginRegistry.getContextPrompt();
    const parts = [
      `Current date: ${now.slice(0, 10)}`,
      `Working directory: ${this.options.cwd}`,
      pluginContext,
    ];
    return parts.filter(Boolean).join("\n\n");
  }

  get currentPlan(): Plan | null {
    return this.planner.getPlan();
  }

  get plannerStore(): PlannerStore {
    return this.planner;
  }

  clearPlan(): { plan: Plan | null } {
    this.planner.clearPlan();
    return this.planner.consumeDirtyPlan()!;
  }

  get sessionId(): string {
    return this.options.loadedSession.metadata.sessionId;
  }

  get transcriptPath(): string {
    return this.options.loadedSession.path;
  }

  get history(): readonly ChatMessage[] {
    return this.messages;
  }

  clear(): void {
    this.messages.length = 0;
  }

  async *sendUserMessageStream(
    content: string,
    options: SendUserMessageOptions = {},
  ): AsyncGenerator<ChatSessionEvent, void> {
    const historyLengthBeforeTurn = this.messages.length;
    const mode = options.mode ?? "default";

    this.messages.push({
      role: "user",
      content: mode === "plan" ? buildPlanModePrompt(content) : content,
    });

    try {
      // 18add: ContextPreparer 构建 system + 预算裁剪后的 messages 视图
      const memoryPrompt = await this.memory.getPrompt();
      const runtimeContext = this.buildRuntimeContext();

      const prepared = this.contextPreparer.prepare({
        systemPrompt: this.baseSystemPrompt,
        memoryPrompt,
        runtimeContext,
        messages: this.messages,
      });

      yield* this.agentLoop.run(prepared.messages, {
        maxTurns: this.options.maxTurns,
        mode,
        // 18add: 传递完整 system（base + memory + runtime context）
        system: prepared.system,
      });

      await this.options.sessionStore.appendMessages(
        this.sessionId,
        this.messages.slice(historyLengthBeforeTurn),
      );

      const dirtyPlan = this.planner.consumeDirtyPlan();
      if (dirtyPlan) {
        await this.options.sessionStore.appendPlan(
          this.sessionId,
          dirtyPlan.plan,
        );
      }
    } catch (error) {
      this.messages.length = historyLengthBeforeTurn;
      throw error;
    }
  }
}

function buildPlanModePrompt(content: string): string {
  return `You are in plan mode.

Rules:
- Explore and plan only.
- Do not write, edit, or create files.
- Use read-only tools when you need to inspect the project.
- Use update_plan to create or update the plan.
- Keep exactly one plan item in_progress while planning.
- When the plan is ready, explain the plan and wait for the user instead of implementing it.

User request to plan:
${content}`;
}
