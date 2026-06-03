// 16add: Check dist artifacts — entry files, executable shebang, chunk integrity
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const distDir = "dist";

await assertFile(join(distDir, "cli.js"));
await assertFile(join(distDir, "ccmini"));
await assertExecutable(join(distDir, "ccmini"));
await assertNoBrokenLocalImports(distDir);

console.log("dist check passed");

async function assertFile(path: string): Promise<void> {
  try {
    const info = await stat(path);

    if (!info.isFile()) {
      throw new Error(`${path} is not a file`);
    }
  } catch {
    throw new Error(`Missing build artifact: ${path}`);
  }
}

async function assertExecutable(path: string): Promise<void> {
  await access(path);

  const content = await readFile(path, "utf8");

  if (!content.startsWith("#!/usr/bin/env bun")) {
    throw new Error(`${path} does not start with Bun shebang`);
  }
}

async function assertNoBrokenLocalImports(distDir: string): Promise<void> {
  const files = (await readdir(distDir)).filter(file => file.endsWith(".js"));
  const fileSet = new Set(files);
  const importPattern = /(?:from\s+|import\s*)["']\.\/([^"']+\.js)["']/g;

  for (const file of files) {
    const content = await readFile(join(distDir, file), "utf8");

    for (const match of content.matchAll(importPattern)) {
      const target = match[1];

      if (!fileSet.has(target)) {
        throw new Error(`${file} imports missing file: ${target}`);
      }
    }
  }
}
