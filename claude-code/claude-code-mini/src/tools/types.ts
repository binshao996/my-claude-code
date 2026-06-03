import type { z } from "zod";
import type { PlannerStore } from "../planner";
import type { SandboxPolicyEngine } from "../sandbox";
import type { ChatMessage } from "../llm/types";
import type {
  AskUser,
  PermissionStore,
  ToolPermissionDecision,
} from "../permissions";

export type ToolInputJSONSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ReadFileStateEntry = {
  content: string;
  mtimeMs: number;
};

export type ToolContext = {
  cwd: string;
  readFileState: Map<string, ReadFileStateEntry>;
  sessionId: string;
  messages: readonly ChatMessage[];
  planner: PlannerStore;
  sandbox: SandboxPolicyEngine;
  permissions: PermissionStore;
  askUser: AskUser;
};

export type ToolResult = {
  content: string;
  metadata?: Record<string, unknown>;
  diff?: string;
};

export type Tool<Input = unknown> = {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  inputJSONSchema: ToolInputJSONSchema;
  isReadOnly: boolean;
  checkPermissions?: (
    input: Input,
    context: ToolContext,
  ) => Promise<ToolPermissionDecision> | ToolPermissionDecision;
  execute(input: Input, context: ToolContext): Promise<ToolResult>;
};

export type ToolSummary = {
  name: string;
  description: string;
  inputJSONSchema: ToolInputJSONSchema;
  isReadOnly: boolean;
};
