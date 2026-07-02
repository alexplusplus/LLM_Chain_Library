import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InvalidRequestError, zodToPortable } from "../src/index.js";

describe("zodToPortable", () => {
  it("compiles a realistic word-set schema (the w2t shape)", () => {
    const schema = z.object({
      paragraphs: z.array(z.string()).describe("Three short texts"),
      definitions: z.string(),
      word_forms: z.array(
        z.object({
          word: z.string(),
          forms: z.array(z.string()),
        }),
      ),
    });

    expect(zodToPortable(schema)).toEqual({
      kind: "object",
      properties: {
        paragraphs: {
          kind: "array",
          items: { kind: "string" },
          description: "Three short texts",
        },
        definitions: { kind: "string" },
        word_forms: {
          kind: "array",
          items: {
            kind: "object",
            properties: {
              word: { kind: "string" },
              forms: { kind: "array", items: { kind: "string" } },
            },
          },
        },
      },
    });
  });

  it("supports numbers, integers, and booleans", () => {
    const schema = z.object({
      count: z.number(),
      index: z.number().int(),
      done: z.boolean(),
    });

    expect(zodToPortable(schema)).toEqual({
      kind: "object",
      properties: {
        count: { kind: "number" },
        index: { kind: "number", integer: true },
        done: { kind: "boolean" },
      },
    });
  });

  it("supports string enums and string literals", () => {
    const schema = z.object({
      level: z.enum(["a1", "a2", "b1"]),
      kind: z.literal("word_set"),
    });

    expect(zodToPortable(schema)).toEqual({
      kind: "object",
      properties: {
        level: { kind: "enum", values: ["a1", "a2", "b1"] },
        kind: { kind: "enum", values: ["word_set"] },
      },
    });
  });

  it("supports .nullable() on fields", () => {
    const schema = z.object({
      translation: z.string().nullable(),
    });

    expect(zodToPortable(schema)).toEqual({
      kind: "object",
      properties: {
        translation: { kind: "string", nullable: true },
      },
    });
  });

  it("rejects a non-object root", () => {
    expect(() => zodToPortable(z.array(z.string()))).toThrow(InvalidRequestError);
    expect(() => zodToPortable(z.string())).toThrow(/root/i);
  });

  it("rejects .optional() fields with a message pointing to .nullable()", () => {
    const schema = z.object({ maybe: z.string().optional() });
    expect(() => zodToPortable(schema)).toThrow(InvalidRequestError);
    expect(() => zodToPortable(schema)).toThrow(/nullable/);
  });

  it("rejects unions, records, tuples, and dates", () => {
    const cases: z.ZodType[] = [
      z.object({ v: z.union([z.string(), z.number()]) }),
      z.object({ v: z.record(z.string(), z.string()) }),
      z.object({ v: z.tuple([z.string(), z.number()]) }),
      z.object({ v: z.date() }),
    ];
    for (const schema of cases) {
      expect(() => zodToPortable(schema)).toThrow(InvalidRequestError);
    }
  });

  it("names the offending path in rejection messages", () => {
    const schema = z.object({
      outer: z.object({ bad: z.union([z.string(), z.number()]) }),
    });
    expect(() => zodToPortable(schema)).toThrow(/outer\.bad/);
  });
});
