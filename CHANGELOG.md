# Changelog

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
