// 19add: Plugin system barrel export
export { installPluginFromPath, listInstalledPlugins, setPluginEnabled } from "./install";
export { loadPlugins } from "./loader";
export { PluginRegistry } from "./registry";
export type { PluginRuntime } from "./registry";
export type {
  InstalledPlugin,
  InstalledPluginsFile,
  LoadedPlugin,
  PluginCommand,
  PluginContextSnippet,
  PluginLoadResult,
  PluginManifest,
  PluginTool,
} from "./types";
