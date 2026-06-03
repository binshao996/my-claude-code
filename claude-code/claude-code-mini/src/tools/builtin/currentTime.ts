import { z } from "zod";
import type { Tool } from "../types";

const inputSchema = z.object({}).strict();

type CurrentTimeInput = z.infer<typeof inputSchema>;

export const currentTimeTool: Tool<CurrentTimeInput> = {
  name: "current_time",
  description: "Return the current local time as an ISO string.",
  inputSchema,
  inputJSONSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  isReadOnly: true,
  async execute(_input, context) {
    const now = new Date();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    return {
      content: now.toISOString(),
      metadata: {
        cwd: context.cwd,
        timezone,
      },
    };
  },
};
