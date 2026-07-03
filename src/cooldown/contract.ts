import type { CooldownStore } from "../types.js";

/**
 * Behavioral contract every {@link CooldownStore} implementation must satisfy.
 *
 * Framework-agnostic on purpose: call it from any test runner
 * (`await verifyCooldownStoreContract(() => new MyStore())`) and it throws a
 * descriptive error on the first violation. The library's own in-memory store
 * and any consumer-provided store (e.g. Firestore-backed) run the exact same
 * suite.
 *
 * Uses far-future/far-past absolute dates, so implementations reading the
 * real clock behave identically to injected-clock ones.
 */
export async function verifyCooldownStoreContract(
  factory: () => CooldownStore | Promise<CooldownStore>,
): Promise<void> {
  const farFuture = new Date(Date.now() + 60 * 60 * 1000);
  const laterFuture = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const farPast = new Date(Date.now() - 60 * 60 * 1000);

  {
    const store = await factory();
    const unknown = await store.check("contract-unknown-key");
    assert(unknown === null, `check() of an unmarked key must return null, got ${fmt(unknown)}`);
  }

  {
    const store = await factory();
    await store.mark("contract-key", farFuture);
    const found = await store.check("contract-key");
    assert(
      found !== null && found.getTime() === farFuture.getTime(),
      `check() after mark() must return the marked retryAt (${fmt(farFuture)}), got ${fmt(found)}`,
    );
  }

  {
    const store = await factory();
    await store.mark("contract-expired", farPast);
    const expired = await store.check("contract-expired");
    assert(
      expired === null,
      `check() of an expired cooldown (retryAt in the past) must return null, got ${fmt(expired)}`,
    );
  }

  {
    const store = await factory();
    await store.mark("contract-overwrite", farFuture);
    await store.mark("contract-overwrite", laterFuture);
    const later = await store.check("contract-overwrite");
    assert(
      later !== null && later.getTime() === laterFuture.getTime(),
      `re-mark() must overwrite (last write wins), expected ${fmt(laterFuture)}, got ${fmt(later)}`,
    );
    await store.mark("contract-overwrite", farFuture);
    const earlier = await store.check("contract-overwrite");
    assert(
      earlier !== null && earlier.getTime() === farFuture.getTime(),
      `re-mark() with an earlier date must also overwrite, expected ${fmt(farFuture)}, got ${fmt(earlier)}`,
    );
  }

  {
    const store = await factory();
    await store.mark("contract-key-a", farFuture);
    const other = await store.check("contract-key-b");
    assert(other === null, `keys must be independent: marking "a" must not affect "b", got ${fmt(other)}`);
    const a = await store.check("contract-key-a");
    assert(a !== null, `marking one key must not be lost when another key is checked`);
  }

  {
    // Real Chain Entry keys contain characters that many document stores
    // forbid in IDs/paths: "/" in OpenRouter model ids, ":" in provider
    // prefixes, "." in version suffixes. Stores that derive document IDs
    // from the key must encode it, not fail or split it into a path.
    const store = await factory();
    const slashKey = "contract-openrouter:meta-llama/llama-3.3-70b-instruct";
    await store.mark(slashKey, farFuture);
    const found = await store.check(slashKey);
    assert(
      found !== null && found.getTime() === farFuture.getTime(),
      `a key containing "/", ":" and "." (${JSON.stringify(slashKey)}) must round-trip like any other key, got ${fmt(found)}`,
    );
    const sibling = await store.check("contract-openrouter:meta-llama/llama-3.1-8b-instruct");
    assert(
      sibling === null,
      `keys sharing a "/" prefix segment must stay independent, got ${fmt(sibling)}`,
    );
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`CooldownStore contract violation: ${message}`);
  }
}

function fmt(d: Date | null): string {
  return d === null ? "null" : d.toISOString();
}
