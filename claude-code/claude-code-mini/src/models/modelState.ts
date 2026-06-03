// 20add: Session-level model override state — /model command backend
let sessionModelOverride: string | null = null;

export function getSessionModelOverride(): string | null {
  return sessionModelOverride;
}

export function setSessionModelOverride(model: string | null): void {
  sessionModelOverride = model;
}
