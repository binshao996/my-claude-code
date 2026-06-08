import type { ChatMessage } from "../llm/types";
import type { ChatSession } from "../chat/session";

export type CommandSource =
  | "builtin"
  | "plugin"
  | "skill"
  | "mcp"
  | "workflow";

export type CommandExecutionContext = {
  cwd: string;
  session: ChatSession;
  commands: CommandRegistryView;
};

export type CommandRegistryView = {
  list(): CommandDefinition[];
  find(name: string): CommandDefinition | undefined;
};

export type CommandResult =
  | { type: "skip" }
  | { type: "text"; text: string }
  | { type: "inject"; messages: ChatMessage[]; shouldQuery: boolean }
  | { type: "replaceMessages"; messages: ChatMessage[]; text?: string };

export type BaseCommand = {
  name: string;
  description: string;
  source: CommandSource;
  aliases?: string[];
  argumentHint?: string;
  isEnabled?: () => boolean;
  isHidden?: boolean;
  supportsHeadless?: boolean;
};

export type LocalCommand = BaseCommand & {
  type: "local";
  run(args: string, context: CommandExecutionContext): Promise<CommandResult>;
};

export type PromptCommand = BaseCommand & {
  type: "prompt";
  allowedTools?: string[];
  modelRole?: "main" | "fast" | "planner" | "compact";
  getPrompt(args: string, context: CommandExecutionContext): Promise<string>;
};

export type CommandDefinition = LocalCommand | PromptCommand;
