import { isAbsolute, relative, resolve } from "node:path";

export function resolveWorkspacePath(cwd: string, inputPath: string): string {
  const absolutePath = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(cwd, inputPath);

  const relativePath = relative(cwd, absolutePath);

  if (relativePath === "") {
    return absolutePath;
  }

  if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return absolutePath;
  }

  throw new Error(`Path is outside workspace: ${inputPath}`);
}
