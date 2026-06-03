// 19add: Plugin install — copy to cache, manage installed.json
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  getCachedPluginPath,
  getInstalledPluginsPath,
  getPluginsHome,
} from "./paths";
import { loadPluginManifest } from "./manifest";
import type { InstalledPluginsFile } from "./types";

const EMPTY_INSTALLED: InstalledPluginsFile = {
  version: 1,
  plugins: {},
};

export async function readInstalledPlugins(): Promise<InstalledPluginsFile> {
  try {
    const raw = await readFile(getInstalledPluginsPath(), "utf8");
    const parsed = JSON.parse(raw) as InstalledPluginsFile;
    if (parsed.version !== 1 || typeof parsed.plugins !== "object") {
      throw new Error("Invalid installed plugins file.");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_INSTALLED;
    }
    throw error;
  }
}

async function writeInstalledPlugins(file: InstalledPluginsFile): Promise<void> {
  const path = getInstalledPluginsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2), "utf8");
}

export async function installPluginFromPath(sourcePath: string): Promise<string> {
  const resolvedSource = resolve(sourcePath);
  const manifest = await loadPluginManifest(resolvedSource);
  const targetPath = getCachedPluginPath(manifest.name);

  await mkdir(getPluginsHome(), { recursive: true });
  await rm(targetPath, { recursive: true, force: true });
  await cp(resolvedSource, targetPath, {
    recursive: true,
    filter(source) {
      return !source.includes("/.git/");
    },
  });

  const installed = await readInstalledPlugins();
  installed.plugins[manifest.name] = {
    name: manifest.name,
    version: manifest.version,
    installPath: targetPath,
    enabled: true,
    installedAt: new Date().toISOString(),
  };

  await writeInstalledPlugins(installed);
  return manifest.name;
}

export async function setPluginEnabled(name: string, enabled: boolean): Promise<void> {
  const installed = await readInstalledPlugins();
  const plugin = installed.plugins[name];
  if (!plugin) {
    throw new Error(`Plugin is not installed: ${name}`);
  }

  plugin.enabled = enabled;
  await writeInstalledPlugins(installed);
}

export async function listInstalledPlugins(): Promise<InstalledPluginsFile> {
  return readInstalledPlugins();
}
