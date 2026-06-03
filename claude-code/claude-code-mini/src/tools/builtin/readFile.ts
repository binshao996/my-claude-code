import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { resolveToolPath, toDisplayPath } from "../path";
import type { Tool } from "../types";

const MAX_FILE_BYTES = 256 * 1024;

const inputSchema = z
  .object({
    path: z.string().min(1),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

type ReadFileInput = z.infer<typeof inputSchema>;

export const readFileTool: Tool<ReadFileInput> = {
  name: "read_file",
  description: "Read a UTF-8 text file from the current working directory.",
  inputSchema,
  inputJSONSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file, relative to cwd or absolute inside cwd.",
      },
      offset: {
        type: "number",
        description: "1-based line number to start reading from.",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to return.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  isReadOnly: true,
  async execute(input, context) {
    const absolutePath = resolveToolPath(context.cwd, input.path);
    const fileStat = await stat(absolutePath);

    if (!fileStat.isFile()) {
      throw new Error(`Path is not a file: ${input.path}`);
    }

    if (fileStat.size > MAX_FILE_BYTES && input.limit === undefined) {
      throw new Error(
        `File is too large (${fileStat.size} bytes). Use offset and limit to read a smaller range.`,
      );
    }

    const content = await readFile(absolutePath, "utf8");
    const lines = content.split(/\r?\n/);
    const startLine = input.offset ?? 1;
    const startIndex = startLine - 1;
    const selectedLines =
      input.limit === undefined
        ? lines.slice(startIndex)
        : lines.slice(startIndex, startIndex + input.limit);

    const numberedContent = selectedLines
      .map((line, index) => `${startLine + index} | ${line}`)
      .join("\n");

    context.readFileState.set(absolutePath, {
      content,
      mtimeMs: Math.floor(fileStat.mtimeMs),
    });

    return {
      content:
        numberedContent ||
        `<empty range: file has ${lines.length} line(s), requested offset ${startLine}>`,
      metadata: {
        path: toDisplayPath(context.cwd, absolutePath),
        bytes: fileStat.size,
        totalLines: lines.length,
        startLine,
        returnedLines: selectedLines.length,
      },
    };
  },
};
