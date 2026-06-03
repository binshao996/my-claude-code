import { z } from "zod";
import { renderPlan } from "../../planner";
import type { Tool } from "../types";

const planItemSchema = z
  .object({
    content: z.string().min(1),
    activeForm: z.string().min(1),
    status: z.enum(["pending", "in_progress", "completed"]),
  })
  .strict();

const inputSchema = z
  .object({
    title: z.string().min(1).optional(),
    items: z.array(planItemSchema),
  })
  .strict();

type UpdatePlanInput = z.infer<typeof inputSchema>;

export const updatePlanTool: Tool<UpdatePlanInput> = {
  name: "update_plan",
  description:
    "Create or update the current task plan. Use it for complex multi-step coding tasks. Keep exactly one item in_progress while working.",
  inputSchema,
  inputJSONSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short title for the current plan.",
      },
      items: {
        type: "array",
        description: "Full replacement list of plan items.",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "Imperative task text, e.g. Read src/main.ts.",
            },
            activeForm: {
              type: "string",
              description:
                "Present continuous text, e.g. Reading src/main.ts.",
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
            },
          },
          required: ["content", "activeForm", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
  isReadOnly: false,
  async execute(input, context) {
    const plan = context.planner.updatePlan(input);

    return {
      content: renderPlan(plan),
      metadata: {
        title: plan.title,
        itemCount: plan.items.length,
        inProgressCount: plan.items.filter(
          item => item.status === "in_progress",
        ).length,
      },
    };
  },
};
