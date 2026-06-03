// 19add: PluginRegistry — session-level active plugin state, reload
import { renderPluginContext } from "./contextLoader";
import { loadPlugins } from "./loader";
import type { PluginCommand, PluginTool } from "./types";

export type PluginRuntime = {
  commands: PluginCommand[];
  tools: PluginTool[];
  contextPrompt: string | null;
  errors: string[];
  enabledCount: number;
};

export class PluginRegistry {
  private runtime: PluginRuntime = {
    commands: [],
    tools: [],
    contextPrompt: null,
    errors: [],
    enabledCount: 0,
  };

  async reload(): Promise<PluginRuntime> {
    const result = await loadPlugins();
    const commands = result.enabled.flatMap((plugin) => plugin.commands);
    const tools = result.enabled.flatMap((plugin) => plugin.tools);
    const context = result.enabled.flatMap((plugin) => plugin.context);

    this.runtime = {
      commands,
      tools,
      contextPrompt: renderPluginContext(context),
      errors: result.errors,
      enabledCount: result.enabled.length,
    };

    return this.runtime;
  }

  getRuntime(): PluginRuntime {
    return this.runtime;
  }

  findCommand(name: string): PluginCommand | undefined {
    return this.runtime.commands.find((command) => command.name === name);
  }

  getTools(): PluginTool[] {
    return this.runtime.tools;
  }

  getContextPrompt(): string | null {
    return this.runtime.contextPrompt;
  }
}
