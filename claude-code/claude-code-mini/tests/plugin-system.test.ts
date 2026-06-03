// 19add: Plugin system tests — install, load, enable/disable, path validation
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installPluginFromPath, setPluginEnabled } from "../src/plugins/install";
import { loadPlugins } from "../src/plugins/loader";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ccmini-plugin-"));
  process.env.CCMINI_HOME = join(dir, "home");
});

afterEach(async () => {
  delete process.env.CCMINI_HOME;
  await rm(dir, { recursive: true, force: true });
});

async function createPlugin(): Promise<string> {
  const root = join(dir, "git-helper");
  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  await mkdir(join(root, "commands"), { recursive: true });
  await mkdir(join(root, "context"), { recursive: true });
  await mkdir(join(root, "tools"), { recursive: true });

  await writeFile(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify(
      {
        name: "git-helper",
        version: "0.1.0",
        commands: {
          hello: {
            source: "./commands/hello.md",
            description: "Say hello",
          },
        },
        context: ["./context/rules.md"],
      },
      null,
      2,
    ),
    "utf8",
  );

  await writeFile(join(root, "commands", "hello.md"), "Hello $ARGUMENTS", "utf8");
  await writeFile(join(root, "context", "rules.md"), "Use concise output.", "utf8");

  return root;
}

describe("plugin system", () => {
  test("installs and loads an enabled plugin", async () => {
    const root = await createPlugin();
    await installPluginFromPath(root);

    const result = await loadPlugins();

    expect(result.enabled).toHaveLength(1);
    expect(result.enabled[0]?.manifest.name).toBe("git-helper");
    expect(result.enabled[0]?.commands[0]?.name).toBe("git-helper:hello");
    expect(result.enabled[0]?.context[0]?.content).toContain("concise");
  });

  test("disabled plugins are not loaded as active components", async () => {
    const root = await createPlugin();
    await installPluginFromPath(root);
    await setPluginEnabled("git-helper", false);

    const result = await loadPlugins();

    expect(result.enabled).toHaveLength(0);
    expect(result.disabled).toHaveLength(1);
  });

  test("rejects paths escaping plugin root", async () => {
    const root = await createPlugin();
    await writeFile(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "git-helper",
        commands: {
          bad: {
            source: "../outside.md",
          },
        },
      }),
      "utf8",
    );

    await installPluginFromPath(root);
    const result = await loadPlugins();

    expect(result.enabled).toHaveLength(0);
    expect(result.errors[0]).toContain("must start");
  });
});
