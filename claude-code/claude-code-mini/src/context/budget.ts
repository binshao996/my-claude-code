// 18add: Context budget configuration — window, reserves, per-category limits
export type ContextBudgetConfig = {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  compactBufferTokens: number;
  memoryBudgetTokens: number;
  runtimeBudgetTokens: number;
  maxToolResultTokens: number;
};

export const DEFAULT_CONTEXT_BUDGET: ContextBudgetConfig = {
  contextWindowTokens: 200_000,
  reservedOutputTokens: 8_000,
  compactBufferTokens: 13_000,
  memoryBudgetTokens: 20_000,
  runtimeBudgetTokens: 12_000,
  maxToolResultTokens: 4_000,
};

export function getEffectiveInputBudget(config: ContextBudgetConfig): number {
  return Math.max(
    0,
    config.contextWindowTokens -
      config.reservedOutputTokens -
      config.compactBufferTokens,
  );
}

export function readBudgetConfigFromEnv(): ContextBudgetConfig {
  const contextWindow = Number(process.env.CCMINI_CONTEXT_WINDOW_TOKENS);

  return {
    ...DEFAULT_CONTEXT_BUDGET,
    contextWindowTokens:
      Number.isFinite(contextWindow) && contextWindow > 0
        ? contextWindow
        : DEFAULT_CONTEXT_BUDGET.contextWindowTokens,
  };
}
