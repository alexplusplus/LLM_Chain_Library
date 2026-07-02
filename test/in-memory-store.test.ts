import { describe, expect, it } from "vitest";
import { InMemoryCooldownStore, verifyCooldownStoreContract } from "../src/index.js";

describe("InMemoryCooldownStore", () => {
  it("satisfies the CooldownStore contract", async () => {
    await verifyCooldownStoreContract(() => new InMemoryCooldownStore());
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
