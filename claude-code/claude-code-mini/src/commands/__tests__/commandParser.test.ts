import { describe, expect, test } from "bun:test";
import { parseCommandInput } from "../commandParser";

describe("parseCommandInput", () => {
  test("parses command without args", () => {
    const result = parseCommandInput("/help");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("help");
    expect(result!.args).toBe("");
  });

  test("parses command with natural language args", () => {
    const result = parseCommandInput("/compact 聚焦保留认证模块");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("compact");
    expect(result!.args).toBe("聚焦保留认证模块");
  });

  test("returns null for normal user input", () => {
    expect(parseCommandInput("hello world")).toBeNull();
    expect(parseCommandInput("not a command")).toBeNull();
  });

  test("returns null for empty slash", () => {
    expect(parseCommandInput("/")).toBeNull();
    expect(parseCommandInput(" / ")).toBeNull();
  });

  test("handles plugin namespaced commands", () => {
    const result = parseCommandInput("/git-helper:branch-summary main");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("git-helper:branch-summary");
    expect(result!.args).toBe("main");
  });
});
