# @alexplusplus/llm-fallback-chain

Structured or plain-text LLM output through a configurable provider
**fallback chain**: free tiers first, a paid floor last, with pluggable
cooldown storage.

Pass a prompt and a [zod](https://zod.dev) schema for parsed,
TypeScript-typed data — or just a prompt for free-form text; the chain walks
your entries top-down and returns the result with serving-entry metadata, or
a classified error. Quota-exhausted or flaky entries go on **cooldown** and
are skipped until they recover, so a free tier running dry falls through to
the next entry instead of failing your request.

```
Gemini (free) ──quota──▶ OpenRouter (cheap) ──5xx──▶ OpenAI (floor) ──▶ ✓ typed data
     │                        │
  cooldown until          cooldown 60s
  daily reset
```

## Install

```sh
npm install @alexplusplus/llm-fallback-chain zod
```

`zod` (v4) is a peer dependency.

The package is ESM. From CommonJS projects, `require()` works on Node ≥ 20.19
/ ≥ 22.12 (native `require(esm)`); on older Node use dynamic `import()`.

## Quickstart

```ts
import { z } from "zod";
import {
  createFallbackChain,
  GeminiAdapter,
  OpenAiAdapter,
  OpenRouterAdapter,
} from "@alexplusplus/llm-fallback-chain";

const chain = createFallbackChain({
  entries: [
    {
      key: "gemini-flash",
      adapter: new GeminiAdapter({ apiKey: process.env.GEMINI_API_KEY! }),
      modelId: "gemini-2.5-flash",
    },
    {
      key: "openrouter-llama",
      adapter: new OpenRouterAdapter({ apiKey: process.env.OPENROUTER_API_KEY! }),
      modelId: "meta-llama/llama-3.3-70b-instruct",
    },
    {
      key: "openai-mini",
      adapter: new OpenAiAdapter({ apiKey: process.env.OPENAI_API_KEY! }),
      modelId: "gpt-4o-mini",
    },
  ],
});

const WordSet = z.object({
  paragraphs: z.array(z.string()).describe("Three short example texts"),
  definitions: z.string(),
  word_forms: z.array(z.object({ word: z.string(), forms: z.array(z.string()) })),
});

const { data, entry } = await chain.generate({
  prompt: "Generate study material for: bank, spring, light",
  schema: WordSet,
  schemaName: "word_set",
});

data.paragraphs; // string[] — fully typed via z.infer
console.log(`served by ${entry.key} (${entry.providerId}/${entry.modelId})`);
```

Log `entry` on every request: it tells you which chain position served it,
which is how you notice free-tier utilization dropping (cost drift) early.

## Plain-text quickstart

Omit `schema` and the same chain generates free-form text — full fallback and
cooldown machinery, no JSON parsing or validation:

```ts
const { text, entry, failures } = await chain.generate({
  prompt: "Explain the difference between 'bank' and 'shore' in one paragraph.",
});

text; // string — the response verbatim (not trimmed)
```

The portable schema subset and the native-schema-enforcement requirement
([ADR 0002](docs/adr/0002-native-schema-only.md)) apply to **structured mode
only**. In plain-text mode, chain entries don't need schema-capable models —
OpenRouter `:free` variants that are disqualified for structured use are
eligible in plain-text chains.

A whitespace-only response is treated like failed schema validation:
short cooldown, fall through to the next entry (`reason: "invalid-output"`
in `failures`).

## Reasoning effort

Both modes accept an optional `reasoningEffort` — one provider-agnostic value
(OpenRouter's effort vocabulary) that each adapter converts to its provider's
dialect via a hardcoded correspondence
([ADR 0003](docs/adr/0003-unified-reasoning-effort.md)):

```ts
import { REASONING_EFFORTS, type ReasoningEffort } from "@alexplusplus/llm-fallback-chain";

await chain.generate({ prompt, reasoningEffort: "low" });
```

| `reasoningEffort` | OpenRouter `reasoning.effort` | OpenAI `reasoning_effort` | Gemini `thinkingConfig.thinkingBudget` |
| --- | --- | --- | --- |
| `minimal` | `minimal` | `minimal` | `0` |
| `low` | `low` | `low` | `1024` |
| `medium` | `medium` | `medium` | `8192` |
| `high` | `high` | `high` | `16384` |
| `xhigh` | `xhigh` | `xhigh` | `24576` |

- Omitted → no reasoning-related field is sent to any provider at all.
- A value outside the dictionary (possible from untyped callers or config
  strings — validate yours against the exported `REASONING_EFFORTS` array)
  throws `InvalidRequestError` before any provider is called.
- The conversion is deterministic from the effort value and the serving
  `entry.providerId`, so you can persist "effort actually sent" from the
  metadata you already log — no extra result fields.
- Gemini budgets are sized to fit every 2.5-family model range (Flash caps
  at 24576), so one request-level value survives every entry it walks.

> **⚠️ A model that rejects the reasoning field aborts the whole call.**
> The chain does not pre-filter or retry without the field: a provider
> rejection classifies as `InvalidRequestError`, which fails the entire call
> immediately — **no fallthrough to later entries**. Known case: Gemini
> models that cannot disable thinking (e.g. 2.5 Pro, floor 128) reject
> `minimal` (budget `0`). Choosing reasoning-capable models for every entry
> of a chain that receives `reasoningEffort` is your responsibility.

## How the chain walks

For each entry, top-down:

| Outcome | Classification | Effect |
| --- | --- | --- |
| Success | — | Structured: response validated against your zod schema. Plain: text returned verbatim. Both carry serving-entry metadata |
| Quota exhausted (429/402) | `QuotaError` | Long cooldown — provider's retry hint, else next UTC midnight — then falls through |
| Transient failure (5xx, timeout, network) | `TransientError` | Short cooldown (default 60 s), falls through |
| Output fails JSON/schema validation (structured) or is whitespace-only (plain) | — | Treated like transient: short cooldown, falls through |
| Bad request (4xx: schema, prompt, API key) | `InvalidRequestError` | **Whole call fails immediately.** No cooldown, no fallthrough — the same bug would fail on every entry, silently burning paid quota |
| Every entry skipped/failed | `ChainExhaustedError` | Carries a per-entry failure list for diagnostics |

Entries already on cooldown are skipped without a provider call. Cooldowns
are keyed by chain entry and shared across both output modes on the same
chain instance — they represent provider/model quota state, which is
mode-independent.

## The portable schema subset (structured mode)

In structured mode, all entries must be able to enforce your schema natively
(see [ADR 0002](docs/adr/0002-native-schema-only.md)), so schemas are limited to
the intersection of the Gemini `responseSchema`, OpenAI strict `json_schema`,
and OpenRouter `response_format` dialects:

- objects — **all fields required**; use `.nullable()`, not `.optional()`
- `z.string()`, `z.number()`, `z.number().int()`, `z.boolean()`
- `z.enum([...])` and string literals
- `z.array(...)` of any of the above
- `.nullable()` on any of the above
- `.describe()` descriptions are forwarded to the provider

Anything else (unions, records, tuples, dates, recursion) throws
`InvalidRequestError` **before any provider is called**, naming the offending
path. Your zod refinements still run on the response — the subset only limits
what is sent to providers, not what you validate.

## Cooldown stores

Cooldowns are recorded through a two-method interface:

```ts
interface CooldownStore {
  mark(entryKey: string, retryAt: Date): Promise<void>;
  check(entryKey: string): Promise<Date | null>; // null = not on cooldown
}
```

The default `InMemoryCooldownStore` works out of the box for long-lived
processes. On serverless hosts, inject a durable store so a quota discovery
on one instance benefits all instances:

```ts
createFallbackChain({ entries, cooldownStore: new FirestoreCooldownStore(db) });
```

### Entry keys are arbitrary strings — encode them

Chain Entry keys routinely contain `/`, `:` and `.` (e.g. an OpenRouter entry
keyed `openrouter:meta-llama/llama-3.3-70b-instruct`). Many document stores
forbid these characters in document IDs or treat `/` as a path separator, so
a store that uses the raw key as an ID will fail — or worse, fail silently —
in production. Encode the key when deriving the ID. A minimal Firestore
implementation:

```ts
import type { CooldownStore } from "@alexplusplus/llm-fallback-chain";
import type { Firestore } from "firebase-admin/firestore";

export class FirestoreCooldownStore implements CooldownStore {
  constructor(
    private readonly db: Firestore,
    private readonly collection = "llmCooldowns",
  ) {}

  // Firestore doc IDs cannot contain "/" — encode the entry key.
  private doc(entryKey: string) {
    return this.db.collection(this.collection).doc(encodeURIComponent(entryKey));
  }

  async mark(entryKey: string, retryAt: Date): Promise<void> {
    await this.doc(entryKey).set({ retryAt });
  }

  async check(entryKey: string): Promise<Date | null> {
    const snap = await this.doc(entryKey).get();
    if (!snap.exists) return null;
    const retryAt: Date = snap.get("retryAt").toDate();
    if (retryAt.getTime() <= Date.now()) {
      await this.doc(entryKey).delete(); // prune expired cooldowns
      return null;
    }
    return retryAt;
  }
}
```

### Verifying a store implementation

Verify any implementation against the behavioral contract (framework-agnostic,
works in any test runner). Since v0.1.1 the contract includes a
slash-containing key, so it catches the document-ID class of bug above:

```ts
import { verifyCooldownStoreContract } from "@alexplusplus/llm-fallback-chain";

await verifyCooldownStoreContract(() => new FirestoreCooldownStore(db));
```

**Persistent stores need a throwaway collection per run.** The contract suite
uses fixed key names, so state left behind by a previous run violates the
"unmarked key returns `null`" assertion. Point each run at a fresh,
disposable collection (and delete it afterwards, or let a TTL policy expire
it):

```ts
const collection = `cooldown-contract-${Date.now()}`;
await verifyCooldownStoreContract(() => new FirestoreCooldownStore(db, collection));
```

The factory is called several times per run; sharing one throwaway collection
across those instances is fine — the contract's key names don't collide with
each other, only with earlier runs.

## Deploying on Netlify: environment variables

A typical serverless deployment (the setup this section describes was proven
on Netlify with a Nuxt/Nitro app) needs two groups of environment variables:
provider API keys for the chain, and Firebase service-account credentials for
a Firestore-backed cooldown store. All of them are **server-side secrets** —
none may ever be exposed to the client bundle (no `NUXT_PUBLIC_` / `VITE_` /
`NEXT_PUBLIC_` prefixes).

### 1. Provider API keys

One per provider that appears in your chain:

| Variable | Used by | Where to get it |
| --- | --- | --- |
| `GEMINI_API_KEY` | `GeminiAdapter` | [Google AI Studio](https://aistudio.google.com/apikey) |
| `OPENROUTER_API_KEY` | `OpenRouterAdapter` | [OpenRouter → Keys](https://openrouter.ai/keys) |
| `OPENAI_API_KEY` | `OpenAiAdapter` | [OpenAI platform → API keys](https://platform.openai.com/api-keys) |

Consider skipping chain entries whose key is missing (with a startup warning)
instead of failing: the app then keeps working on whatever providers are
configured, and a partially configured preview deploy still serves requests.

### 2. Firebase credentials for the cooldown store

Netlify functions have no Google Cloud identity, so firebase-admin's
`applicationDefault()` cannot work there — you must pass an explicit service
account:

1. In the [Firebase console](https://console.firebase.google.com/), open your
   project → ⚙ **Project settings** → **Service accounts** → **Generate new
   private key**. This downloads a JSON file.
2. From that JSON you need three values: `project_id`, `client_email`, and
   `private_key`. Do **not** commit the file or ship it in the repo.
3. Set them as `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and
   `FIREBASE_PRIVATE_KEY`.

**The private-key newline gotcha.** `private_key` is a multi-line PEM block.
Depending on how you set the variable (UI paste vs. CLI vs. copying the JSON
value with its `\n` escape sequences intact), the value that reaches your
function may contain literal backslash-n instead of real newlines — and
firebase-admin then fails with `Invalid PEM formatted message`. Normalize in
code; the `replace` is a no-op when the newlines are already real:

```ts
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// A named app avoids colliding with any firebase-admin app your framework
// integration (e.g. nuxt-vuefire) registers in the same process.
const APP_NAME = "llm-chain";

export function getAdminFirestore() {
  const existing = getApps().find((a) => a.name === APP_NAME);
  const app =
    existing ??
    initializeApp(
      {
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID!,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
          privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
        }),
      },
      APP_NAME,
    );
  return getFirestore(app);
}
```

### 3. Setting the variables in Netlify

- **UI:** Project configuration → **Environment variables** → *Add a
  variable*. Paste the PEM value as-is (the multi-line textarea preserves
  newlines). Mark each of these as **secret** so they're masked in logs and
  the UI, and restrict the scope to **Functions** — neither the build nor
  post-processing needs provider keys or Firebase credentials.
- **CLI:** `netlify env:set GEMINI_API_KEY "…" --secret`. For the private
  key it's usually easier to paste the JSON's `private_key` string (with its
  `\n` escapes) and rely on the `replace()` above.
- Environment variables are baked into functions **at deploy time** — after
  adding or changing one, trigger a redeploy or it won't be picked up.
- **Size limit:** Netlify functions run on AWS Lambda, which caps the total
  environment at 4 KB. A Firebase private key alone is ~1.7 KB, so keep
  unrelated variables scoped away from Functions if you get close.
- **Local dev:** `netlify dev` injects the same variables locally; without
  it, put the values in your framework's `.env` (git-ignored).

### 4. Wire it together

```ts
const chain = createFallbackChain({
  entries,
  cooldownStore: new FirestoreCooldownStore(getAdminFirestore()),
});
```

Consider wrapping the store fail-open (catch and log store errors, treat
`check` as "not on cooldown") so Firestore trouble can degrade cooldown
persistence instead of blocking generation.

## Writing an adapter

A Provider is one class implementing two members ([ADR 0001](docs/adr/0001-raw-provider-sdks.md)):

```ts
import {
  type ProviderAdapter, type AdapterRequest,
  toStrictJsonSchema, // or toGeminiSchema / toJsonSchemaResponseFormat
  QuotaError, TransientError, InvalidRequestError,
} from "@alexplusplus/llm-fallback-chain";

class MyAdapter implements ProviderAdapter {
  readonly providerId = "my-provider";

  async generate(request: AdapterRequest): Promise<string> {
    // 1. If request.schema is present (structured mode), compile it (portable
    //    form) to your provider's dialect; request.schemaName is set alongside
    //    it. If absent (plain-text mode), omit your provider's
    //    schema-enforcement field from the request entirely.
    // 2. If request.reasoningEffort is present, convert it to your provider's
    //    dialect (hardcoded map, see ADR 0003); if absent, send no
    //    reasoning-related field. The chain has already validated the value.
    // 3. Call the provider with request.modelId and request.prompt.
    // 4. Return the raw response text — in structured mode the chain parses
    //    and validates it; in plain mode it is returned verbatim.
    // 5. Map every failure to QuotaError (with a retryAt hint when the
    //    provider gives one), TransientError, or InvalidRequestError.
  }
}
```

Adapters never see the chain: ordering, cooldowns, and fallthrough live
entirely in the chain walker.

> Since v0.2.0, `request.schema` / `request.schemaName` are optional
> (absent = plain-text mode) and `request.reasoningEffort` was added. Custom
> adapters written against v0.1.x assumed `schema` was always present —
> handle its absence when upgrading.

## Configuration reference

```ts
createFallbackChain({
  entries,                              // required, tried top-down
  cooldownStore,                        // default: new InMemoryCooldownStore()
  transientCooldownMs: 60_000,          // short cooldown length
  quotaRetryFallback: nextUtcMidnight,  // long cooldown when provider gives no hint
  now: () => new Date(),                // injectable clock (tests)
});
```

## License

[MIT](LICENSE)
