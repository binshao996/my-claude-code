// 19add: Plugin path helpers — home, cache, installed state
import { homedir } from "node:os";
import { join } from "node:path";

export function getMiniHome(): string {
  return process.env.CCMINI_HOME ?? join(homedir(), ".ccmini");
}

export function getPluginsHome(): string {
  return join(getMiniHome(), "plugins");
}

export function getPluginCacheDir(): string {
  return join(getPluginsHome(), "cache");
}

export function getInstalledPluginsPath(): string {
  return join(getPluginsHome(), "installed.json");
}

export function getCachedPluginPath(pluginName: string): string {
  return join(getPluginCacheDir(), pluginName);
}
