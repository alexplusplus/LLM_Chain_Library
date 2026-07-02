import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  GeminiAdapter,
  InvalidRequestError,
  QuotaError,
  TransientError,
  zodToPortable,
  type AdapterRequest,
  type GeminiClientLike,
} from "../../src/index.js";

const request: AdapterRequest = {
  modelId: "gemini-2.5-flash",
  prompt: "generate",
  schema: zodToPortable(z.object({ text: z.string() })),
  schemaName: "response",
};

type GenerateParams = Parameters<GeminiClientLike["models"]["generateContent"]>[0];

function clientReturning(text: string | undefined, capture?: (p: GenerateParams) => void): GeminiClientLike {
  return {
    models: {
      async generateContent(params) {
        capture?.(params);
        return { text };
      },
    },
  };
}

function clientThrowing(error: unknown): GeminiClientLike {
  return {
    models: {
      async generateContent() {
        throw error;
      },
    },
  };
}

/** Mimics @google/genai's ApiError shape: an Error with a numeric status. */
function apiError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

describe("GeminiAdapter", () => {
  it("sends the Gemini schema dialect and returns the raw text", async () => {
    let sent: GenerateParams | undefined;
    const adapter = new GeminiAdapter({ client: clientReturning('{"text":"ok"}', (p) => (sent = p)) });

    const raw = await adapter.generate(request);

    expect(raw).toBe('{"text":"ok"}');
    expect(sent?.model).toBe("gemini-2.5-flash");
    expect(sent?.contents).toBe("generate");
    expect(sent?.config.responseMimeType).toBe("application/json");
    expect(sent?.config.responseSchema).toMatchObject({
      type: "OBJECT",
      properties: { text: { type: "STRING" } },
      required: ["text"],
    });
  });

  it("classifies 429 as QuotaError and parses the retryDelay hint", async () => {
    const message =
      'got status: 429 . {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"39s"}]}}';
    const adapter = new GeminiAdapter({ client: clientThrowing(apiError(429, message)) });
    const before = Date.now();

    const error = await adapter.generate(request).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(QuotaError);
    const retryAt = (error as QuotaError).retryAt;
    expect(retryAt).toBeInstanceOf(Date);
    const deltaSeconds = ((retryAt as Date).getTime() - before) / 1000;
    expect(deltaSeconds).toBeGreaterThan(37);
    expect(deltaSeconds).toBeLessThan(41);
  });

  it("classifies 429 without a hint as QuotaError with undefined retryAt", async () => {
    const adapter = new GeminiAdapter({ client: clientThrowing(apiError(429, "quota exceeded")) });
    const error = await adapter.generate(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuotaError);
    expect((error as QuotaError).retryAt).toBeUndefined();
  });

  it.each([[400], [401], [403], [404]])("classifies %i as InvalidRequestError", async (status) => {
    const adapter = new GeminiAdapter({ client: clientThrowing(apiError(status, "bad")) });
    await expect(adapter.generate(request)).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it.each([[500], [503], [504], [408]])("classifies %i as TransientError", async (status) => {
    const adapter = new GeminiAdapter({ client: clientThrowing(apiError(status, "down")) });
    await expect(adapter.generate(request)).rejects.toBeInstanceOf(TransientError);
  });

  it("classifies network errors (no status) as TransientError", async () => {
    const adapter = new GeminiAdapter({ client: clientThrowing(new Error("fetch failed")) });
    await expect(adapter.generate(request)).rejects.toBeInstanceOf(TransientError);
  });

  it("treats an empty response as TransientError", async () => {
    const adapter = new GeminiAdapter({ client: clientReturning(undefined) });
    await expect(adapter.generate(request)).rejects.toBeInstanceOf(TransientError);
  });
});
