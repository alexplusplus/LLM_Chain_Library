// Core chain
export {
  createFallbackChain,
  type ChainEntryConfig,
  type FallbackChain,
  type FallbackChainConfig,
  type GenerateRequest,
  type GenerateResult,
  type PlainGenerateRequest,
  type PlainGenerateResult,
} from "./chain.js";

// Reasoning effort (unified dictionary, ADR 0003)
export { REASONING_EFFORTS, type ReasoningEffort } from "./effort.js";

// Contracts
export type {
  AdapterRequest,
  ChainEntry,
  CooldownStore,
  ProviderAdapter,
} from "./types.js";

// Errors
export {
  ChainExhaustedError,
  InvalidRequestError,
  LlmChainError,
  QuotaError,
  TransientError,
  type EntryFailure,
  type EntryFailureReason,
} from "./errors.js";

// Cooldown stores
export { InMemoryCooldownStore } from "./cooldown/in-memory.js";
export { verifyCooldownStoreContract } from "./cooldown/contract.js";

// Schema compilation (exported for adapter authors)
export {
  zodToPortable,
  type PortableSchema,
  type PortableArray,
  type PortableBoolean,
  type PortableEnum,
  type PortableNumber,
  type PortableObject,
  type PortableString,
} from "./schema/portable.js";
export {
  toGeminiSchema,
  toJsonSchemaResponseFormat,
  toStrictJsonSchema,
} from "./schema/dialects.js";

// Provider adapters
export { GeminiAdapter, type GeminiAdapterOptions, type GeminiClientLike } from "./adapters/gemini.js";
export { OpenAiAdapter, type OpenAiAdapterOptions, type OpenAiClientLike } from "./adapters/openai.js";
export { OpenRouterAdapter, type OpenRouterAdapterOptions } from "./adapters/openrouter.js";

// Utilities
export { nextUtcMidnight } from "./time.js";
