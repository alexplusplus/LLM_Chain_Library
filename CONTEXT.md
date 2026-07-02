# Domain Terms

Shared vocabulary for this repo. PRDs, ADRs, code, and issues use these terms
with exactly these meanings.

- **Provider** — an AI inference API vendor (Gemini API, OpenAI, OpenRouter).
- **Provider Adapter** — the library component wrapping one Provider's raw SDK
  or HTTP API. Compiles the portable schema to the Provider's native dialect
  and normalizes every failure into a classified error. Never sees the chain.
- **Chain Entry** — one position in a Fallback Chain: a Provider Adapter bound
  to a concrete model id, identified by a unique key. The key is what the
  Cooldown Store indexes.
- **Fallback Chain** — the ordered list of Chain Entries a request walks
  top-down: free-tier entries first, a paid floor last. Server-owned
  configuration; consumers define their own order.
- **Cooldown** — a period during which a Chain Entry is skipped without a
  provider call. Long for quota exhaustion (provider hint, else next daily
  reset), short for transient failures.
- **Exhaustion** — a Provider reporting that a free tier or rate quota is used
  up (typically HTTP 429, or 402 for out-of-credit accounts). Triggers a long
  Cooldown and fallthrough to the next Chain Entry.
- **Cooldown Store** — the pluggable storage recording Cooldowns
  (`mark`/`check` by Chain Entry key). In-memory by default; serverless
  deployments inject a durable, shared implementation (e.g. Firestore) so one
  instance's quota discovery benefits every instance.
