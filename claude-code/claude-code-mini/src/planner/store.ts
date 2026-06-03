import type { Plan, PlanItem, UpdatePlanInput } from "./types";

export class PlannerStore {
  private plan: Plan | null;
  private dirty = false;

  constructor(
    private readonly sessionId: string,
    initialPlan: Plan | null = null,
  ) {
    this.plan = initialPlan;
  }

  getPlan(): Plan | null {
    return this.plan;
  }

  updatePlan(input: UpdatePlanInput): Plan {
    validatePlanItems(input.items);

    const now = new Date().toISOString();
    const title =
      input.title?.trim() ||
      this.plan?.title ||
      inferTitleFromItems(input.items);

    this.plan = {
      sessionId: this.sessionId,
      title,
      items: input.items.map(item => ({ ...item })),
      createdAt: this.plan?.createdAt ?? now,
      updatedAt: now,
    };
    this.dirty = true;

    return this.plan;
  }

  clearPlan(): void {
    this.plan = null;
    this.dirty = true;
  }

  consumeDirtyPlan(): { plan: Plan | null } | null {
    if (!this.dirty) {
      return null;
    }

    this.dirty = false;
    return { plan: this.plan };
  }
}

function validatePlanItems(items: readonly PlanItem[]): void {
  const inProgressCount = items.filter(
    item => item.status === "in_progress",
  ).length;

  if (inProgressCount > 1) {
    throw new Error("Only one plan item can be in_progress at a time.");
  }

  for (const item of items) {
    if (!item.content.trim()) {
      throw new Error("Plan item content cannot be empty.");
    }

    if (!item.activeForm.trim()) {
      throw new Error("Plan item activeForm cannot be empty.");
    }
  }
}

function inferTitleFromItems(items: readonly PlanItem[]): string {
  const first = items[0]?.content.trim();
  return first || "Current task";
}
