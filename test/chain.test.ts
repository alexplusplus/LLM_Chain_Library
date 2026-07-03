import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  ChainExhaustedError,
  createFallbackChain,
  InMemoryCooldownStore,
  InvalidRequestError,
  nextUtcMidnight,
  QuotaError,
  REASONING_EFFORTS,
  TransientError,
  type AdapterRequest,
  type EntryFailure,
  type ChainEntry,
  type PlainGenerateRequest,
  type ProviderAdapter,
  type ReasoningEffort,
} from "../src/index.js";

const schema = z.object({ text: z.string() });
const goodJson = JSON.stringify({ text: "hello" });

/** Fake adapter recording calls — test seam 1: no real provider anywhere. */
function fakeAdapter(
  providerId: string,
  impl: (request: AdapterRequest) => Promise<string>,
): ProviderAdapter & { calls: AdapterRequest[] } {
  const calls: AdapterRequest[] = [];
  return {
    providerId,
    calls,
    async generate(request) {
      calls.push(request);
      return impl(request);
    },
  };
}

const succeeding = (id: string) => fakeAdapter(id, async () => goodJson);
const failingWith = (id: string, error: Error) =>
  fakeAdapter(id, async () => {
    throw error;
  });

const NOW = new Date("2026-07-02T10:00:00Z");
const fixedNow = () => NOW;

describe("createFallbackChain", () => {
  it("serves from the first entry and reports typed data plus serving-entry metadata", async () => {
    const first = succeeding("gemini");
    const second = succeeding("openai");
    const chain = createFallbackChain({
      entries: [
        { key: "free", adapter: first, modelId: "model-free" },
        { key: "paid", adapter: second, modelId: "model-paid" },
      ],
    });

    const result = await chain.generate({ prompt: "p", schema });

    expect(result.data).toEqual({ text: "hello" });
    expect(result.entry).toEqual({ key: "free", providerId: "gemini", modelId: "model-free" });
    expect(result.failures).toEqual([]);
    expect(first.calls).toHaveLength(1);
    expect(first.calls[0]?.modelId).toBe("model-free");
    expect(second.calls).toHaveLength(0);
  });

  it("falls through on quota error and cools the entry down until the provider hint", async () => {
    const retryAt = new Date("2026-07-02T18:30:00Z");
    const first = failingWith("gemini", new QuotaError("exhausted", { retryAt }));
    const second = succeeding("openai");
    // Same clock for chain and store, or real-time pruning expires the
    // cooldown as soon as the wall clock passes the frozen test dates.
    const store = new InMemoryCooldownStore({ now: fixedNow });
    const chain = createFallbackChain({
      entries: [
        { key: "free", adapter: first, modelId: "m1" },
        { key: "paid", adapter: second, modelId: "m2" },
      ],
      cooldownStore: store,
      now: fixedNow,
    });

    const result = await chain.generate({ prompt: "p", schema });

    expect(result.entry.key).toBe("paid");
    expect(result.failures).toEqual([
      expect.objectContaining({ entryKey: "free", reason: "quota", retryAt }),
    ]);
    expect(await store.check("free")).toEqual(retryAt);
  });

  it("defaults the quota cooldown to next UTC midnight when the provider gives no hint", async () => {
    const first = failingWith("gemini", new QuotaError("exhausted"));
    const second = succeeding("openai");
    const store = new InMemoryCooldownStore({ now: fixedNow });
    const chain = createFallbackChain({
      entries: [
        { key: "free", adapter: first, modelId: "m1" },
        { key: "paid", adapter: second, modelId: "m2" },
      ],
      cooldownStore: store,
      now: fixedNow,
    });

    await chain.generate({ prompt: "p", schema });

    expect(await store.check("free")).toEqual(nextUtcMidnight(NOW));
    expect(nextUtcMidnight(NOW)).toEqual(new Date("2026-07-03T00:00:00Z"));
  });

  it("falls through on transient error with a short cooldown", async () => {
    const first = failingWith("gemini", new TransientError("503"));
    const second = succeeding("openai");
    // Same clock for chain and store: the 30s cooldown must be judged
    // against the frozen test time, not the wall clock.
    const store = new InMemoryCooldownStore({ now: fixedNow });
    const chain = createFallbackChain({
      entries: [
        { key: "free", adapter: first, modelId: "m1" },
        { key: "paid", adapter: second, modelId: "m2" },
      ],
      cooldownStore: store,
      transientCooldownMs: 30_000,
      now: fixedNow,
    });

    const result = await chain.generate({ prompt: "p", schema });

    expect(result.entry.key).toBe("paid");
    expect(await store.check("free")).toEqual(new Date(NOW.getTime() + 30_000));
  });

  it("skips a cooled-down entry without invoking its adapter", async () => {
    const first = failingWith("gemini", new QuotaError("exhausted"));
    const second = succeeding("openai");
    const chain = createFallbackChain({
      entries: [
        { key: "free", adapter: first, modelId: "m1" },
        { key: "paid", adapter: second, modelId: "m2" },
      ],
      cooldownStore: new InMemoryCooldownStore({ now: fixedNow }),
      now: fixedNow,
    });

    await chain.generate({ prompt: "p", schema });
    const result = await chain.generate({ prompt: "p", schema });

    expect(first.calls).toHaveLength(1); // not called again while cooling down
    expect(result.failures[0]).toMatchObject({ entryKey: "free", reason: "cooldown" });
    expect(second.calls).toHaveLength(2);
  });

  it("retries an entry once its cooldown has expired", async () => {
    let clock = new Date("2026-07-02T10:00:00Z");
    const first = failingWith("gemini", new TransientError("blip"));
    const second = succeeding("openai");
    const chain = createFallbackChain({
      entries: [
        { key: "free", adapter: first, modelId: "m1" },
        { key: "paid", adapter: second, modelId: "m2" },
      ],
      transientCooldownMs: 60_000,
      now: () => clock,
    });

    await chain.generate({ prompt: "p", schema });
    clock = new Date(clock.getTime() + 61_000);
    await chain.generate({ prompt: "p", schema });

    expect(first.calls).toHaveLength(2); // tried again after expiry
  });

  it("fails the whole call immediately on InvalidRequestError — no cooldown, no fallthrough", async () => {
    const first = failingWith("gemini", new InvalidRequestError("bad key"));
    const second = succeeding("openai");
    const store = new InMemoryCooldownStore();
    const chain = createFallbackChain({
      entries: [
        { key: "free", adapter: first, modelId: "m1" },
        { key: "paid", adapter: second, modelId: "m2" },
      ],
      cooldownStore: store,
    });

    await expect(chain.generate({ prompt: "p", schema })).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    expect(second.calls).toHaveLength(0);
    expect(await store.check("free")).toBeNull();
  });

  it("falls through with a short cooldown when output is not valid JSON", async () => {
    const first = fakeAdapter("gemini", async () => "not json {");
    const second = succeeding("openai");
    const chain = createFallbackChain({
      entries: [
        { key: "free", adapter: first, modelId: "m1" },
        { key: "paid", adapter: second, modelId: "m2" },
      ],
      now: fixedNow,
    });

    const result = await chain.generate({ prompt: "p", schema });

    expect(result.entry.key).toBe("paid");
    expect(result.failures[0]).toMatchObject({ entryKey: "free", reason: "invalid-output" });
  });

  it("falls through when output parses but violates the schema", async () => {
    const first = fakeAdapter("gemini", async () => JSON.stringify({ wrong: 1 }));
    const second = succeeding("openai");
    const chain = createFallbackChain({
      entries: [
        { key: "free", adapter: first, modelId: "m1" },
        { key: "paid", adapter: second, modelId: "m2" },
      ],
      now: fixedNow,
    });

    const result = await chain.generate({ prompt: "p", schema });

    expect(result.entry.key).toBe("paid");
    expect(result.failures[0]?.reason).toBe("invalid-output");
  });

  it("throws ChainExhaustedError with ordered per-entry failures when nothing serves", async () => {
    const first = failingWith("gemini", new QuotaError("gone"));
    const second = failingWith("openai", new TransientError("down"));
    const chain = createFallbackChain({
      entries: [
        { key: "free", adapter: first, modelId: "m1" },
        { key: "paid", adapter: second, modelId: "m2" },
      ],
      now: fixedNow,
    });

    const error = await chain.generate({ prompt: "p", schema }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChainExhaustedError);
    const failures = (error as ChainExhaustedError).failures;
    expect(failures.map((f) => [f.entryKey, f.reason])).toEqual([
      ["free", "quota"],
      ["paid", "transient"],
    ]);
  });

  it("rejects an out-of-subset schema before calling any adapter", async () => {
    const first = succeeding("gemini");
    const chain = createFallbackChain({
      entries: [{ key: "free", adapter: first, modelId: "m1" }],
    });
    const badSchema = z.object({ value: z.union([z.string(), z.number()]) });

    await expect(chain.generate({ prompt: "p", schema: badSchema })).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    expect(first.calls).toHaveLength(0);
  });

  it("rethrows unclassified adapter errors instead of masking them as fallthrough", async () => {
    const first = failingWith("gemini", new RangeError("adapter bug"));
    const second = succeeding("openai");
    const chain = createFallbackChain({
      entries: [
        { key: "free", adapter: first, modelId: "m1" },
        { key: "paid", adapter: second, modelId: "m2" },
      ],
    });

    await expect(chain.generate({ prompt: "p", schema })).rejects.toBeInstanceOf(RangeError);
    expect(second.calls).toHaveLength(0);
  });

  it("rejects empty chains and duplicate entry keys at construction", () => {
    expect(() => createFallbackChain({ entries: [] })).toThrow(InvalidRequestError);
    const a = succeeding("gemini");
    expect(() =>
      createFallbackChain({
        entries: [
          { key: "same", adapter: a, modelId: "m1" },
          { key: "same", adapter: a, modelId: "m2" },
        ],
      }),
    ).toThrow(InvalidRequestError);
  });

  it("passes the compiled portable schema and schema name to the adapter", async () => {
    const first = succeeding("gemini");
    const chain = createFallbackChain({
      entries: [{ key: "free", adapter: first, modelId: "m1" }],
    });

    await chain.generate({ prompt: "the prompt", schema, schemaName: "word_set" });

    const call = first.calls[0];
    expect(call?.prompt).toBe("the prompt");
    expect(call?.schemaName).toBe("word_set");
    expect(call?.schema).toEqual({
      kind: "object",
      properties: { text: { kind: "string" } },
    });
  });

  it("sends no schema, schemaName, or reasoningEffort keys to the adapter when all are omitted (v0.1.1 parity)", async () => {
    const first = fakeAdapter("gemini", async () => "plain answer");
    const chain = createFallbackChain({
      entries: [{ key: "free", adapter: first, modelId: "m1" }],
    });

    await chain.generate({ prompt: "p" });

    expect(first.calls[0]).toEqual({ modelId: "m1", prompt: "p" });
  });
});

describe("plain-text mode", () => {
  it("returns exactly { text, entry, failures } — no raw, no data", async () => {
    const first = fakeAdapter("gemini", async () => "  free-form\ntext ");
    const chain = createFallbackChain({
      entries: [{ key: "free", adapter: first, modelId: "m1" }],
    });

    const result = await chain.generate({ prompt: "p" });

    expect(result).toEqual({
      text: "  free-form\ntext ", // verbatim: surrounding whitespace preserved
      entry: { key: "free", providerId: "gemini", modelId: "m1" },
      failures: [],
    });
  });

  it("records whitespace-only output as invalid-output with a short cooldown and falls through", async () => {
    const first = fakeAdapter("gemini", async () => " \n\t ");
    const second = fakeAdapter("openai", async () => "recovered");
    const store = new InMemoryCooldownStore({ now: fixedNow });
    const chain = createFallbackChain({
      entries: [
        { key: "free", adapter: first, modelId: "m1" },
        { key: "paid", adapter: second, modelId: "m2" },
      ],
      cooldownStore: store,
      transientCooldownMs: 30_000,
      now: fixedNow,
    });

    const result = await chain.generate({ prompt: "p" });

    expect(result.text).toBe("recovered");
    expect(result.failures[0]).toMatchObject({ entryKey: "free", reason: "invalid-output" });
    expect(await store.check("free")).toEqual(new Date(NOW.getTime() + 30_000));
  });

  it("walks the full fallback machinery: quota cooldown, fallthrough, exhaustion aggregation", async () => {
    const first = failingWith("gemini", new QuotaError("gone"));
    const second = failingWith("openai", new TransientError("down"));
    const chain = createFallbackChain({
      entries: [
        { key: "free", adapter: first, modelId: "m1" },
        { key: "paid", adapter: second, modelId: "m2" },
      ],
      now: fixedNow,
    });

    const error = await chain.generate({ prompt: "p" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChainExhaustedError);
    expect((error as ChainExhaustedError).failures.map((f) => [f.entryKey, f.reason])).toEqual([
      ["free", "quota"],
      ["paid", "transient"],
    ]);
  });

  it("shares cooldowns across modes: a structured-mode quota cooldown skips the entry in plain mode", async () => {
    const first = failingWith("gemini", new QuotaError("gone"));
    const second = fakeAdapter("openai", async () => goodJson);
    const chain = createFallbackChain({
      entries: [
        { key: "free", adapter: first, modelId: "m1" },
        { key: "paid", adapter: second, modelId: "m2" },
      ],
      cooldownStore: new InMemoryCooldownStore({ now: fixedNow }),
      now: fixedNow,
    });

    await chain.generate({ prompt: "p", schema });
    const result = await chain.generate({ prompt: "p" });

    expect(first.calls).toHaveLength(1); // skipped in the plain call
    expect(result.failures[0]).toMatchObject({ entryKey: "free", reason: "cooldown" });
    expect(result.text).toBe(goodJson);
  });
});

describe("reasoningEffort", () => {
  it("forwards the effort to the adapter in both modes", async () => {
    const adapter = fakeAdapter("gemini", async () => goodJson);
    const chain = createFallbackChain({
      entries: [{ key: "free", adapter, modelId: "m1" }],
    });

    await chain.generate({ prompt: "p", schema, reasoningEffort: "low" });
    await chain.generate({ prompt: "p", reasoningEffort: "xhigh" });

    expect(adapter.calls[0]?.reasoningEffort).toBe("low");
    expect(adapter.calls[1]?.reasoningEffort).toBe("xhigh");
  });

  it("rejects an effort value outside the dictionary before calling any adapter", async () => {
    const adapter = fakeAdapter("gemini", async () => goodJson);
    const chain = createFallbackChain({
      entries: [{ key: "free", adapter, modelId: "m1" }],
    });

    await expect(
      chain.generate({ prompt: "p", reasoningEffort: "ultra" as ReasoningEffort }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(adapter.calls).toHaveLength(0);
  });

  it("rejects schemaName without schema before calling any adapter", async () => {
    const adapter = fakeAdapter("gemini", async () => goodJson);
    const chain = createFallbackChain({
      entries: [{ key: "free", adapter, modelId: "m1" }],
    });
    // Untyped-caller shape: the typed API already forbids this.
    const request = { prompt: "p", schemaName: "orphan" } as unknown as PlainGenerateRequest;

    await expect(chain.generate(request)).rejects.toBeInstanceOf(InvalidRequestError);
    expect(adapter.calls).toHaveLength(0);
  });

  it("exports the runtime dictionary in order", () => {
    expect(REASONING_EFFORTS).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  });
});

describe("generate() result types (compile-time)", () => {
  it("infers typed data for structured calls and text for plain calls", async () => {
    const adapter = fakeAdapter("gemini", async () => goodJson);
    const chain = createFallbackChain({
      entries: [{ key: "free", adapter, modelId: "m1" }],
    });

    const structured = await chain.generate({ prompt: "p", schema });
    expectTypeOf(structured.data).toEqualTypeOf<{ text: string }>();
    expectTypeOf(structured.raw).toEqualTypeOf<string>();
    expectTypeOf(structured.entry).toEqualTypeOf<ChainEntry>();
    expectTypeOf(structured.failures).toEqualTypeOf<readonly EntryFailure[]>();

    const plain = await chain.generate({ prompt: "p" });
    expectTypeOf(plain.text).toEqualTypeOf<string>();
    expectTypeOf(plain.entry).toEqualTypeOf<ChainEntry>();
    expectTypeOf(plain.failures).toEqualTypeOf<readonly EntryFailure[]>();
    // Plain results carry neither `data` nor `raw`.
    expectTypeOf(plain).not.toHaveProperty("data");
    expectTypeOf(plain).not.toHaveProperty("raw");
  });
});
