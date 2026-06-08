import type {
  CommandDefinition,
  CommandRegistryView,
} from "./commandTypes";

function assertCommandName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(name)) {
    throw new Error(`Invalid command name: ${name}`);
  }
}

export class CommandRegistry {
  private commands = new Map<string, CommandDefinition>();
  private aliases = new Map<string, string>();

  register(command: CommandDefinition): void {
    assertCommandName(command.name);

    if (this.commands.has(command.name)) {
      throw new Error(`Command already registered: ${command.name}`);
    }

    this.commands.set(command.name, command);

    for (const alias of command.aliases ?? []) {
      assertCommandName(alias);

      if (this.aliases.has(alias) || this.commands.has(alias)) {
        throw new Error(`Command alias already registered: ${alias}`);
      }

      this.aliases.set(alias, command.name);
    }
  }

  replaceAll(commands: CommandDefinition[]): void {
    this.commands.clear();
    this.aliases.clear();

    for (const command of commands) {
      this.register(command);
    }
  }

  find(name: string): CommandDefinition | undefined {
    const canonicalName = this.aliases.get(name) ?? name;
    const command = this.commands.get(canonicalName);

    if (!command) return undefined;
    if (command.isEnabled?.() === false) return undefined;

    return command;
  }

  list(options: { includeHidden?: boolean } = {}): CommandDefinition[] {
    return [...this.commands.values()]
      .filter((command) => command.isEnabled?.() !== false)
      .filter((command) => options.includeHidden || !command.isHidden)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  view(): CommandRegistryView {
    return {
      list: () => this.list(),
      find: (name) => this.find(name),
    };
  }

  // 19add compat: simple handler-based registration (deprecated, use register(CommandDefinition))
  registerLegacy(name: string, handler: (args: string) => Promise<string | void>): void {
    const command: CommandDefinition = {
      type: "local",
      name,
      source: "builtin",
      description: "",
      isHidden: true,
      async run(args) {
        const result = await handler(args);
        if (result === undefined) return { type: "skip" as const };
        return { type: "text" as const, text: result };
      },
    };
    this.register(command);
  }

  // 19add compat: check if command exists and run it (returns true if handled)
  async runLegacy(input: string): Promise<boolean> {
    if (!input.startsWith("/")) return false;

    const spaceIndex = input.indexOf(" ");
    const rawName = spaceIndex === -1 ? input.slice(1) : input.slice(1, spaceIndex);
    if (!rawName) return false;

    const command = this.find(rawName);
    if (!command || command.type !== "local") return false;

    const args = spaceIndex === -1 ? "" : input.slice(spaceIndex + 1);
    const result = await command.run(args, {} as unknown as import("./commandTypes").CommandExecutionContext);
    if (result.type === "text") {
      console.log(result.text);
    }
    return true;
  }
}
