import { describe, expect, it } from "vitest";
import { InMemoryCooldownStore, verifyCooldownStoreContract } from "../src/index.js";

describe("InMemoryCooldownStore", () => {
  it("satisfies the CooldownStore contract", async () => {
    await verifyCooldownStoreContract(() => new InMemoryCooldownStore());
  });

  it("contract rejects stores that cannot handle slash-containing entry keys", async () => {
    // Mimics a document store (e.g. Firestore) that uses the raw entry key
    // as a document ID and forbids "/" in IDs — the class of bug the
    // contract must surface before such a store reaches production.
    class NaiveDocIdStore extends InMemoryCooldownStore {
      override async mark(entryKey: string, retryAt: Date): Promise<void> {
        if (entryKey.includes("/")) throw new Error("document ID cannot contain '/'");
        await super.mark(entryKey, retryAt);
      }
      override async check(entryKey: string): Promise<Date | null> {
        if (entryKey.includes("/")) throw new Error("document ID cannot contain '/'");
        return super.check(entryKey);
      }
    }

    await expect(
      verifyCooldownStoreContract(() => new NaiveDocIdStore()),
    ).rejects.toThrow(/document ID cannot contain/);
  });

  it("respects an injected clock for expiry", async () => {
    let clock = new Date("2026-07-02T10:00:00Z");
    const store = new InMemoryCooldownStore({ now: () => clock });
    const retryAt = new Date("2026-07-02T10:01:00Z");

    await store.mark("key", retryAt);
    expect(await store.check("key")).toEqual(retryAt);

    clock = new Date("2026-07-02T10:01:01Z");
    expect(await store.check("key")).toBeNull();
  });
});
