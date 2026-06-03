import { isAbsolute, relative, resolve } from "node:path";

export function resolveToolPath(cwd: string, inputPath: string): string {
  if (inputPath.includes("\0")) {
    throw new Error("Path contains null byte.");
  }

  const absolutePath = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(cwd, inputPath);

  const relativePath = relative(cwd, absolutePath);

  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${pathSeparator()}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Path is outside the working directory: ${inputPath}`);
  }

  return absolutePath;
}

export function toDisplayPath(cwd: string, absolutePath: string): string {
  const relativePath = relative(cwd, absolutePath);

  if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath || ".";
  }

  return absolutePath;
}

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}
