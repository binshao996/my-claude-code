// 17add: Memory unit tests — load order, prompt rendering, local write, secret rejection
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendLocalMemory } from "../src/memory/write";
import { loadMemory } from "../src/memory/load";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ccmini-memory-"));
  process.env.CCMINI_HOME = join(dir, "home");
});

afterEach(async () => {
  delete process.env.CCMINI_HOME;
  await rm(dir, { recursive: true, force: true });
});

describe("memory", () => {
  test("loads user, project, and local memory", async () => {
    await mkdir(process.env.CCMINI_HOME!, { recursive: true });
    await writeFile(join(process.env.CCMINI_HOME!, "CLAUDE.md"), "- User preference");
    await writeFile(join(dir, "CLAUDE.md"), "- Project rule");
    await writeFile(join(dir, "CLAUDE.local.md"), "- Local override");

    const result = await loadMemory(dir);

    expect(result.files.map((file) => file.scope)).toEqual(["user", "project", "local"]);
    expect(result.prompt).toContain("User preference");
    expect(result.prompt).toContain("Project rule");
    expect(result.prompt).toContain("Local override");
  });

  test("appends local memory and refuses obvious secrets", async () => {
    const path = await appendLocalMemory(dir, "Prefer short answers");
    const content = await readFile(path, "utf8");

    expect(content).toContain("Prefer short answers");
    await expect(appendLocalMemory(dir, "api_key = abc")).rejects.toThrow("secret");
  });
});
