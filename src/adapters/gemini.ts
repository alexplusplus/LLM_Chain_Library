import { GoogleGenAI } from "@google/genai";
import {
  InvalidRequestError,
  LlmChainError,
  QuotaError,
  TransientError,
} from "../errors.js";
import type { ReasoningEffort } from "../effort.js";
import { toGeminiSchema } from "../schema/dialects.js";
import type { AdapterRequest, ProviderAdapter } from "../types.js";

/**
 * Unified effort → Gemini `thinkingConfig.thinkingBudget` (tokens). Effort is
 * per-request while Chain Entries are fixed, so one value must survive every
 * entry it walks: budgets are sized to fit within every Gemini 2.5-family
 * model range (Flash caps at 24576). `0` disables thinking — models that
 * can't disable it (2.5 Pro, floor 128) reject it; see the README caveat.
 * Ranges: https://ai.google.dev/gemini-api/docs/thinking#set-budget
 */
const THINKING_BUDGETS: Record<ReasoningEffort, number> = {
  minimal: 0,
  low: 1024,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
};

/**
 * Structural slice of the `@google/genai` client the adapter actually uses.
 * Tests inject a fake matching this shape (mocked-SDK seam).
 */
export interface GeminiClientLike {
  models: {
    generateContent(params: {
      model: string;
      contents: string;
      config: {
        /** Sent in structured mode only; omitted entirely in plain-text mode. */
        responseMimeType?: string;
        responseSchema?: Record<string, unknown>;
        /** Sent only when the request carries a reasoning effort. */
        thinkingConfig?: { thinkingBudget: number };
      };
    }): Promise<{ text?: string | undefined }>;
  };
}

export interface GeminiAdapterOptions {
  apiKey?: string;
  /** Injectable for tests; defaults to a real `GoogleGenAI` client. */
  client?: GeminiClientLike;
}

/**
 * Adapter for the Gemini API (`@google/genai` SDK), using native
 * `responseSchema` JSON enforcement in structured mode and no enforcement
 * config in plain-text mode.
 *
 * Reasoning effort maps to a hardcoded `thinkingBudget` (ADR 0003); see
 * {@link THINKING_BUDGETS} for the correspondence and its sizing rationale.
 */
export class GeminiAdapter implements ProviderAdapter {
  readonly providerId = "gemini";
  private readonly client: GeminiClientLike;

  constructor(options: GeminiAdapterOptions = {}) {
    this.client =
      options.client ??
      new GoogleGenAI(options.apiKey !== undefined ? { apiKey: options.apiKey } : {});
  }

  async generate(request: AdapterRequest): Promise<string> {
    let response: { text?: string | undefined };
    try {
      response = await this.client.models.generateContent({
        model: request.modelId,
        contents: request.prompt,
        config: {
          ...(request.schema !== undefined
            ? {
                responseMimeType: "application/json",
                responseSchema: toGeminiSchema(request.schema),
              }
            : {}),
          ...(request.reasoningEffort !== undefined
            ? { thinkingConfig: { thinkingBudget: THINKING_BUDGETS[request.reasoningEffort] } }
            : {}),
        },
      });
    } catch (error) {
      throw classifyGeminiError(error);
    }
    const text = response.text;
    if (text === undefined || text === "") {
      throw new TransientError("Gemini returned an empty response");
    }
    return text;
  }
}

function classifyGeminiError(error: unknown): LlmChainError {
  if (error instanceof LlmChainError) return error;

  const status = statusOf(error);
  const message = messageOf(error);

  if (status === 429) {
    return new QuotaError(`Gemini quota exhausted: ${message}`, {
      ...(parseRetryDelay(message) ?? {}),
      cause: error,
    });
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 408) {
    return new InvalidRequestError(`Gemini rejected the request (${status}): ${message}`, {
      cause: error,
    });
  }
  // 5xx, 408, or no HTTP status at all (network/timeout).
  return new TransientError(`Gemini request failed: ${message}`, { cause: error });
}

/**
 * Gemini 429 bodies embed a RetryInfo detail like `"retryDelay":"39s"`;
 * surface it as an absolute retry time so the chain can size the Cooldown.
 */
function parseRetryDelay(message: string): { retryAt: Date } | undefined {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  if (!match?.[1]) return undefined;
  return { retryAt: new Date(Date.now() + Number(match[1]) * 1000) };
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
