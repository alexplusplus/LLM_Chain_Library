/**
 * Classified error taxonomy. Adapters normalize every provider failure into
 * exactly one of these; the chain walker branches on the class, never on
 * vendor-specific error shapes.
 */

/** Base class for every error the library throws. */
export class LlmChainError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Free tier or rate quota exhausted for a Chain Entry.
 * Puts the entry on a long Cooldown (provider retry hint when available,
 * otherwise the chain's fallback — next UTC daily reset) and falls through.
 */
export class QuotaError extends LlmChainError {
  /** Provider-supplied hint for when the quota resets, if any. */
  readonly retryAt: Date | undefined;

  constructor(message: string, options?: { retryAt?: Date; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.retryAt = options?.retryAt;
  }
}

/**
 * Temporary provider failure (5xx, timeout, network). Puts the entry on a
 * short Cooldown and falls through, so a brief outage doesn't push a whole
 * day of traffic to paid entries.
 */
export class TransientError extends LlmChainError {}

/**
 * The request itself is bad (unsupported schema, oversized prompt, bad API
 * key). Fails the entire call immediately — no Cooldown, no fallthrough —
 * so consumer bugs surface in development instead of silently burning paid
 * quota.
 */
export class InvalidRequestError extends LlmChainError {}

/** Why a specific Chain Entry did not serve the request. */
export type EntryFailureReason =
  /** Entry was on Cooldown and skipped without a provider call. */
  | "cooldown"
  /** Provider reported quota exhaustion. */
  | "quota"
  /** Provider failed transiently. */
  | "transient"
  /** Provider returned output that failed JSON parsing or schema validation. */
  | "invalid-output";

/** Per-entry outcome recorded while walking the chain. */
export interface EntryFailure {
  entryKey: string;
  providerId: string;
  modelId: string;
  reason: EntryFailureReason;
  message: string;
  /** When the entry becomes eligible again, if it was put on (or found on) Cooldown. */
  retryAt?: Date;
}

/** Every Chain Entry was skipped or failed; nothing served the request. */
export class ChainExhaustedError extends LlmChainError {
  readonly failures: readonly EntryFailure[];

  constructor(failures: readonly EntryFailure[]) {
    const summary = failures
      .map((f) => `${f.entryKey}: ${f.reason}`)
      .join("; ");
    super(`All chain entries failed or were on cooldown (${summary})`);
    this.failures = failures;
  }
}
