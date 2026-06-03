// 15fix-toolrunner: 本地 ToolResult 改名为 ExecutedToolResult，消除与 tools/types.ts 的 ToolResult 类型冲突
import {
  approvalKeyForToolInput,
  promptForToolApproval,
  summarizeToolInput,
} from "../permissions";
import type { Tool, ToolContext, ToolResult } from "../tools/types";

export type ToolUse = {
  id: string;
  name: string;
  input: unknown;
};

// 15update-toolrunner: 重命名避免与 tools/types 的 ToolResult 冲突
export type ExecutedToolResult = {
  toolUseId: string;
  content: string;
  isError: boolean;
};

export async function runToolUse(
  toolUse: ToolUse,
  tool: Tool<unknown>,
  context: ToolContext,
): Promise<ExecutedToolResult> {
  const parsed = tool.inputSchema.safeParse(toolUse.input);

  if (!parsed.success) {
    return toolError(
      toolUse.id,
      `InputValidationError: ${parsed.error.message}`,
    );
  }

  const input = parsed.data;
  const permission = await checkToolPermission(tool, input, context);

  if (permission.behavior === "deny") {
    return toolError(toolUse.id, permission.message);
  }

  if (permission.behavior === "ask") {
    const approval = await promptForToolApproval(
      {
        toolName: tool.name,
        inputSummary: summarizeToolInput(
          tool.name,
          input as Record<string, unknown>,
        ),
        reason: permission.message,
        approvalKey:
          permission.approvalKey ??
          approvalKeyForToolInput(
            tool.name,
            input as Record<string, unknown>,
          ),
      },
      context.askUser,
    );

    if (approval.behavior === "deny") {
      return toolError(
        toolUse.id,
        approval.feedback
          ? `Permission denied by user: ${approval.feedback}`
          : "Permission denied by user.",
      );
    }

    if (approval.scope === "session") {
      context.permissions.addSessionAllow(
        permission.approvalKey ??
          approvalKeyForToolInput(
            tool.name,
            input as Record<string, unknown>,
          ),
      );
      console.log("[permission] allowed for this session");
    } else {
      console.log("[permission] allowed once");
    }
  }

  try {
    // 15fix-toolrunner: tool.execute() 返回 ToolResult (tools/types)，解构拿 content 字符串
    const result: ToolResult = await tool.execute(input, context);
    return {
      toolUseId: toolUse.id,
      content: result.content,
      isError: false,
    };
  } catch (error) {
    return toolError(
      toolUse.id,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function checkToolPermission(
  tool: Tool<unknown>,
  input: unknown,
  context: ToolContext,
) {
  const key = approvalKeyForToolInput(
    tool.name,
    input as Record<string, unknown>,
  );

  if (context.permissions.hasSessionAllow(key)) {
    return {
      behavior: "allow" as const,
      message: "Allowed by session permission.",
      approvalKey: key,
    };
  }

  if (!tool.checkPermissions) {
    return {
      behavior: "allow" as const,
      message: "Tool does not require explicit permission.",
      approvalKey: key,
    };
  }

  const decision = await tool.checkPermissions(input, context);

  return {
    ...decision,
    approvalKey: decision.approvalKey ?? key,
  };
}

function toolError(
  toolUseId: string,
  content: string,
): ExecutedToolResult {
  return {
    toolUseId,
    content,
    isError: true,
  };
}
