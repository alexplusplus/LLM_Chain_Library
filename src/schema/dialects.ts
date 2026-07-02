import type { PortableSchema } from "./portable.js";

/**
 * Compile the portable schema to strict JSON Schema — the dialect OpenAI's
 * `json_schema` response format enforces, also used verbatim by OpenRouter.
 *
 * Strict-mode rules applied here:
 * - every object gets `additionalProperties: false`
 * - every property is listed in `required` (the portable subset guarantees
 *   this is sound — optionals were rejected at compile time)
 * - nullability is expressed as `anyOf: [T, { type: "null" }]`
 */
export function toStrictJsonSchema(schema: PortableSchema): Record<string, unknown> {
  const base = strictNode(schema);
  return schema.nullable ? nullableWrap(base, schema.description) : base;
}

function strictNode(schema: PortableSchema): Record<string, unknown> {
  const description = schema.description !== undefined ? { description: schema.description } : {};
  switch (schema.kind) {
    case "object": {
      const properties: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(schema.properties)) {
        properties[key] = toStrictJsonSchema(child);
      }
      return {
        type: "object",
        properties,
        required: Object.keys(schema.properties),
        additionalProperties: false,
        ...description,
      };
    }
    case "array":
      return { type: "array", items: toStrictJsonSchema(schema.items), ...description };
    case "string":
      return { type: "string", ...description };
    case "number":
      return { type: schema.integer ? "integer" : "number", ...description };
    case "boolean":
      return { type: "boolean", ...description };
    case "enum":
      return { type: "string", enum: [...schema.values], ...description };
  }
}

function nullableWrap(
  node: Record<string, unknown>,
  description: string | undefined,
): Record<string, unknown> {
  // Hoist the description onto the wrapper so it survives for providers
  // that only read the top level of an anyOf.
  const { description: _inner, ...rest } = node;
  return {
    anyOf: [rest, { type: "null" }],
    ...(description !== undefined ? { description } : {}),
  };
}

/**
 * The response format object for OpenAI `chat.completions` and for
 * OpenRouter's OpenAI-compatible endpoint.
 */
export function toJsonSchemaResponseFormat(
  schema: PortableSchema,
  name: string,
): {
  type: "json_schema";
  json_schema: { name: string; strict: true; schema: Record<string, unknown> };
} {
  return {
    type: "json_schema",
    json_schema: { name, strict: true, schema: toStrictJsonSchema(schema) },
  };
}

/**
 * Gemini `responseSchema` dialect: OpenAPI-flavored, uppercase type names,
 * nullability as a `nullable: true` flag instead of a null union.
 */
export function toGeminiSchema(schema: PortableSchema): Record<string, unknown> {
  const nullable = schema.nullable ? { nullable: true } : {};
  const description = schema.description !== undefined ? { description: schema.description } : {};
  switch (schema.kind) {
    case "object": {
      const properties: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(schema.properties)) {
        properties[key] = toGeminiSchema(child);
      }
      return {
        type: "OBJECT",
        properties,
        required: Object.keys(schema.properties),
        ...nullable,
        ...description,
      };
    }
    case "array":
      return { type: "ARRAY", items: toGeminiSchema(schema.items), ...nullable, ...description };
    case "string":
      return { type: "STRING", ...nullable, ...description };
    case "number":
      return { type: schema.integer ? "INTEGER" : "NUMBER", ...nullable, ...description };
    case "boolean":
      return { type: "BOOLEAN", ...nullable, ...description };
    case "enum":
      return { type: "STRING", enum: [...schema.values], ...nullable, ...description };
  }
}
