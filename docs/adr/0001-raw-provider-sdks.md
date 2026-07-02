# ADR 0001: Adapters wrap raw provider SDKs, not the Vercel AI SDK

## Status

Accepted (2026-06-10)

## Context

The library needs to call several inference providers (Gemini API, OpenAI,
OpenRouter) with native structured-output enforcement, and to classify their
failures precisely — quota exhaustion vs. transient failure vs. invalid
request — because the whole fallback/cooldown policy branches on that
classification. An abstraction layer such as the Vercel AI SDK already
unifies provider calling.

## Decision

Provider Adapters wrap each provider's raw SDK (`@google/genai`, `openai`)
or plain HTTP (OpenRouter). The Vercel AI SDK is not used.

## Consequences

- Error normalization and schema-dialect compilation are implemented in this
  library. That is intentional: they are its core value, not incidental
  plumbing. An intermediate SDK's error mapping would sit between us and the
  provider-specific details we need (Gemini's `RetryInfo.retryDelay`,
  OpenRouter's `X-RateLimit-Reset`, 402-vs-429 semantics).
- Each new provider costs one adapter implementation instead of arriving for
  free from an upstream SDK.
- No dependency on a third party's release cadence or breaking changes for
  the library's core behavior.

