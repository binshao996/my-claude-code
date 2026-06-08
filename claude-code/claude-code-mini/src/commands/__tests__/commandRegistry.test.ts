import { describe, expect, test } from "bun:test";
import { CommandRegistry } from "../commandRegistry";
import type { LocalCommand, CommandDefinition } from "../commandTypes";

function makeLocal(overrides: Partial<LocalCommand> = {}): LocalCommand {
  return {
    type: "local" as const,
    name: "test-cmd",
    source: "builtin",
    description: "A test command",
    async run() {
      return { type: "text" as const, text: "ok" };
    },
    ...overrides,
  };
}

describe("CommandRegistry", () => {
  test("registers and finds commands by name", () => {
    const registry = new CommandRegistry();
    registry.register(makeLocal({ name: "hello" }));

    expect(registry.find("hello")).toBeDefined();
    expect(registry.find("nonexistent")).toBeUndefined();
  });

  test("finds commands by alias", () => {
    const registry = new CommandRegistry();
    registry.register(makeLocal({ name: "context", aliases: ["ctx"] }));

    expect(registry.find("ctx")).toBeDefined();
    expect(registry.find("ctx")!.name).toBe("context");
  });

  test("rejects duplicate names", () => {
    const registry = new CommandRegistry();
    registry.register(makeLocal({ name: "dup" }));

    expect(() => registry.register(makeLocal({ name: "dup" }))).toThrow(
      "already registered",
    );
  });

  test("filters disabled commands from find", () => {
    const registry = new CommandRegistry();
    registry.register(
      makeLocal({ name: "off", isEnabled: () => false }),
    );

    expect(registry.find("off")).toBeUndefined();
  });

  test("filters disabled commands from list", () => {
    const registry = new CommandRegistry();
    registry.register(makeLocal({ name: "a", isEnabled: () => false }));
    registry.register(makeLocal({ name: "b" }));

    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("b");
  });

  test("hides hidden commands from list by default", () => {
    const registry = new CommandRegistry();
    registry.register(makeLocal({ name: "visible" }));
    registry.register(makeLocal({ name: "secret", isHidden: true }));

    expect(registry.list()).toHaveLength(1);
    expect(registry.list({ includeHidden: true })).toHaveLength(2);
  });

  test("replaceAll clears and re-registers", () => {
    const registry = new CommandRegistry();
    registry.register(makeLocal({ name: "old" }));

    registry.replaceAll([makeLocal({ name: "new" })]);

    expect(registry.find("old")).toBeUndefined();
    expect(registry.find("new")).toBeDefined();
  });
});
