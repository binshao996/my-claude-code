import type { z } from "zod";
import type { Tool, ToolContext, ToolResult, ToolSummary } from "./types";

export class ToolRegistry {
  // 15add: Tool<any> avoids contravariance issues with checkPermissions input param
  private readonly tools = new Map<string, Tool<any>>();

  constructor(private readonly context: ToolContext) {}

  // 15add: 暴露 ToolContext 供 AgentLoop → runToolUse 使用
  getContext(): ToolContext {
    return this.context;
  }

  // 15add: chatLoop 创建 readline 后注入 askUser 到已存在的 ToolContext
  setAskUser(askUser: ToolContext["askUser"]): void {
    (this.context as { askUser: ToolContext["askUser"] }).askUser = askUser;
  }

  register(tool: Tool<any>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

    this.tools.set(tool.name, tool);
  }

  list(): ToolSummary[] {
    return [...this.tools.values()].map(tool => ({
      name: tool.name,
      description: tool.description,
      inputJSONSchema: tool.inputJSONSchema,
      isReadOnly: tool.isReadOnly,
    }));
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  async execute(name: string, rawInput: unknown): Promise<ToolResult> {
    const tool = this.get(name);

    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    const parsed = tool.inputSchema.safeParse(rawInput);

    if (!parsed.success) {
      throw new Error(
        `Invalid input for tool "${name}": ${formatZodError(parsed.error)}`,
      );
    }

    return tool.execute(parsed.data, this.context);
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map(issue => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
