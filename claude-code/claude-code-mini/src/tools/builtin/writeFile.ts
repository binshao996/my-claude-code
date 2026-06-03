import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { resolveToolPath, toDisplayPath } from "../path";
import type { Tool } from "../types";
import { resolveWorkspacePath } from "../../sandbox";

const inputSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
  })
  .strict();

type WriteFileInput = z.infer<typeof inputSchema>;

export const writeFileTool: Tool<WriteFileInput> = {
  name: "write_file",
  description: "Create or overwrite a UTF-8 text file in the current working directory.",
  inputSchema,
  inputJSONSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to write, relative to cwd or absolute inside cwd.",
      },
      content: {
        type: "string",
        description: "Full file content to write.",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  isReadOnly: false,
  checkPermissions(input, context) {
    const absolutePath = resolveWorkspacePath(context.cwd, input.path);
    const decision = context.sandbox.decideFileWrite(absolutePath);

    return {
      behavior: decision.behavior,
      message: decision.reason,
      approvalKey: `write_file:${absolutePath}`,
    };
  },
  async execute(input, context) {
    const absolutePath = resolveToolPath(context.cwd, input.path);
    const displayPath = toDisplayPath(context.cwd, absolutePath);

    const existing = await readExistingFile(absolutePath);

    if (existing) {
      const lastRead = context.readFileState.get(absolutePath);

      if (!lastRead) {
        throw new Error(
          `Refusing to overwrite ${displayPath}. Read the file first with read_file.`,
        );
      }

      if (existing.mtimeMs > lastRead.mtimeMs && existing.content !== lastRead.content) {
        throw new Error(
          `Refusing to overwrite ${displayPath}. The file changed after it was read. Read it again before writing.`,
        );
      }
    }

    await mkdir(dirname(absolutePath), { recursive: true });

    const sfAsolutePath = resolveWorkspacePath(context.cwd, input.path);
    context.sandbox.assertCanWriteFile(sfAsolutePath);
    await writeFile(absolutePath, input.content, "utf8");

    const newStat = await stat(absolutePath);
    context.readFileState.set(absolutePath, {
      content: input.content,
      mtimeMs: Math.floor(newStat.mtimeMs),
    });

    return {
      content: existing ? `File updated: ${displayPath}` : `File created: ${displayPath}`,
      metadata: {
        path: displayPath,
        bytes: Buffer.byteLength(input.content, "utf8"),
        operation: existing ? "update" : "create",
      },
    };
  },
};

async function readExistingFile(
  absolutePath: string,
): Promise<{ content: string; mtimeMs: number } | null> {
  try {
    const fileStat = await stat(absolutePath);

    if (!fileStat.isFile()) {
      throw new Error("Path exists but is not a file.");
    }

    const content = await readFile(absolutePath, "utf8");

    return {
      content,
      mtimeMs: Math.floor(fileStat.mtimeMs),
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
