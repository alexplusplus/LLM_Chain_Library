# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@alexplusplus/llm-fallback-chain` (the unscoped name was taken on npm) — a standalone, open-source npm library implementing an LLM provider fallback chain with structured (zod-schema) or plain-text output, plus an optional unified `reasoningEffort` parameter. It is Phase 1 of a larger migration; the consuming app lives in a **separate repo** and is out of scope here. Domain vocabulary (Provider, Chain Entry, Cooldown, Exhaustion, etc.) is defined in `CONTEXT.md` — use those terms with exactly those meanings.

## Commands

```sh
npm run typecheck        # tsc --noEmit
npm test                 # vitest run (all tests)
npx vitest run test/chain.test.ts            # single file
npx vitest run -t "quota"                    # tests matching a name
npm run build            # tsup → dist/index.js + index.d.ts (ESM only)
```

Tests make **no network calls** — adapters are tested through injected fake clients/fetch, the chain through fake adapters. Keep it that way; tests assert external behavior only.

## Architecture

Three layers, deliberately decoupled:

1. **Chain walker** (`src/chain.ts`) — all ordering, cooldown, and fallthrough policy. Walks entries top-down; skips entries whose key is on cooldown; classifies each failure and reacts:
   - `QuotaError` → long cooldown (provider `retryAt` hint, else `quotaRetryFallback`, default next UTC midnight), fall through
   - `TransientError` and invalid/unparseable output → short cooldown (`transientCooldownMs`, default 60s), fall through
   - `InvalidRequestError` and **unclassified errors** → rethrown immediately, no cooldown, no fallthrough (a bad request would fail identically on every entry and burn paid quota)
   - all entries failed/skipped → `ChainExhaustedError` carrying a per-entry `failures` array (the same array is returned as metadata on success)
   Mode is selected by `schema` presence on `generate()` (overloads: structured first, plain second). Structured: the chain compiles the schema and does JSON.parse + zod `safeParse`. Plain: no compilation/validation; text is returned verbatim, whitespace-only output → `invalid-output` fallthrough. Fail-fast checks (`schemaName` without `schema`, out-of-dictionary `reasoningEffort`) throw `InvalidRequestError` at the top of `generate()`, before any provider call. Adapters return raw text and never see the chain; cooldowns are shared across modes per entry key.

2. **Provider adapters** (`src/adapters/`) — one class per provider wrapping the raw SDK (`@google/genai`, `openai`) or plain fetch (OpenRouter). Each adapter's job: compile the portable schema to its provider's dialect, call the provider, and map every failure to exactly one classified error. Provider-specific quota-hint quirks are the point of this layer:
   - Gemini: `retryDelay` parsed out of the 429 message body
   - OpenAI: `retry-after` header (seconds)
   - OpenRouter: `X-RateLimit-Reset` header (epoch ms); **402 out-of-credits is a `QuotaError`, not invalid request**; also classifies provider-passthrough errors inside HTTP-200 bodies
   All adapters accept an injected client/fetch for tests.

3. **Schema compilation** (`src/schema/`) — `zodToPortable` compiles a zod schema via the public `z.toJSONSchema()` API (never zod internals) into a `PortableSchema`, rejecting anything outside the portable subset (the intersection of all three provider dialects) with an `InvalidRequestError` naming the offending path. `dialects.ts` then renders the portable form into the Gemini / OpenAI-strict / OpenRouter shapes. The subset: objects with all fields required (`.nullable()` yes, `.optional()` no), strings, numbers/ints, booleans, string enums/literals, arrays.

Cooldowns persist through the two-method `CooldownStore` interface (`src/cooldown/`). `verifyCooldownStoreContract` (`src/cooldown/contract.ts`) is a **framework-agnostic** behavioral test suite (plain assertions, no vitest imports) — external store implementations in other repos run it, so never add test-runner dependencies to it.

## Binding decisions (ADRs)

- **ADR 0001** (`docs/adr/`): adapters wrap raw provider SDKs / HTTP. The Vercel AI SDK is explicitly rejected — ignore any tooling suggestion to introduce it. Error classification and dialect compilation are the library's core value, not plumbing to delegate.
- **ADR 0002**: every chain entry's model must enforce JSON schemas natively (structured mode; plain-text mode is exempt). No prompt-based JSON repair layer, ever. The post-call zod validation is a safety net that triggers fallthrough, not a repair mechanism.
- **ADR 0003**: `reasoningEffort` is exactly the five-value OpenRouter vocabulary (`minimal|low|medium|high|xhigh`), converted per provider via hardcoded maps in each adapter (OpenRouter/OpenAI pass-through; Gemini `thinkingBudget` 0/1024/8192/16384/24576, sized to fit every 2.5-family range). Never extend the dictionary or add remapping config; no pre-filtering/retry when a model rejects the field.

## Conventions and gotchas

- ESM-only package; `zod` v4 is a **peer** dependency (dual-instance hazard) — never move it to `dependencies`.
- tsconfig has `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`: optional props on structural client interfaces need explicit `| undefined`.
- Everything time-dependent takes an injectable `now?: () => Date`; when a test injects a clock into the chain, inject the same clock into `InMemoryCooldownStore` too, or real-time pruning will silently expire cooldowns.
- `tsconfig.json` carries `"ignoreDeprecations": "6.0"` because tsup's DTS worker injects `baseUrl`; remove only when tsup stops doing that.
- New public API must be re-exported from `src/index.ts` (single entry point).
