import OpenAI from "openai";
import {
  InvalidRequestError,
  LlmChainError,
  QuotaError,
  TransientError,
} from "../errors.js";
import { toJsonSchemaResponseFormat } from "../schema/dialects.js";
import type { AdapterRequest, ProviderAdapter } from "../types.js";

/**
 * Structural slice of the `openai` SDK client the adapter actually uses.
 * Tests inject a fake matching this shape (mocked-SDK seam).
 */
export interface OpenAiClientLike {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: { role: "user"; content: string }[];
        response_format: {
          type: "json_schema";
          json_schema: { name: string; strict: true; schema: Record<string, unknown> };
        };
      }): Promise<{
        choices: { message?: { content?: string | null | undefined } | undefined }[];
      }>;
    };
  };
}

export interface OpenAiAdapterOptions {
  apiKey?: string;
  /** Injectable for tests; defaults to a real `OpenAI` client. */
  client?: OpenAiClientLike;
}

/**
 * Adapter for the OpenAI API, using strict `json_schema` response format.
 */
export class OpenAiAdapter implements ProviderAdapter {
  readonly providerId = "openai";
  private readonly client: OpenAiClientLike;

  constructor(options: OpenAiAdapterOptions = {}) {
    this.client =
      options.client ??
      new OpenAI(options.apiKey !== undefined ? { apiKey: options.apiKey } : {});
  }

  async generate(request: AdapterRequest): Promise<string> {
    let response: { choices: { message?: { content?: string | null | undefined } | undefined }[] };
    try {
      response = await this.client.chat.completions.create({
        model: request.modelId,
        messages: [{ role: "user", content: request.prompt }],
        response_format: toJsonSchemaResponseFormat(request.schema, request.schemaName),
      });
    } catch (error) {
      throw classifyOpenAiError(error);
    }
    const text = response.choices[0]?.message?.content;
    if (text === undefined || text === null || text === "") {
      throw new TransientError("OpenAI returned an empty response");
    }
    return text;
  }
}

function classifyOpenAiError(error: unknown): LlmChainError {
  if (error instanceof LlmChainError) return error;

  const status = statusOf(error);
  const message = messageOf(error);

  // 429 covers both rate limits and `insufficient_quota` — either way the
  // entry should cool down and the chain should fall through.
  if (status === 429) {
    const retryAt = retryAfterOf(error);
    return new QuotaError(`OpenAI quota exhausted: ${message}`, {
      ...(retryAt !== undefined ? { retryAt } : {}),
      cause: error,
    });
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 408) {
    return new InvalidRequestError(`OpenAI rejected the request (${status}): ${message}`, {
      cause: error,
    });
  }
  return new TransientError(`OpenAI request failed: ${message}`, { cause: error });
}

/** Best-effort `retry-after` (seconds) header from the SDK's APIError. */
function retryAfterOf(error: unknown): Date | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const headers = (error as { headers?: unknown }).headers;
  let value: string | null | undefined;
  if (headers instanceof Headers) {
    value = headers.get("retry-after");
  } else if (typeof headers === "object" && headers !== null) {
    value = (headers as Record<string, string | undefined>)["retry-after"];
  }
  if (value === null || value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(Date.now() + seconds * 1000);
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
