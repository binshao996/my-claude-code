// 18add: ContextPreparer — unified request preparation with budget enforcement
import { CLEARED_TOOL_RESULT, ContextManager, createDefaultContextOptions } from "./manager";
import {
  type ContextBudgetConfig,
  DEFAULT_CONTEXT_BUDGET,
  getEffectiveInputBudget,
} from "./budget";
import { estimateMessagesTokens, estimateTokens } from "./tokenCounter";
import type { ChatMessage } from "../llm/types";
import { truncateTextToTokens } from "./truncate";
import { applyToolResultBudget } from "./toolResultBudget";

export type ContextCategory = {
  name: string;
  tokens: number;
};

export type PreparedContext = {
  system: string;
  messages: ChatMessage[];
  categories: ContextCategory[];
  totalTokens: number;
  effectiveInputBudget: number;
  contextWindowTokens: number;
  truncated: boolean;
};

export type PrepareContextInput = {
  systemPrompt: string;
  memoryPrompt: string | null;
  runtimeContext: string;
  messages: ChatMessage[];
  config?: ContextBudgetConfig;
};

function fitSection(name: string, text: string, maxTokens: number): {
  name: string;
  text: string;
  tokens: number;
  truncated: boolean;
} {
  if (!text.trim()) {
    return { name, text: "", tokens: 0, truncated: false };
  }

  const result = truncateTextToTokens(text, maxTokens);
  return {
    name,
    text: result.text,
    tokens: result.finalTokens,
    truncated: result.truncated,
  };
}

function keepNewestMessages(messages: ChatMessage[], maxTokens: number): {
  messages: ChatMessage[];
  tokens: number;
  truncated: boolean;
} {
  const kept: ChatMessage[] = [];
  let used = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const blockTokens = estimateMessagesTokens([message]);

    if (kept.length > 0 && used + blockTokens > maxTokens) {
      break;
    }

    kept.unshift(message);
    used += blockTokens;
  }

  return {
    messages: kept,
    tokens: used,
    truncated: kept.length < messages.length,
  };
}

export class ContextPreparer {
  readonly contextManager: ContextManager;

  constructor(
    private readonly config: ContextBudgetConfig = DEFAULT_CONTEXT_BUDGET,
  ) {
    this.contextManager = new ContextManager(
      createDefaultContextOptions(config.contextWindowTokens),
    );
  }

  prepare(input: PrepareContextInput): PreparedContext {
    const config = input.config ?? this.config;
    const effectiveInputBudget = getEffectiveInputBudget(config);

    const systemTokens = estimateTokens(input.systemPrompt);
    const memory = fitSection(
      "Memory files",
      input.memoryPrompt ?? "",
      config.memoryBudgetTokens,
    );
    const runtime = fitSection(
      "Runtime context",
      input.runtimeContext,
      config.runtimeBudgetTokens,
    );

    const fixedTokens = systemTokens + memory.tokens + runtime.tokens;
    const messageBudget = Math.max(0, effectiveInputBudget - fixedTokens);

    // 18add: compose system from sections, apply tool result & message budget
    const system = [input.systemPrompt, memory.text, runtime.text]
      .filter((part) => part.trim().length > 0)
      .join("\n\n");

    const toolBudgeted = applyToolResultBudget(
      input.messages,
      config.maxToolResultTokens,
    );
    const messages = keepNewestMessages(toolBudgeted.messages, messageBudget);

    const totalTokens = fixedTokens + messages.tokens;

    const categories: ContextCategory[] = [
      { name: "System prompt", tokens: systemTokens },
      { name: "Memory files", tokens: memory.tokens },
      { name: "Runtime context", tokens: runtime.tokens },
      { name: "Messages", tokens: messages.tokens },
      {
        name: "Free space",
        tokens: Math.max(0, effectiveInputBudget - totalTokens),
      },
      { name: "Reserved output", tokens: config.reservedOutputTokens },
      { name: "Compact buffer", tokens: config.compactBufferTokens },
    ];

    return {
      system,
      messages: messages.messages,
      categories,
      totalTokens,
      effectiveInputBudget,
      contextWindowTokens: config.contextWindowTokens,
      truncated:
        memory.truncated ||
        runtime.truncated ||
        messages.truncated ||
        toolBudgeted.report.truncatedToolResults > 0,
    };
  }
}
