// 17add: Memory loader — read, clean, expand includes, render prompt
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { MEMORY_PROMPT_HEADER, type MemoryFile, type MemoryLoadResult } from "./types";
import { getLocalMemoryPath, getProjectMemoryCandidates, getUserMemoryPath } from "./paths";

const MAX_MEMORY_CHARS = 40_000;
const TEXT_EXTENSIONS = new Set(["", ".md", ".txt"]);

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return content;
  return content.slice(end + "\n---\n".length);
}

function stripHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function isAllowedTextFile(path: string): boolean {
  return TEXT_EXTENSIONS.has(extname(path));
}

function resolveIncludePath(baseFile: string, value: string): string {
  if (isAbsolute(value)) return value;
  return resolve(dirname(baseFile), value);
}

async function readInclude(baseFile: string, includeValue: string): Promise<string | null> {
  const includePath = resolveIncludePath(baseFile, includeValue);
  if (!isAllowedTextFile(includePath)) return null;
  if (!(await fileExists(includePath))) return null;
  return readFile(includePath, "utf8");
}

async function expandIncludes(path: string, content: string): Promise<string> {
  const lines = content.split("\n");
  const output: string[] = [];

  for (const line of lines) {
    const match = line.match(/^@(.+)$/);
    if (!match || !match[1]) {
      output.push(line);
      continue;
    }

    const included = await readInclude(path, match[1].trim());
    if (included === null) {
      output.push(line);
      continue;
    }

    output.push(included.trim());
  }

  return output.join("\n");
}

async function readMemoryFile(path: string, scope: MemoryFile["scope"]): Promise<MemoryFile | null> {
  if (!(await fileExists(path))) return null;

  const raw = await readFile(path, "utf8");
  const withIncludes = await expandIncludes(path, raw);
  const content = stripHtmlComments(stripFrontmatter(withIncludes)).slice(0, MAX_MEMORY_CHARS);

  if (content.trim().length === 0) return null;
  return { path, scope, content: content.trim() };
}

export function renderMemoryPrompt(files: MemoryFile[]): string | null {
  if (files.length === 0) return null;

  const sections = files.map((file) => {
    return `Contents of ${file.path} (${file.scope} memory):\n\n${file.content}`;
  });

  return `${MEMORY_PROMPT_HEADER}\n\n${sections.join("\n\n")}`;
}

export async function loadMemory(cwd: string): Promise<MemoryLoadResult> {
  const files: MemoryFile[] = [];

  const user = await readMemoryFile(getUserMemoryPath(), "user");
  if (user) files.push(user);

  for (const path of getProjectMemoryCandidates(cwd)) {
    const project = await readMemoryFile(path, "project");
    if (project) files.push(project);
  }

  const local = await readMemoryFile(getLocalMemoryPath(cwd), "local");
  if (local) files.push(local);

  return {
    files,
    prompt: renderMemoryPrompt(files),
  };
}
