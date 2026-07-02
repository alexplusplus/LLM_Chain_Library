import type { CooldownStore } from "../types.js";

/**
 * Default Cooldown Store: process-local, zero setup.
 *
 * Suitable for long-lived processes and local development. On serverless
 * hosts, Cooldown state dies with the instance and is not shared across
 * instances — inject a durable store (e.g. Firestore-backed) there instead.
 */
export class InMemoryCooldownStore implements CooldownStore {
  private readonly cooldowns = new Map<string, Date>();
  private readonly now: () => Date;

  constructor(options?: { now?: () => Date }) {
    this.now = options?.now ?? (() => new Date());
  }

  async mark(entryKey: string, retryAt: Date): Promise<void> {
    this.cooldowns.set(entryKey, retryAt);
  }

  async check(entryKey: string): Promise<Date | null> {
    const retryAt = this.cooldowns.get(entryKey);
    if (retryAt === undefined) return null;
    if (retryAt.getTime() <= this.now().getTime()) {
      // Expired cooldowns are treated as absent (and pruned).
      this.cooldowns.delete(entryKey);
      return null;
    }
    return retryAt;
  }
}
