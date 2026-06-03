// 16add: Sandbox unit tests — path boundary + command policy coverage
import { describe, expect, test } from "bun:test";
import { resolveWorkspacePath } from "../src/sandbox/path";
import { SandboxPolicyEngine } from "../src/sandbox/policy";

describe("resolveWorkspacePath", () => {
  test("allows paths inside workspace", () => {
    const cwd = "/repo";

    expect(resolveWorkspacePath(cwd, "src/main.ts")).toBe(
      "/repo/src/main.ts",
    );
  });

  test("rejects parent traversal", () => {
    const cwd = "/repo";

    expect(() => resolveWorkspacePath(cwd, "../outside.txt")).toThrow(
      "Path is outside workspace",
    );
  });

  test("rejects sibling prefix tricks", () => {
    const cwd = "/repo";

    expect(() => resolveWorkspacePath(cwd, "/repo-old/file.txt")).toThrow(
      "Path is outside workspace",
    );
  });
});

describe("SandboxPolicyEngine", () => {
  const sandbox = new SandboxPolicyEngine({
    cwd: "/repo",
    mode: "workspace_write",
    commandTimeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  });

  test("allows read-only commands", () => {
    expect(sandbox.decideCommand("git status").behavior).toBe("allow");
    expect(sandbox.decideCommand("rg hello src").behavior).toBe("allow");
  });

  test("asks before shell writes", () => {
    expect(sandbox.decideCommand("touch tmp/a.txt").behavior).toBe("ask");
  });

  test("denies hard dangerous commands", () => {
    expect(sandbox.decideCommand("rm -rf /").behavior).toBe("deny");
  });
});
