// 19add: CommandRegistry — unified slash command dispatch for built-in + plugin commands
export type CommandHandler = (args: string) => Promise<string | void>;

export class CommandRegistry {
  private commands = new Map<string, CommandHandler>();

  register(name: string, handler: CommandHandler): void {
    this.commands.set(name, handler);
  }

  async run(input: string): Promise<boolean> {
    if (!input.startsWith("/")) return false;

    const spaceIndex = input.indexOf(" ");
    const rawName = spaceIndex === -1 ? input.slice(1) : input.slice(1, spaceIndex);
    if (!rawName) return false;

    const handler = this.commands.get(rawName);
    if (!handler) return false;

    const args = spaceIndex === -1 ? "" : input.slice(spaceIndex + 1);
    const result = await handler(args);
    if (result !== undefined) {
      console.log(result);
    }
    return true;
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }
}
