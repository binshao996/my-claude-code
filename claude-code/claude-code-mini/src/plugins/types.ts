// 19add: Plugin type definitions — manifest, installed state, loaded runtime
import type { ChatMessage } from "../llm/types";

export type PluginCommandManifest = {
  source: string;
  description?: string;
  argumentHint?: string;
  // 20add: optional model override for plugin commands
  model?: string;
};

export type PluginToolManifest = {
  source: string;
  description?: string;
};

export type PluginManifest = {
  name: string;
  version?: string;
  description?: string;
  commands?: Record<string, PluginCommandManifest>;
  tools?: Record<string, PluginToolManifest>;
  context?: string[];
};

export type InstalledPlugin = {
  name: string;
  version?: string;
  installPath: string;
  enabled: boolean;
  installedAt: string;
};

export type InstalledPluginsFile = {
  version: 1;
  plugins: Record<string, InstalledPlugin>;
};

export type PluginCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  // 20add: optional model override from manifest
  model?: string;
  getPrompt(args: string): Promise<ChatMessage[]>;
};

export type PluginTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  run(input: unknown, context: { cwd: string }): Promise<string>;
};

export type PluginContextSnippet = {
  pluginName: string;
  path: string;
  content: string;
};

export type LoadedPlugin = {
  manifest: PluginManifest;
  installPath: string;
  commands: PluginCommand[];
  tools: PluginTool[];
  context: PluginContextSnippet[];
};

export type PluginLoadResult = {
  enabled: LoadedPlugin[];
  disabled: InstalledPlugin[];
  errors: string[];
};
