// 15update-loop: 导入 runToolUse 以接入权限审批流程
import { runToolUse, type ExecutedToolResult as ToolRunnerResult } from "./toolRunner";
// 21add: 替换 streamMessage → streamMessageResilient，自带 retry + fallback
import { streamMessageResilient } from "../llm/resilientAnthropic";
import type { RetryEvent } from "../llm/retry";
import type { FallbackEvent } from "../llm/fallback";
import type {
  ChatMessage,
  LLMConfig,
  LLMResponse,
  LLMStreamEvent,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "../llm/types";
import type { ToolRegistry, ToolResult, ToolSummary } from "../tools";
// 18add: ContextPreparer 替代 ContextManager 做 message 级别的预算裁剪
import type { ContextPreparer, ContextPreparationResult } from "../context";
// 20add: Model route request for role-based model selection
import type { ModelRouteRequest } from "../models";

export type AgentLoopOptions = {
  maxTurns: number;
  mode?: "default" | "plan";
  system?: string | null;
};

// 15update-loop: 内部类型改名避免与 toolRunner 导出的 ExecutedToolResult 冲突
type AgentToolResult = {
  block: ToolResultContentBlock;
  rawResult?: ToolResult;
};

export type AgentLoopEvent =
  | LLMStreamEvent
  | RetryEvent
  | FallbackEvent
  | {
      type: "context_update";
      beforeTokens: number;
      afterTokens: number;
      compactedToolResults: number;
      trimmedMessages: number;
    }
  | {
      type: "turn_start";
      turn: number;
    }
  | {
      type: "turn_complete";
      turn: number;
      stopReason: string | null;
      toolUseCount: number;
    }
  | {
      type: "tool_start";
      turn: number;
      toolUse: ToolUseContentBlock;
    }
  | {
      type: "tool_result";
      turn: number;
      toolUse: ToolUseContentBlock;
      result: ToolResultContentBlock;
      rawResult?: ToolResult;
    }
  | {
      type: "max_turns_reached";
      maxTurns: number;
    };

export class AgentLoop {
  constructor(
    private readonly config: LLMConfig,
    private readonly toolRegistry: ToolRegistry,
    // 18add: ContextPreparer 提供 compaction + budget enforcement
    private readonly contextPreparer: ContextPreparer,
  ) {}

  async *run(
    messages: ChatMessage[],
    options: AgentLoopOptions,
  ): AsyncGenerator<AgentLoopEvent, void> {
    if (options.maxTurns < 1) {
      throw new Error("maxTurns must be greater than or equal to 1.");
    }

    for (let turn = 1; turn <= options.maxTurns; turn++) {
      yield {
        type: "turn_start",
        turn,
      };

      const response = yield* this.runAssistantTurn(
        messages,
        this.listTools(options.mode),
        options.system,
        options.mode,
      );

      messages.push({
        role: "assistant",
        content: response.content,
      });

      yield {
        type: "turn_complete",
        turn,
        stopReason: response.stopReason,
        toolUseCount: response.toolUses.length,
      };

      if (response.toolUses.length === 0) {
        return;
      }

      const toolResults: ToolResultContentBlock[] = [];

      for (const toolUse of response.toolUses) {
        yield {
          type: "tool_start",
          turn,
          toolUse,
        };

        const executed = await this.executeToolUse(toolUse, options.mode);
        toolResults.push(executed.block);

        yield {
          type: "tool_result",
          turn,
          toolUse,
          result: executed.block,
          ...(executed.rawResult && { rawResult: executed.rawResult }),
        };
      }

      messages.push({
        role: "user",
        content: toolResults,
      });
    }

    yield {
      type: "max_turns_reached",
      maxTurns: options.maxTurns,
    };
  }

  private async *runAssistantTurn(
    messages: ChatMessage[],
    tools: ToolSummary[],
    system?: string | null,
    mode?: "default" | "plan",
  ): AsyncGenerator<AgentLoopEvent, LLMResponse> {
    // 18add: 使用 ContextPreparer 的内部 ContextManager 做 compaction
    // 然后应用工具结果预算裁剪后发送到 API
    const preparedContext = this.contextPreparer.contextManager.prepare(messages);

    if (preparedContext.changed) {
      yield createContextUpdateEvent(preparedContext);
    }

    // 20add: route model selection through ModelRouter
    const route: ModelRouteRequest = {
      role: mode === "plan" ? "planner" : "main",
      permissionMode: mode,
    };

    let finalResponse: LLMResponse | undefined;

    for await (const event of streamMessageResilient(
      preparedContext.messages,
      tools,
      this.config,
      system,
      route,
    )) {
      if (event.type === "message_stop") {
        finalResponse = event.response;
      }

      yield event;
    }

    if (!finalResponse) {
      throw new Error("The stream ended before a final response was received.");
    }

    return finalResponse;
  }

  // 15update-loop: executeToolUse 改用 runToolUse()，让权限审批在工具执行前介入
  private async executeToolUse(
    toolUse: ToolUseContentBlock,
    mode: AgentLoopOptions["mode"],
  ): Promise<AgentToolResult> {
    // plan mode 工具过滤
    if (!this.isToolAllowed(toolUse.name, mode)) {
      return {
        block: {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Tool "${toolUse.name}" is not allowed in plan mode.`,
          is_error: true,
        },
      };
    }

    const tool = this.toolRegistry.get(toolUse.name);
    if (!tool) {
      return {
        block: {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Unknown tool: ${toolUse.name}`,
          is_error: true,
        },
      };
    }

    // 15update-loop: 原 this.toolRegistry.execute() → 现统一走 runToolUse
    // runToolUse 内部处理：zod 校验 → checkPermissions → ask 审批 → execute
    const result: ToolRunnerResult = await runToolUse(
      { id: toolUse.id, name: toolUse.name, input: toolUse.input },
      tool,
      this.toolRegistry.getContext(),
    );

    return {
      block: {
        type: "tool_result",
        tool_use_id: result.toolUseId,
        content: result.content,
        is_error: result.isError,
      },
    };
  }

  private listTools(mode: AgentLoopOptions["mode"]): ToolSummary[] {
    const tools = this.toolRegistry.list();

    if (mode !== "plan") {
      return tools;
    }

    return tools.filter(tool => isPlanModeToolAllowed(tool));
  }

  private isToolAllowed(
    toolName: string,
    mode: AgentLoopOptions["mode"],
  ): boolean {
    if (mode !== "plan") {
      return true;
    }

    const tool = this.toolRegistry.get(toolName);
    return tool ? isPlanModeToolAllowed(tool) : false;
  }
}

function isPlanModeToolAllowed(tool: ToolSummary): boolean {
  return tool.isReadOnly || tool.name === "update_plan";
}

function createContextUpdateEvent(preparedContext: ContextPreparationResult): {
  type: "context_update";
  beforeTokens: number;
  afterTokens: number;
  compactedToolResults: number;
  trimmedMessages: number;
} {
  return {
    type: "context_update",
    beforeTokens: preparedContext.beforeTokens,
    afterTokens: preparedContext.afterTokens,
    compactedToolResults: preparedContext.compactedToolResults,
    trimmedMessages: preparedContext.trimmedMessages,
  };
}
