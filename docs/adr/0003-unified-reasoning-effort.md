# ADR 0003: Unified reasoning-effort dictionary with hardcoded per-provider conversion

## Status

Accepted (2026-07-03)

## Context

Consumers want to control how much reasoning ("thinking") a model spends on a
request. Providers express this in incompatible dialects: OpenRouter and
OpenAI take a named effort level, Gemini takes a numeric token budget with
model-dependent ranges. A consumer app stores one effort value in its config
(and persists "effort actually sent" per request), while the serving entry —
and therefore the provider dialect — is only known after the chain walks.

Effort is also per-request while Chain Entries are fixed: whatever value the
consumer passes must be valid for *every* entry the request might walk. A
Gemini budget above a mid-chain entry's maximum would fail that entry with an
`InvalidRequestError` — which aborts the whole call (no fallthrough) — before
a later, more capable entry is ever reached.

## Decision

- One unified dictionary, exactly OpenRouter's effort vocabulary:
  `"minimal" | "low" | "medium" | "high" | "xhigh"` (exported as
  `ReasoningEffort` plus the `REASONING_EFFORTS` runtime array). It is not
  extended, renamed, or made configurable.
- Each adapter owns a **hardcoded** conversion to its provider's dialect
  (consistent with ADR 0001 — adapters own provider specifics). There is no
  remapping configuration surface.
- OpenRouter and OpenAI: native 1:1 pass-through (`reasoning.effort` /
  `reasoning_effort`; openai@6 accepts all five values including `xhigh`).
- Gemini: a fixed `thinkingConfig.thinkingBudget` map — `minimal: 0`,
  `low: 1024`, `medium: 8192`, `high: 16384`, `xhigh: 24576` — sized so every
  tier fits within every Gemini 2.5-family model range (Flash caps at 24576).
- Omitted effort sends no reasoning-related field to any provider; an
  out-of-dictionary value fails fast with `InvalidRequestError` before any
  provider call.
- No pre-filtering or retry-without-effort: a provider/model that rejects the
  reasoning field fails through the normal error classification. Choosing
  reasoning-capable models for the chain is the consumer's responsibility.

## Consequences

- Consumers store and log one provider-agnostic value; because the conversion
  is deterministic from (effort, serving entry's provider), "what was sent"
  is derivable from metadata they already have — no new result fields.
- Gemini's `xhigh` deliberately stops at 24576 rather than Pro's 32768
  maximum: capping to the family-wide intersection keeps a free-first chain
  like `[flash-free → pro-paid]` walkable at every tier.
- `minimal` → budget `0` (thinking disabled) is rejected by models that
  cannot disable thinking (e.g. Gemini 2.5 Pro, floor 128). That rejection
  classifies as `InvalidRequestError` and aborts the whole call — a
  documented caveat, not a special case in code.
- Provider vocabulary drift (new tiers, changed ranges) is absorbed by
  editing the hardcoded maps in a minor release, never by consumer config.
