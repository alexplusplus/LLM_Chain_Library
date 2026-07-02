# llm-fallback-chain

Structured LLM output through a configurable provider **fallback chain**:
free tiers first, a paid floor last, with pluggable cooldown storage.

Pass a prompt and a [zod](https://zod.dev) schema; the chain walks your
entries top-down and returns parsed, TypeScript-typed data — or a classified
error. Quota-exhausted or flaky entries go on **cooldown** and are skipped
until they recover, so a free tier running dry falls through to the next
entry instead of failing your request.

```
Gemini (free) ──quota──▶ OpenRouter (cheap) ──5xx──▶ OpenAI (floor) ──▶ ✓ typed data
     │                        │
  cooldown until          cooldown 60s
  daily reset
```

## Install

```sh
npm install llm-fallback-chain zod
```

`zod` (v4) is a peer dependency.

## Quickstart

```ts
import { z } from "zod";
import {
  createFallbackChain,
  GeminiAdapter,
  OpenAiAdapter,
  OpenRouterAdapter,
} from "llm-fallback-chain";

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

## How the chain walks

For each entry, top-down:

| Outcome | Classification | Effect |
| --- | --- | --- |
| Success | — | Response validated against your zod schema, returned with serving-entry metadata |
| Quota exhausted (429/402) | `QuotaError` | Long cooldown — provider's retry hint, else next UTC midnight — then falls through |
| Transient failure (5xx, timeout, network) | `TransientError` | Short cooldown (default 60 s), falls through |
| Output fails JSON/schema validation | — | Treated like transient: short cooldown, falls through |
| Bad request (4xx: schema, prompt, API key) | `InvalidRequestError` | **Whole call fails immediately.** No cooldown, no fallthrough — the same bug would fail on every entry, silently burning paid quota |
| Every entry skipped/failed | `ChainExhaustedError` | Carries a per-entry failure list for diagnostics |

Entries already on cooldown are skipped without a provider call.

## The portable schema subset

All entries must be able to enforce your schema natively (see
[ADR 0002](docs/adr/0002-native-schema-only.md)), so schemas are limited to
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
createFallbackChain({ entries, cooldownStore: new MyFirestoreCooldownStore(db) });
```

Verify any implementation against the behavioral contract (framework-agnostic,
works in any test runner):

```ts
import { verifyCooldownStoreContract } from "llm-fallback-chain";

await verifyCooldownStoreContract(() => new MyFirestoreCooldownStore(db));
```

## Writing an adapter

A Provider is one class implementing two members ([ADR 0001](docs/adr/0001-raw-provider-sdks.md)):

```ts
import {
  type ProviderAdapter, type AdapterRequest,
  toStrictJsonSchema, // or toGeminiSchema / toJsonSchemaResponseFormat
  QuotaError, TransientError, InvalidRequestError,
} from "llm-fallback-chain";

class MyAdapter implements ProviderAdapter {
  readonly providerId = "my-provider";

  async generate(request: AdapterRequest): Promise<string> {
    // 1. Compile request.schema (portable form) to your provider's dialect.
    // 2. Call the provider with request.modelId and request.prompt.
    // 3. Return the raw JSON text — the chain parses and validates it.
    // 4. Map every failure to QuotaError (with a retryAt hint when the
    //    provider gives one), TransientError, or InvalidRequestError.
  }
}
```

Adapters never see the chain: ordering, cooldowns, and fallthrough live
entirely in the chain walker.

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
