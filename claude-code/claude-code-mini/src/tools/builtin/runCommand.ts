import { z } from "zod";
import { runCommand } from "../../sandbox";
import type { Tool } from "../types";
import { approvalKeyForToolInput } from "../../permissions";

const inputSchema = z.object({
  command: z.string().min(1),
  reason: z.string().optional(),
});

type RunCommandToolInput = z.infer<typeof inputSchema>;

export const runCommandTool: Tool<RunCommandToolInput> = {
  name: "run_command",

  description:
    "Run a shell command inside the workspace sandbox. Prefer read-only inspection commands.",

  inputSchema,

  inputJSONSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
      },
      reason: {
        type: "string",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },

  isReadOnly: false,

  checkPermissions(input, context) {
    const decision = context.sandbox.decideCommand(input.command);
    return {
      behavior: decision.behavior,
      message: decision.reason,
      approvalKey: approvalKeyForToolInput("run_command", input),
    };
  },

  async execute(input, context) {
    const parsed = inputSchema.parse(input);

    const decision = context.sandbox.decideCommand(parsed.command);

    if (decision.behavior !== "allow") {
      throw new Error(
        [
          "Sandbox blocked command.",
          `mode: ${context.sandbox.config.mode}`,
          `decision: ${decision.behavior}`,
          `reason: ${decision.reason}`,
        ].join("\n"),
      );
    }

    const result = await runCommand(parsed.command, {
      cwd: context.sandbox.config.cwd,
      timeoutMs: context.sandbox.config.commandTimeoutMs,
      maxOutputBytes: context.sandbox.config.maxOutputBytes,
    });

    return {
      content: formatCommandResult(result),
    };
  },
};

function formatCommandResult(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}): string {
  const lines = [
    `exitCode: ${result.exitCode}`,
    `durationMs: ${result.durationMs}`,
  ];

  if (result.stdout.trim()) {
    lines.push("stdout:", result.stdout.trimEnd());
  }

  if (result.stderr.trim()) {
    lines.push("stderr:", result.stderr.trimEnd());
  }

  if (result.truncated) {
    lines.push("[output truncated]");
  }

  return lines.join("\n");
}
