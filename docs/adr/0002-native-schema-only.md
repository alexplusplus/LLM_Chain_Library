# ADR 0002: Native-schema-only Chain Entries

## Status

Accepted (2026-06-10)

## Context

Consumers pass a zod schema and must receive schema-valid typed data. Models
differ in how reliably they emit JSON: some enforce a schema natively at the
API level (Gemini `responseSchema`, OpenAI strict `json_schema`, OpenRouter
`response_format` on schema-capable models); others only "try" when prompted,
which requires a repair/retry layer to reach comparable reliability.

## Decision

Every Chain Entry's model must natively enforce JSON schemas. There is no
prompt-based JSON repair layer, and none is planned.

## Consequences

- Most OpenRouter `:free` model variants are disqualified (they do not
  enforce `json_schema`); the practical free tier is Gemini's.
- The library's response validation (zod `safeParse` after every call) is a
  safety net, not a repair mechanism: invalid output falls through to the
  next entry instead of being re-prompted.
- The portable schema subset can stay small and predictable — it only needs
  the intersection of what the native dialects support (objects with all
  fields required, strings, numbers, booleans, arrays, string enums,
  nullability).
