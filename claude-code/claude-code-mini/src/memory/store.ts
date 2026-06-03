// 17add: MemoryStore — cached memory loader with reload and list
import { loadMemory } from "./load";
import type { MemoryFile, MemoryLoadResult } from "./types";

export class MemoryStore {
  private cached: MemoryLoadResult | null = null;

  constructor(readonly cwd: string) {}

  async load(): Promise<MemoryLoadResult> {
    if (this.cached) return this.cached;
    this.cached = await loadMemory(this.cwd);
    return this.cached;
  }

  async reload(): Promise<MemoryLoadResult> {
    this.cached = await loadMemory(this.cwd);
    return this.cached;
  }

  async getPrompt(): Promise<string | null> {
    return (await this.load()).prompt;
  }

  async listFiles(): Promise<MemoryFile[]> {
    return (await this.load()).files;
  }
}
