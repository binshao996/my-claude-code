// 17add: Memory writer — append to CLAUDE.local.md, reject secrets
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getLocalMemoryPath } from "./paths";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function looksLikeSecret(text: string): boolean {
  return /(api[_-]?key|auth[_-]?token|token|secret|password|private[_-]?key)\s*[:=]/i.test(text);
}

export async function appendLocalMemory(cwd: string, text: string): Promise<string> {
  const value = text.trim();
  if (!value) {
    throw new Error("Memory content cannot be empty.");
  }

  if (looksLikeSecret(value)) {
    throw new Error("Refusing to store content that looks like a secret.");
  }

  const path = getLocalMemoryPath(cwd);
  await mkdir(dirname(path), { recursive: true });

  let previous = "";
  try {
    previous = await readFile(path, "utf8");
  } catch {
    previous = "# Local Memory\n\n";
  }

  const separator = previous.endsWith("\n") ? "" : "\n";
  const next = `${previous}${separator}- ${today()} ${value}\n`;
  await writeFile(path, next, "utf8");
  return path;
}
