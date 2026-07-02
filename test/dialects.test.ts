import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  toGeminiSchema,
  toJsonSchemaResponseFormat,
  toStrictJsonSchema,
  zodToPortable,
} from "../src/index.js";

const portable = zodToPortable(
  z.object({
    text: z.string().describe("The generated text"),
    translation: z.string().nullable(),
    words: z.array(z.object({ word: z.string(), count: z.number().int() })),
    level: z.enum(["a1", "b1"]),
    done: z.boolean(),
  }),
);

describe("toStrictJsonSchema (OpenAI / OpenRouter dialect)", () => {
  const compiled = toStrictJsonSchema(portable);

  it("marks every object additionalProperties:false with all fields required", () => {
    expect(compiled).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["text", "translation", "words", "level", "done"],
    });
    const words = (compiled.properties as Record<string, Record<string, unknown>>).words;
    expect(words?.items).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["word", "count"],
    });
  });

  it("expresses nullability as anyOf with null", () => {
    const props = compiled.properties as Record<string, unknown>;
    expect(props.translation).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
  });

  it("keeps descriptions, integers, enums, and booleans", () => {
    const props = compiled.properties as Record<string, Record<string, unknown>>;
    expect(props.text).toEqual({ type: "string", description: "The generated text" });
    expect(props.level).toEqual({ type: "string", enum: ["a1", "b1"] });
    expect(props.done).toEqual({ type: "boolean" });
    const words = props.words as { items?: { properties?: Record<string, unknown> } };
    expect(words.items?.properties?.count).toEqual({ type: "integer" });
  });
});

describe("toJsonSchemaResponseFormat", () => {
  it("wraps the strict schema in a named json_schema response format", () => {
    const format = toJsonSchemaResponseFormat(portable, "word_set");
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.name).toBe("word_set");
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema).toEqual(toStrictJsonSchema(portable));
  });
});

describe("toGeminiSchema", () => {
  const compiled = toGeminiSchema(portable);

  it("uses uppercase OpenAPI-flavored type names", () => {
    expect(compiled.type).toBe("OBJECT");
    const props = compiled.properties as Record<string, Record<string, unknown>>;
    expect(props.text?.type).toBe("STRING");
    expect(props.done?.type).toBe("BOOLEAN");
    expect(props.words?.type).toBe("ARRAY");
    const items = props.words?.items as { type?: string; properties?: Record<string, { type?: string }> };
    expect(items.type).toBe("OBJECT");
    expect(items.properties?.count?.type).toBe("INTEGER");
  });

  it("expresses nullability as a nullable flag", () => {
    const props = compiled.properties as Record<string, Record<string, unknown>>;
    expect(props.translation).toEqual({ type: "STRING", nullable: true });
  });

  it("lists all fields as required", () => {
    expect(compiled.required).toEqual(["text", "translation", "words", "level", "done"]);
  });

  it("keeps enums and descriptions", () => {
    const props = compiled.properties as Record<string, Record<string, unknown>>;
    expect(props.level).toEqual({ type: "STRING", enum: ["a1", "b1"] });
    expect(props.text).toEqual({ type: "STRING", description: "The generated text" });
  });
});
