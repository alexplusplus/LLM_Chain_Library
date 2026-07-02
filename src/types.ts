import type { PortableSchema } from "./schema/portable.js";

/**
 * Identifies which Chain Entry served (or failed) a request.
 * Returned as response metadata so consumers can monitor free-tier
 * utilization and cost drift.
 */
export interface ChainEntry {
  /** Unique key within the chain — what the Cooldown Store indexes. */
  key: string;
  providerId: string;
  modelId: string;
}

/** The single request shape a Provider Adapter receives. */
export interface AdapterRequest {
  modelId: string;
  prompt: string;
  /**
   * The request's schema, already compiled to the portable subset.
   * The adapter transforms it to its provider's native dialect.
   */
  schema: PortableSchema;
  /** Name for dialects that require a named schema (OpenAI/OpenRouter `json_schema`). */
  schemaName: string;
}

/**
 * One Provider = one adapter. Adapters wrap the provider's raw SDK (or HTTP
 * API), compile the portable schema to the provider's native dialect, and
 * normalize every failure into a classified error (`QuotaError`,
 * `TransientError`, `InvalidRequestError`).
 *
 * Adapters never see the chain: they take one request and return the raw
 * response text (or throw). Chain policy — ordering, cooldowns, fallthrough —
 * lives entirely in the chain walker.
 */
export interface ProviderAdapter {
  readonly providerId: string;
  /** @returns the provider's raw response text (expected to be JSON). */
  generate(request: AdapterRequest): Promise<string>;
}

/**
 * Pluggable Cooldown storage. The in-memory implementation ships with the
 * library; serverless deployments inject a durable one (e.g. Firestore) so
 * Cooldowns survive cold starts and are shared across instances.
 *
 * Implementations must satisfy `verifyCooldownStoreContract`.
 */
export interface CooldownStore {
  /** Record that `entryKey` must not be tried again until `retryAt`. Last write wins. */
  mark(entryKey: string, retryAt: Date): Promise<void>;
  /**
   * @returns the entry's `retryAt` if it is on Cooldown (i.e. `retryAt` is in
   * the future), otherwise `null`. Expired Cooldowns are treated as absent.
   */
  check(entryKey: string): Promise<Date | null>;
}
