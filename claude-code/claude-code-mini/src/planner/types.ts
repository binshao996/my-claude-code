export type PlanItemStatus = "pending" | "in_progress" | "completed";

export type PlanItem = {
  content: string;
  activeForm: string;
  status: PlanItemStatus;
};

export type Plan = {
  sessionId: string;
  title: string;
  items: PlanItem[];
  createdAt: string;
  updatedAt: string;
};

export type UpdatePlanInput = {
  title?: string;
  items: PlanItem[];
};
