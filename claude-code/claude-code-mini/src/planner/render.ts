import type { Plan, PlanItem } from "./types";

export function renderPlan(plan: Plan | null): string {
  if (!plan || plan.items.length === 0) {
    return "No active plan.";
  }

  const lines = [`Plan: ${plan.title}`, ""];

  for (const item of plan.items) {
    lines.push(renderPlanItem(item));
  }

  return lines.join("\n");
}

function renderPlanItem(item: PlanItem): string {
  switch (item.status) {
    case "pending":
      return `○ ${item.content}`;
    case "in_progress":
      return `● ${item.activeForm}`;
    case "completed":
      return `✓ ${item.content}`;
  }
}
