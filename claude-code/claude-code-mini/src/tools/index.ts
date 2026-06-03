import { z } from "zod";
import { currentTimeTool } from "./builtin/currentTime";
import { echoTool } from "./builtin/echo";
import { editFileTool } from "./builtin/editFile";
import { readFileTool } from "./builtin/readFile";
import { writeFileTool } from "./builtin/writeFile";
import { ToolRegistry } from "./registry";
import type { ToolContext } from "./types";
import { updatePlanTool } from "./builtin/updatePlan";
import { runCommandTool } from "./builtin/runCommand";
// 19add: 插件工具类型
import type { PluginTool } from "../plugins";

export type CreateDefaultToolRegistryOptions = ToolContext & {
  // 19add: 插件提供的工具，注册到统一 ToolRegistry
  pluginTools?: PluginTool[];
};

export function createDefaultToolRegistry(options: CreateDefaultToolRegistryOptions): ToolRegistry {
  const { pluginTools = [], ...context } = options;
  const registry = new ToolRegistry(context);

  registry.register(currentTimeTool);
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(updatePlanTool);
  registry.register(runCommandTool);

  // 19add: 注册插件工具 — 将 PluginTool 桥接到 Tool 接口
  for (const pluginTool of pluginTools) {
    registry.register(pluginToolToMiniTool(pluginTool, context));
  }

  return registry;
}

// 19add: 将插件 PluginTool（JSON schema input）桥接到 Mini Tool（Zod schema）
function pluginToolToMiniTool(pluginTool: PluginTool, _context: ToolContext) {
  const schema = typeof pluginTool.inputSchema === "object" && pluginTool.inputSchema !== null
    ? z.object({}).passthrough()
    : z.object({});

  return {
    name: pluginTool.name,
    description: pluginTool.description,
    inputSchema: schema,
    inputJSONSchema: {
      type: "object",
      properties: {},
    } as const,
    isReadOnly: false,
    async execute(input: unknown, ctx: ToolContext) {
      const result = await pluginTool.run(input, { cwd: ctx.cwd });
      return { content: result };
    },
  };
}

export { ToolRegistry };
export type { Tool, ToolContext, ToolResult, ToolSummary } from "./types";
