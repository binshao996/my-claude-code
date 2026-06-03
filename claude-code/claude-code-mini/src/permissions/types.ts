export type ToolPermissionBehavior = "allow" | "ask" | "deny";

export type ToolPermissionDecision = {
  behavior: ToolPermissionBehavior;
  message: string;
  approvalKey?: string;
};

export type ToolApprovalRequest = {
  toolName: string;
  inputSummary: string;
  reason: string;
  approvalKey: string;
};

export type ToolApprovalResponse =
  | {
      behavior: "allow";
      scope: "once" | "session";
    }
  | {
      behavior: "deny";
      feedback?: string;
    };
