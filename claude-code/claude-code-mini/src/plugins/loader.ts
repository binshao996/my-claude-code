// 19add: Plugin loader — orchestrate loading all enabled plugins
import { readInstalledPlugins } from "./install";
import { loadPluginManifest } from "./manifest";
import { loadPluginCommands } from "./commandLoader";
import { loadPluginTools } from "./toolLoader";
import { loadPluginContext } from "./contextLoader";
import type { LoadedPlugin, PluginLoadResult } from "./types";

export async function loadPlugins(): Promise<PluginLoadResult> {
  const installed = await readInstalledPlugins();
  const enabled: LoadedPlugin[] = [];
  const disabled = [];
  const errors: string[] = [];

  for (const plugin of Object.values(installed.plugins)) {
    if (!plugin.enabled) {
      disabled.push(plugin);
      continue;
    }

    try {
      const manifest = await loadPluginManifest(plugin.installPath);
      const [commands, tools, context] = await Promise.all([
        loadPluginCommands(plugin.installPath, manifest),
        loadPluginTools(plugin.installPath, manifest),
        loadPluginContext(plugin.installPath, manifest),
      ]);

      enabled.push({
        manifest,
        installPath: plugin.installPath,
        commands,
        tools,
        context,
      });
    } catch (error) {
      errors.push(
        error instanceof Error
          ? `${plugin.name}: ${error.message}`
          : `${plugin.name}: Unknown plugin load error`,
      );
    }
  }

  return { enabled, disabled, errors };
}
