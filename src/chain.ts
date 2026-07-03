import type { z } from "zod";
import {
  ChainExhaustedError,
  InvalidRequestError,
  QuotaError,
  TransientError,
  type EntryFailure,
} from "./errors.js";
import { InMemoryCooldownStore } from "./cooldown/in-memory.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "./effort.js";
import { zodToPortable } from "./schema/portable.js";
import { nextUtcMidnight } from "./time.js";
import type { ChainEntry, CooldownStore, ProviderAdapter } from "./types.js";

/** One position in the Fallback Chain: an adapter bound to a concrete model. */
export interface ChainEntryConfig {
  /** Unique key within the chain — indexes the Cooldown Store. */
  key: string;
  adapter: ProviderAdapter;
  modelId: string;
}

export interface FallbackChainConfig {
  /** Tried top-down: free-tier entries first, the paid floor last. */
  entries: ChainEntryConfig[];
  /** Defaults to {@link InMemoryCooldownStore}. Inject a durable store on serverless hosts. */
  cooldownStore?: CooldownStore;
  /** Short Cooldown applied on transient failures and invalid output. Default: 60s. */
  transientCooldownMs?: number;
  /**
   * Long Cooldown applied on quota errors that carry no provider retry hint.
   * Default: next UTC midnight (most free tiers reset daily).
   */
  quotaRetryFallback?: (now: Date) => Date;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

export interface GenerateRequest<S extends z.ZodType> {
  prompt: string;
  /** zod schema within the portable subset; the response is validated against it. */
  schema: S;
  /** Name passed to dialects that require one (OpenAI/OpenRouter). Default: "response". */
  schemaName?: string;
  /** Optional unified reasoning effort; each adapter converts it to its provider's dialect. */
  reasoningEffort?: ReasoningEffort;
}

/** Request for plain-text mode. Presence of `schema` is what selects the mode. */
export interface PlainGenerateRequest {
  prompt: string;
  /** Must stay absent — a schema selects structured mode. */
  schema?: undefined;
  /** Only meaningful alongside `schema`; passing it alone is an `InvalidRequestError`. */
  schemaName?: undefined;
  /** Optional unified reasoning effort; each adapter converts it to its provider's dialect. */
  reasoningEffort?: ReasoningEffort;
}

export interface GenerateResult<T> {
  /** Parsed response, validated against the request's zod schema. */
  data: T;
  /** Which Chain Entry served the request — log this to watch cost drift. */
  entry: ChainEntry;
  /** The provider's raw response text. */
  raw: string;
  /** Entries that were skipped or failed before `entry` served the request. */
  failures: readonly EntryFailure[];
}

export interface PlainGenerateResult {
  /** The provider's response text, verbatim (not trimmed). */
  text: string;
  /** Which Chain Entry served the request — log this to watch cost drift. */
  entry: ChainEntry;
  /** Entries that were skipped or failed before `entry` served the request. */
  failures: readonly EntryFailure[];
}

export interface FallbackChain {
  /** Structured mode: the response is JSON-parsed and validated against `schema`. */
  generate<S extends z.ZodType>(
    request: GenerateRequest<S>,
  ): Promise<GenerateResult<z.output<S>>>;
  /** Plain-text mode: no schema, the response text is returned verbatim. */
  generate(request: PlainGenerateRequest): Promise<PlainGenerateResult>;
}

const DEFAULT_TRANSIENT_COOLDOWN_MS = 60_000;

/**
 * Create a Fallback Chain.
 *
 * `generate` walks the entries top-down, skipping entries on Cooldown:
 * - quota error → long Cooldown (provider hint, else daily reset) → fall through
 * - transient error / invalid model output → short Cooldown → fall through
 * - invalid request → the whole call fails immediately, nothing is cooled down
 * - all entries skipped/failed → {@link ChainExhaustedError}
 *
 * Passing a `schema` selects structured mode; omitting it selects plain-text
 * mode. Both modes share the same walk — Cooldowns are per entry key and
 * mode-independent (they represent provider/model quota state).
 */
export function createFallbackChain(config: FallbackChainConfig): FallbackChain {
  if (config.entries.length === 0) {
    throw new InvalidRequestError("Fallback chain needs at least one entry");
  }
  const seen = new Set<string>();
  for (const entry of config.entries) {
    if (seen.has(entry.key)) {
      throw new InvalidRequestError(`Duplicate chain entry key "${entry.key}"`);
    }
    seen.add(entry.key);
  }

  const entries = config.entries.map((e) => ({
    config: e,
    meta: {
      key: e.key,
      providerId: e.adapter.providerId,
      modelId: e.modelId,
    } satisfies ChainEntry,
  }));
  const store = config.cooldownStore ?? new InMemoryCooldownStore();
  const transientMs = config.transientCooldownMs ?? DEFAULT_TRANSIENT_COOLDOWN_MS;
  const quotaFallback = config.quotaRetryFallback ?? nextUtcMidnight;
  const now = config.now ?? (() => new Date());

  async function generate(
    request: GenerateRequest<z.ZodType> | PlainGenerateRequest,
  ): Promise<GenerateResult<unknown> | PlainGenerateResult> {
    // Fail-fast validation — before schema compilation, before any provider
    // call. Catches untyped callers (config strings, plain JS).
    const effort = request.reasoningEffort;
    if (effort !== undefined && !(REASONING_EFFORTS as readonly string[]).includes(effort)) {
      throw new InvalidRequestError(
        `Unknown reasoningEffort "${String(effort)}" — expected one of: ${REASONING_EFFORTS.join(", ")}`,
      );
    }
    if (request.schema === undefined && request.schemaName !== undefined) {
      throw new InvalidRequestError(
        "schemaName was passed without a schema — pass both for structured mode, neither for plain text",
      );
    }

    // Compile the schema once, before touching any provider. An
    // out-of-subset schema fails the whole call here — the loud path.
    // Plain-text mode has nothing to compile or validate.
    const structured =
      request.schema !== undefined
        ? {
            schema: request.schema,
            portable: zodToPortable(request.schema),
            schemaName: request.schemaName ?? "response",
          }
        : undefined;

    const failures: EntryFailure[] = [];

    for (const { config: entry, meta } of entries) {
      const fail = (
        reason: EntryFailure["reason"],
        message: string,
        retryAt?: Date,
      ): void => {
        failures.push({
          entryKey: meta.key,
          providerId: meta.providerId,
          modelId: meta.modelId,
          reason,
          message,
          ...(retryAt ? { retryAt } : {}),
        });
      };

      const cooledUntil = await store.check(entry.key);
      if (cooledUntil !== null && cooledUntil.getTime() > now().getTime()) {
        fail("cooldown", `On cooldown until ${cooledUntil.toISOString()}`, cooledUntil);
        continue;
      }

      let raw: string;
      try {
        raw = await entry.adapter.generate({
          modelId: entry.modelId,
          prompt: request.prompt,
          ...(structured
            ? { schema: structured.portable, schemaName: structured.schemaName }
            : {}),
          ...(effort !== undefined ? { reasoningEffort: effort } : {}),
        });
      } catch (error) {
        if (error instanceof QuotaError) {
          const retryAt = error.retryAt ?? quotaFallback(now());
          await store.mark(entry.key, retryAt);
          fail("quota", error.message, retryAt);
          continue;
        }
        if (error instanceof TransientError) {
          const retryAt = new Date(now().getTime() + transientMs);
          await store.mark(entry.key, retryAt);
          fail("transient", error.message, retryAt);
          continue;
        }
        // InvalidRequestError — and anything unclassified, which is a bug —
        // fails the entire call. No Cooldown anywhere: the same request
        // would fail identically on every entry.
        throw error;
      }

      if (structured === undefined) {
        if (raw.trim() === "") {
          // Whitespace-only output is the plain-mode analogue of failing
          // schema validation: model flakiness, short Cooldown, fall through.
          // (Truly-empty responses never get here — adapters throw
          // TransientError on those.)
          const retryAt = new Date(now().getTime() + transientMs);
          await store.mark(entry.key, retryAt);
          fail("invalid-output", "Response contains only whitespace", retryAt);
          continue;
        }
        return { text: raw, entry: meta, failures };
      }

      const parsed = parseAndValidate(structured.schema, raw);
      if (!parsed.ok) {
        // Native schema enforcement should make this rare; when it happens
        // it's model flakiness, so treat it like a transient failure.
        const retryAt = new Date(now().getTime() + transientMs);
        await store.mark(entry.key, retryAt);
        fail("invalid-output", parsed.message, retryAt);
        continue;
      }

      return { data: parsed.data, entry: meta, raw, failures };
    }

    throw new ChainExhaustedError(failures);
  }

  // The union-typed implementation serves both overloads; the cast is the
  // standard TS pattern for implementing an overloaded interface method.
  return { generate: generate as FallbackChain["generate"] };
}

function parseAndValidate<S extends z.ZodType>(
  schema: S,
  raw: string,
): { ok: true; data: z.output<S> } | { ok: false; message: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, message: "Response is not valid JSON" };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    return { ok: false, message: `Response failed schema validation: ${result.error.message}` };
  }
  return { ok: true, data: result.data };
}
