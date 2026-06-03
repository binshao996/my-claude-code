// 17add: Memory path resolution — user, project, local
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

export function getMiniHome(): string {
  return process.env.CCMINI_HOME ?? join(homedir(), ".ccmini");
}

export function getUserMemoryPath(): string {
  return join(getMiniHome(), "CLAUDE.md");
}

function ancestorsFromRoot(cwd: string): string[] {
  const start = resolve(cwd);
  const root = parse(start).root;
  const dirs: string[] = [];

  let current = start;
  while (true) {
    dirs.push(current);
    if (current === root) break;
    current = dirname(current);
  }

  return dirs.reverse();
}

export function getProjectMemoryCandidates(cwd: string): string[] {
  return ancestorsFromRoot(cwd).flatMap((dir) => [
    join(dir, "CLAUDE.md"),
    join(dir, ".claude", "CLAUDE.md"),
  ]);
}

export function getLocalMemoryPath(cwd: string): string {
  return join(resolve(cwd), "CLAUDE.local.md");
}
