# Changelog

## 0.2.0 (2026-07-03)

- **Plain-text mode:** `schema` / `schemaName` are now optional on
  `chain.generate()`. Omitting the schema returns
  `{ text, entry, failures }` — free-form text, verbatim, through the same
  fallback/cooldown machinery, with no JSON parsing or zod validation.
  Whitespace-only output is recorded as `invalid-output` (short cooldown,
  fallthrough). New exported types: `PlainGenerateRequest`,
  `PlainGenerateResult`. Structured calls are unchanged — existing consumer
  code compiles and behaves identically, and omitting the new parameters
  produces byte-identical provider requests to v0.1.1.
- **`reasoningEffort` parameter** (both modes): one unified value —
  `minimal | low | medium | high | xhigh` (exported as `ReasoningEffort`
  plus the `REASONING_EFFORTS` runtime array) — converted per provider via a
  hardcoded correspondence (ADR 0003): OpenRouter `reasoning.effort` and
  OpenAI `reasoning_effort` pass through natively; Gemini maps to
  `thinkingConfig.thinkingBudget` `0 / 1024 / 8192 / 16384 / 24576`.
  Omitted → no reasoning-related field is sent; an out-of-dictionary value
  throws `InvalidRequestError` before any provider call. A model that
  rejects the reasoning field aborts the whole call (classified
  `InvalidRequestError`, no fallthrough) — pick reasoning-capable models.
- **Breaking for custom adapters** (behavioral, not compile-time):
  `AdapterRequest.schema` / `schemaName` are now optional — third-party
  `ProviderAdapter` implementations must handle `request.schema ===
  undefined` (plain-text mode: omit the provider's schema-enforcement field
  entirely). The shipped adapters already do.

## 0.1.1 (2026-07-03)

- **`exports` fix:** added the `default` condition so CommonJS consumers can
  `require()` the package on Node ≥ 20.19 / ≥ 22.12 instead of hitting
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- **Cooldown store contract:** `verifyCooldownStoreContract` now exercises an
  entry key containing `/`, `:` and `.` (the shape of real OpenRouter entry
  keys). Persistent stores that derive document IDs from the raw key — and
  therefore break on `/` (e.g. Firestore) — now fail verification instead of
  failing silently in production.
- **README:** reference Firestore store implementation with encoded doc IDs,
  the throwaway-collection pattern for running the store contract against
  persistent stores, and a detailed Netlify deployment guide (provider keys,
  Firebase service-account credentials, private-key newline gotcha).

## 0.1.0 (2026-07-02)

Initial release: chain walker with quota/transient/invalid-request
classification and cooldowns, Gemini / OpenAI / OpenRouter adapters, portable
zod schema subset compiled per provider dialect, pluggable `CooldownStore`
with in-memory default and behavioral contract suite.
