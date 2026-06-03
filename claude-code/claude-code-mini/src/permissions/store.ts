export class PermissionStore {
  private readonly sessionAllowKeys = new Set<string>();

  hasSessionAllow(key: string): boolean {
    return this.sessionAllowKeys.has(key);
  }

  addSessionAllow(key: string): void {
    this.sessionAllowKeys.add(key);
  }

  listSessionAllows(): string[] {
    return [...this.sessionAllowKeys].sort();
  }
}
