import type { ToolApprovalRequest, ToolApprovalResponse } from "./types";

export type AskUser = (prompt: string) => Promise<string>;

export async function promptForToolApproval(
  request: ToolApprovalRequest,
  askUser: AskUser,
): Promise<ToolApprovalResponse> {
  console.log("");
  console.log("Permission required");
  console.log(`tool: ${request.toolName}`);
  console.log(`reason: ${request.reason}`);
  console.log(`input: ${request.inputSummary}`);
  console.log("");

  while (true) {
    const answer = (
      await askUser("Allow? [y]es / [a]lways this session / [n]o: ")
    )
      .trim()
      .toLowerCase();

    if (answer === "y" || answer === "yes") {
      return { behavior: "allow", scope: "once" };
    }

    if (answer === "a" || answer === "always") {
      return { behavior: "allow", scope: "session" };
    }

    if (answer === "n" || answer === "no") {
      const feedback = (
        await askUser("Optional feedback for the model: ")
      ).trim();

      return {
        behavior: "deny",
        feedback: feedback || undefined,
      };
    }

    console.log("Please answer y, a, or n.");
  }
}
