import {
  InvalidRequestError,
  LlmChainError,
  QuotaError,
  TransientError,
} from "../errors.js";
import { toJsonSchemaResponseFormat } from "../schema/dialects.js";
import type { AdapterRequest, ProviderAdapter } from "../types.js";

export interface OpenRouterAdapterOptions {
  apiKey: string;
  /** Default: `https://openrouter.ai/api/v1`. */
  baseUrl?: string;
  /** Optional attribution headers OpenRouter recommends (`HTTP-Referer`, `X-Title`). */
  headers?: Record<string, string>;
  /** Injectable for tests; defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Adapter for OpenRouter's OpenAI-compatible endpoint, at the HTTP level
 * (no SDK), using `response_format: json_schema`.
 *
 * Note (ADR 0002): only schema-capable models qualify as Chain Entries;
 * most `:free` variants do not enforce `json_schema` and are disqualified.
 */
export class OpenRouterAdapter implements ProviderAdapter {
  readonly providerId = "openrouter";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: OpenRouterAdapterOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    this.extraHeaders = options.headers ?? {};
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async generate(request: AdapterRequest): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...this.extraHeaders,
        },
        body: JSON.stringify({
          model: request.modelId,
          messages: [{ role: "user", content: request.prompt }],
          response_format: toJsonSchemaResponseFormat(request.schema, request.schemaName),
        }),
      });
    } catch (error) {
      // fetch itself only rejects on network-level failures.
      throw new TransientError(`OpenRouter request failed: ${messageOf(error)}`, { cause: error });
    }

    const bodyText = await response.text();

    if (!response.ok) {
      throw classifyHttpError(response, bodyText);
    }

    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new TransientError("OpenRouter returned a non-JSON response body");
    }

    // OpenRouter can pass provider errors through inside a 200 body.
    const passthrough = errorOf(body);
    if (passthrough !== undefined) {
      throw classifyPassthroughError(passthrough);
    }

    const text = contentOf(body);
    if (text === undefined || text === "") {
      throw new TransientError("OpenRouter returned an empty response");
    }
    return text;
  }
}

function classifyHttpError(response: Response, bodyText: string): LlmChainError {
  const status = response.status;
  const message = extractErrorMessage(bodyText) ?? `HTTP ${status}`;

  if (status === 429) {
    const retryAt = rateLimitResetOf(response.headers);
    return new QuotaError(`OpenRouter quota exhausted: ${message}`, {
      ...(retryAt !== undefined ? { retryAt } : {}),
    });
  }
  // 402: account out of credits — quota-shaped, not a malformed request.
  if (status === 402) {
    return new QuotaError(`OpenRouter credits exhausted: ${message}`);
  }
  if (status >= 400 && status < 500 && status !== 408) {
    return new InvalidRequestError(`OpenRouter rejected the request (${status}): ${message}`);
  }
  return new TransientError(`OpenRouter request failed (${status}): ${message}`);
}

function classifyPassthroughError(err: { code?: unknown; message?: unknown }): LlmChainError {
  const code = typeof err.code === "number" ? err.code : undefined;
  const message = typeof err.message === "string" ? err.message : "provider error";
  if (code === 429 || code === 402) {
    return new QuotaError(`OpenRouter provider quota exhausted: ${message}`);
  }
  if (code !== undefined && code >= 400 && code < 500 && code !== 408) {
    return new InvalidRequestError(`OpenRouter provider rejected the request (${code}): ${message}`);
  }
  return new TransientError(`OpenRouter provider error: ${message}`);
}

/** `X-RateLimit-Reset` is a unix epoch in milliseconds. */
function rateLimitResetOf(headers: Headers): Date | undefined {
  const reset = headers.get("x-ratelimit-reset");
  if (reset === null) return undefined;
  const ms = Number(reset);
  if (!Number.isFinite(ms) || ms <= Date.now()) return undefined;
  return new Date(ms);
}

function extractErrorMessage(bodyText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const err = errorOf(parsed);
    return typeof err?.message === "string" ? err.message : undefined;
  } catch {
    return undefined;
  }
}

function errorOf(body: unknown): { code?: unknown; message?: unknown } | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== "object" || err === null) return undefined;
  return err as { code?: unknown; message?: unknown };
}

function contentOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0] as { message?: { content?: unknown } };
  const content = first?.message?.content;
  return typeof content === "string" ? content : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
