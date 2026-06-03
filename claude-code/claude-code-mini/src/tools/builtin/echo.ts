import { z } from "zod";
import type { Tool } from "../types";

const inputSchema = z
  .object({
    text: z.string(),
  })
  .strict();

type EchoInput = z.infer<typeof inputSchema>;

export const echoTool: Tool<EchoInput> = {
  name: "echo",
  description: "Return the input text unchanged.",
  inputSchema,
  inputJSONSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Text to return.",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
  isReadOnly: true,
  async execute(input) {
    return {
      content: input.text,
    };
  },
};
