import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  InvalidRequestError,
  OpenAiAdapter,
  QuotaError,
  TransientError,
  zodToPortable,
  type AdapterRequest,
  type OpenAiClientLike,
} from "../../src/index.js";

const request: AdapterRequest = {
  modelId: "gpt-4o-mini",
  prompt: "generate",
  schema: zodToPortable(z.object({ text: z.string() })),
  schemaName: "my_schema",
};

type CreateParams = Parameters<OpenAiClientLike["chat"]["completions"]["create"]>[0];

function clientReturning(
  content: string | null | undefined,
  capture?: (p: CreateParams) => void,
): OpenAiClientLike {
  return {
    chat: {
      completions: {
        async create(params) {
          capture?.(params);
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
}

function clientThrowing(error: unknown): OpenAiClientLike {
  return {
    chat: {
      completions: {
        async create() {
          throw error;
        },
      },
    },
  };
}

/** Mimics the openai SDK's APIError shape. */
function apiError(
  status: number,
  message: string,
  headers?: Record<string, string>,
): Error & { status: number; headers?: Headers } {
  return Object.assign(new Error(message), {
    status,
    ...(headers ? { headers: new Headers(headers) } : {}),
  });
}

describe("OpenAiAdapter", () => {
  it("sends the strict json_schema response format and returns the content", async () => {
    let sent: CreateParams | undefined;
    const adapter = new OpenAiAdapter({ client: clientReturning('{"text":"ok"}', (p) => (sent = p)) });

    const raw = await adapter.generate(request);

    expect(raw).toBe('{"text":"ok"}');
    expect(sent?.model).toBe("gpt-4o-mini");
    expect(sent?.messages).toEqual([{ role: "user", content: "generate" }]);
    expect(sent?.response_format.type).toBe("json_schema");
    expect(sent?.response_format.json_schema.name).toBe("my_schema");
    expect(sent?.response_format.json_schema.strict).toBe(true);
    expect(sent?.response_format.json_schema.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["text"],
    });
  });

  it("classifies 429 as QuotaError and honors a retry-after header", async () => {
    const adapter = new OpenAiAdapter({
      client: clientThrowing(apiError(429, "rate limited", { "retry-after": "120" })),
    });
    const before = Date.now();

    const error = await adapter.generate(request).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(QuotaError);
    const retryAt = (error as QuotaError).retryAt;
    const deltaSeconds = ((retryAt as Date).getTime() - before) / 1000;
    expect(deltaSeconds).toBeGreaterThan(118);
    expect(deltaSeconds).toBeLessThan(122);
  });

  it("classifies insufficient_quota (429, no header) as QuotaError without retryAt", async () => {
    const adapter = new OpenAiAdapter({
      client: clientThrowing(apiError(429, "You exceeded your current quota")),
    });
    const error = await adapter.generate(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuotaError);
    expect((error as QuotaError).retryAt).toBeUndefined();
  });

  it.each([[400], [401], [404]])("classifies %i as InvalidRequestError", async (status) => {
    const adapter = new OpenAiAdapter({ client: clientThrowing(apiError(status, "bad")) });
    await expect(adapter.generate(request)).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it.each([[500], [503]])("classifies %i as TransientError", async (status) => {
    const adapter = new OpenAiAdapter({ client: clientThrowing(apiError(status, "down")) });
    await expect(adapter.generate(request)).rejects.toBeInstanceOf(TransientError);
  });

  it("classifies connection errors (no status) as TransientError", async () => {
    const adapter = new OpenAiAdapter({ client: clientThrowing(new Error("Connection error")) });
    await expect(adapter.generate(request)).rejects.toBeInstanceOf(TransientError);
  });

  it("treats an empty completion as TransientError", async () => {
    const adapter = new OpenAiAdapter({ client: clientReturning(null) });
    await expect(adapter.generate(request)).rejects.toBeInstanceOf(TransientError);
  });
});
