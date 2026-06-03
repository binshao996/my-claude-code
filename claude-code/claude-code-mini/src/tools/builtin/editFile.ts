import { readFile, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { createUnifiedDiff } from "../../diff";
import { resolveToolPath, toDisplayPath } from "../path";
import type { Tool } from "../types";
import { resolveWorkspacePath } from "../../sandbox";

const inputSchema = z
  .object({
    path: z.string().min(1),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional().default(false),
  })
  .strict();

type EditFileInput = z.infer<typeof inputSchema>;

export const editFileTool: Tool<EditFileInput> = {
  name: "edit_file",
  description:
    "Edit an existing UTF-8 text file by replacing old_string with new_string. Read the file first with read_file. Do not include read_file line number prefixes in old_string.",
  inputSchema,
  inputJSONSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to edit, relative to cwd or absolute inside cwd.",
      },
      old_string: {
        type: "string",
        description:
          "Exact text to replace. It must match the file content and must not include read_file line number prefixes.",
      },
      new_string: {
        type: "string",
        description: "Replacement text.",
      },
      replace_all: {
        type: "boolean",
        description:
          "Replace every occurrence of old_string. Defaults to false; when false, old_string must be unique.",
      },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  isReadOnly: false,
  checkPermissions(input, context) {
    const absolutePath = resolveWorkspacePath(context.cwd, input.path);
    const decision = context.sandbox.decideFileWrite(absolutePath);
    return {
      behavior: decision.behavior,
      message: decision.reason,
      approvalKey: `edit_file:${absolutePath}`,
    };
  },
  async execute(input, context) {
    if (input.old_string === input.new_string) {
      throw new Error("No changes to make: old_string and new_string are identical.");
    }

    const absolutePath = resolveToolPath(context.cwd, input.path);
    const displayPath = toDisplayPath(context.cwd, absolutePath);

    const fileStat = await stat(absolutePath);

    if (!fileStat.isFile()) {
      throw new Error(`Path is not a file: ${input.path}`);
    }

    const lastRead = context.readFileState.get(absolutePath);

    if (!lastRead) {
      throw new Error(
        `Refusing to edit ${displayPath}. Read the file first with read_file.`,
      );
    }

    const currentContent = await readFile(absolutePath, "utf8");

    if (
      Math.floor(fileStat.mtimeMs) > lastRead.mtimeMs &&
      currentContent !== lastRead.content
    ) {
      throw new Error(
        `Refusing to edit ${displayPath}. The file changed after it was read. Read it again before editing.`,
      );
    }

    const matchCount = countOccurrences(currentContent, input.old_string);

    if (matchCount === 0) {
      throw new Error(
        `String to replace was not found in ${displayPath}.\nold_string:\n${input.old_string}`,
      );
    }

    if (matchCount > 1 && !input.replace_all) {
      throw new Error(
        `Found ${matchCount} matches in ${displayPath}, but replace_all is false. Provide a more specific old_string or set replace_all to true.`,
      );
    }

    const updatedContent = input.replace_all
      ? currentContent.split(input.old_string).join(input.new_string)
      : currentContent.replace(input.old_string, input.new_string);

    const diff = createUnifiedDiff({
      filePath: displayPath,
      oldContent: currentContent,
      newContent: updatedContent,
    });

    const sfAbsolutePath = resolveWorkspacePath(context.cwd, input.path);
    context.sandbox.assertCanWriteFile(sfAbsolutePath);

    await writeFile(absolutePath, updatedContent, "utf8");

    const newStat = await stat(absolutePath);
    context.readFileState.set(absolutePath, {
      content: updatedContent,
      mtimeMs: Math.floor(newStat.mtimeMs),
    });

    return {
      content: input.replace_all
        ? `File edited: ${displayPath}. Replaced ${matchCount} occurrence(s).`
        : `File edited: ${displayPath}.`,
      diff: diff.patch,
      metadata: {
        path: displayPath,
        operation: "edit",
        replacements: input.replace_all ? matchCount : 1,
        additions: diff.additions,
        removals: diff.removals,
        bytes: Buffer.byteLength(updatedContent, "utf8"),
      },
    };
  },
};

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let index = 0;

  while (true) {
    const foundIndex = content.indexOf(search, index);

    if (foundIndex === -1) {
      return count;
    }

    count++;
    index = foundIndex + search.length;
  }
}
