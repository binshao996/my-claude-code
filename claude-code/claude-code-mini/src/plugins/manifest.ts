// 19add: Plugin manifest — parse, validate, load from disk
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { PluginManifest } from "./types";

const PLUGIN_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function validatePluginName(name: string): void {
  if (!PLUGIN_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid plugin name "${name}". Use letters, numbers, "_" or "-".`,
    );
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function readString(value: unknown, label: string, required = false): string | undefined {
  if (value === undefined) {
    if (required) throw new Error(`${label} is required.`);
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function readSourceMap(
  value: unknown,
  label: string,
): Record<string, { source: string; description?: string; argumentHint?: string }> | undefined {
  if (value === undefined) return undefined;
  assertRecord(value, label);

  const result: Record<string, { source: string; description?: string; argumentHint?: string }> = {};
  for (const [name, item] of Object.entries(value)) {
    validatePluginName(name);
    assertRecord(item, `${label}.${name}`);
    result[name] = {
      source: readString(item.source, `${label}.${name}.source`, true)!,
      description: readString(item.description, `${label}.${name}.description`),
      argumentHint: readString(item.argumentHint, `${label}.${name}.argumentHint`),
    };
  }
  return result;
}

function readContextList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("context must be an array.");

  return value.map((item, index) => {
    return readString(item, `context.${index}`, true)!;
  });
}

export function parsePluginManifest(value: unknown): PluginManifest {
  assertRecord(value, "plugin manifest");

  const name = readString(value.name, "name", true)!;
  validatePluginName(name);

  return {
    name,
    version: readString(value.version, "version"),
    description: readString(value.description, "description"),
    commands: readSourceMap(value.commands, "commands"),
    tools: readSourceMap(value.tools, "tools"),
    context: readContextList(value.context),
  };
}

export async function loadPluginManifest(pluginRoot: string): Promise<PluginManifest> {
  const manifestPath = resolve(pluginRoot, ".claude-plugin", "plugin.json");
  const raw = await readFile(manifestPath, "utf8");
  return parsePluginManifest(JSON.parse(raw));
}

export async function assertInsidePluginRoot(
  pluginRoot: string,
  relativePath: string,
): Promise<string> {
  if (!relativePath.startsWith("./")) {
    throw new Error(`Plugin paths must start with "./": ${relativePath}`);
  }

  const root = resolve(pluginRoot);
  const fullPath = resolve(root, relativePath);
  if (fullPath !== root && !fullPath.startsWith(root + sep)) {
    throw new Error(`Plugin path escapes plugin root: ${relativePath}`);
  }

  const info = await stat(fullPath);
  if (!info.isFile()) {
    throw new Error(`Plugin path is not a file: ${relativePath}`);
  }

  return fullPath;
}
