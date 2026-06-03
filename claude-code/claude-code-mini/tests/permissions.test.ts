// 16add: Permission unit tests — approval keys + session allow store
import { describe, expect, test } from "bun:test";
import { approvalKeyForToolInput } from "../src/permissions/keys";
import { PermissionStore } from "../src/permissions/store";

describe("approvalKeyForToolInput", () => {
  test("uses command as run_command key", () => {
    expect(
      approvalKeyForToolInput("run_command", {
        command: "touch tmp/a.txt",
      }),
    ).toBe("run_command:touch tmp/a.txt");
  });

  test("uses path as write_file key", () => {
    expect(
      approvalKeyForToolInput("write_file", {
        path: "tmp/a.txt",
        content: "large content should not be part of key",
      }),
    ).toBe("write_file:tmp/a.txt");
  });
});

describe("PermissionStore", () => {
  test("stores session allow keys", () => {
    const store = new PermissionStore();

    expect(store.hasSessionAllow("run_command:touch tmp/a.txt")).toBe(false);

    store.addSessionAllow("run_command:touch tmp/a.txt");

    expect(store.hasSessionAllow("run_command:touch tmp/a.txt")).toBe(true);
  });
});
