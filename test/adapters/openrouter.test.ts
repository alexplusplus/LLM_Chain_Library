import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  InvalidRequestError,
  OpenRouterAdapter,
  QuotaError,
  TransientError,
  zodToPortable,
  type AdapterRequest,
} from "../../src/index.js";

const request: AdapterRequest = {
  modelId: "meta-llama/llama-3.3-70b-instruct",
  prompt: "generate",
  schema: zodToPortable(z.object({ text: z.string() })),
  schemaName: "my_schema",
};

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function fetchReturning(
  body: unknown,
  options?: { status?: number; headers?: Record<string, string> },
  capture?: (call: CapturedCall) => void,
): typeof globalThis.fetch {
  return (async (url: unknown, init?: RequestInit) => {
    capture?.({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: options?.status ?? 200,
      headers: options?.headers ?? {},
    });
  }) as typeof globalThis.fetch;
}

const success = {
  choices: [{ message: { content: '{"text":"ok"}' } }],
};

describe("OpenRouterAdapter", () => {
  it("POSTs the OpenAI-compatible payload with auth and returns the content", async () => {
    let call: CapturedCall | undefined;
    const adapter = new OpenRouterAdapter({
      apiKey: "sk-or-test",
      fetch: fetchReturning(success, {}, (c) => (call = c)),
    });

    const raw = await adapter.generate(request);

    expect(raw).toBe('{"text":"ok"}');
    expect(call?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-test");
    const payload = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
    expect(payload.model).toBe("meta-llama/llama-3.3-70b-instruct");
    expect(payload.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "my_schema", strict: true },
    });
  });

  it("classifies 429 as QuotaError and reads X-RateLimit-Reset (epoch ms)", async () => {
    const resetAt = Date.now() + 90_000;
    const adapter = new OpenRouterAdapter({
      apiKey: "k",
      fetch: fetchReturning(
        { error: { code: 429, message: "Rate limit exceeded: free tier" } },
        { status: 429, headers: { "X-RateLimit-Reset": String(resetAt) } },
      ),
    });

    const error = await adapter.generate(request).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(QuotaError);
    expect((error as QuotaError).retryAt?.getTime()).toBe(resetAt);
    expect((error as QuotaError).message).toContain("free tier");
  });

  it("classifies 402 (out of credits) as QuotaError, not InvalidRequestError", async () => {
    const adapter = new OpenRouterAdapter({
      apiKey: "k",
      fetch: fetchReturning({ error: { code: 402, message: "Insufficient credits" } }, { status: 402 }),
    });
    await expect(adapter.generate(request)).rejects.toBeInstanceOf(QuotaError);
  });

  it.each([[400], [401], [404]])("classifies %i as InvalidRequestError", async (status) => {
    const adapter = new OpenRouterAdapter({
      apiKey: "k",
      fetch: fetchReturning({ error: { code: status, message: "bad" } }, { status }),
    });
    await expect(adapter.generate(request)).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it.each([[500], [502], [503]])("classifies %i as TransientError", async (status) => {
    const adapter = new OpenRouterAdapter({
      apiKey: "k",
      fetch: fetchReturning({ error: { code: status, message: "down" } }, { status }),
    });
    await expect(adapter.generate(request)).rejects.toBeInstanceOf(TransientError);
  });

  it("classifies provider-passthrough errors inside a 200 body", async () => {
    const adapter = new OpenRouterAdapter({
      apiKey: "k",
      fetch: fetchReturning({ error: { code: 429, message: "Provider rate limited" } }),
    });
    await expect(adapter.generate(request)).rejects.toBeInstanceOf(QuotaError);
  });

  it("classifies network failures as TransientError", async () => {
    const failingFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const adapter = new OpenRouterAdapter({ apiKey: "k", fetch: failingFetch });
    await expect(adapter.generate(request)).rejects.toBeInstanceOf(TransientError);
  });

  it("treats an empty choices payload as TransientError", async () => {
    const adapter = new OpenRouterAdapter({ apiKey: "k", fetch: fetchReturning({ choices: [] }) });
    await expect(adapter.generate(request)).rejects.toBeInstanceOf(TransientError);
  });
});
