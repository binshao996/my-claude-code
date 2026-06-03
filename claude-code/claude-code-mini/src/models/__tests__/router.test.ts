// 20add: Model router tests — role routing, fallback, command override, plan mode, secret isolation
import { describe, expect, test } from "bun:test";
import { ModelRouter } from "../router";
import type { ModelConfig } from "../types";

function config(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    provider: "anthropic-compatible",
    baseUrl: "https://api.deepseek.com/anthropic",
    authToken: "test-token",
    authTokenEnv: "ANTHROPIC_AUTH_TOKEN",
    mainModel: "deepseek-v4-flash",
    ...overrides,
  };
}

describe("ModelRouter", () => {
  test("routes main role to ANTHROPIC_MODEL equivalent", () => {
    const router = new ModelRouter(config());

    const route = router.resolve({ role: "main" });

    expect(route.model).toBe("deepseek-v4-flash");
    expect(route.provider).toBe("anthropic-compatible");
    expect(route.reason).toBe("main model");
  });

  test("uses fast model when configured", () => {
    const router = new ModelRouter(
      config({
        fastModel: "deepseek-fast",
      }),
    );

    const route = router.resolve({ role: "fast" });

    expect(route.model).toBe("deepseek-fast");
    expect(route.reason).toBe("fast model");
  });

  test("falls back to main when role model is not configured", () => {
    const router = new ModelRouter(config());

    const route = router.resolve({ role: "compact" });

    expect(route.model).toBe("deepseek-v4-flash");
    expect(route.reason).toBe("fallback to main");
  });

  test("command model override wins over role config", () => {
    const router = new ModelRouter(
      config({
        plannerModel: "deepseek-planner",
      }),
    );

    const route = router.resolve({
      role: "planner",
      commandModel: "deepseek-command",
    });

    expect(route.model).toBe("deepseek-command");
    expect(route.reason).toBe("command model override");
  });

  test("command model can use role alias", () => {
    const router = new ModelRouter(
      config({
        plannerModel: "deepseek-planner",
      }),
    );

    const route = router.resolve({
      role: "plugin",
      commandModel: "planner",
    });

    expect(route.model).toBe("deepseek-planner");
  });

  test("plan permission mode uses planner route", () => {
    const router = new ModelRouter(
      config({
        plannerModel: "deepseek-planner",
      }),
    );

    const route = router.resolve({
      role: "main",
      permissionMode: "plan",
    });

    expect(route.model).toBe("deepseek-planner");
    expect(route.reason).toBe("plan mode planner model");
  });

  test("route report does not expose token value", () => {
    const router = new ModelRouter(config({ authToken: "secret-value" }));

    const route = router.resolve({ role: "main" });
    const serialized = JSON.stringify(route);

    expect(serialized).not.toContain("secret-value");
    expect(route.authTokenEnv).toBe("ANTHROPIC_AUTH_TOKEN");
  });
});
