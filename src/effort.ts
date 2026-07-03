/**
 * Unified reasoning-effort dictionary (OpenRouter's effort vocabulary; see
 * ADR 0003). Consumers store one provider-agnostic value; each Provider
 * Adapter owns the hardcoded conversion to its provider's dialect.
 */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
