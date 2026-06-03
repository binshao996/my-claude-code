// 17add: Memory type definitions
export type MemoryScope = "user" | "project" | "local";

export type MemoryFile = {
  path: string;
  scope: MemoryScope;
  content: string;
};

export type MemoryLoadResult = {
  files: MemoryFile[];
  prompt: string | null;
};

export const MEMORY_PROMPT_HEADER =
  "Codebase and user instructions are shown below. Follow them when they are relevant to the current task.";
