import { z } from "zod";
import { InvalidRequestError } from "../errors.js";

/**
 * The portable schema subset — the intersection of what all supported
 * provider dialects (Gemini `responseSchema`, OpenAI strict `json_schema`,
 * OpenRouter `response_format`) can natively enforce:
 *
 * - objects (all fields required; use `.nullable()` instead of `.optional()`)
 * - strings, numbers/integers, booleans
 * - string enums (and string literals, treated as single-value enums)
 * - arrays
 * - `.nullable()` on any of the above
 *
 * Anything outside the subset is rejected at call time with
 * {@link InvalidRequestError} — the loud-failure path: a schema that one
 * provider cannot enforce must not silently fall through to paid entries.
 */
export type PortableSchema =
  | PortableObject
  | PortableArray
  | PortableString
  | PortableNumber
  | PortableBoolean
  | PortableEnum;

interface PortableBase {
  nullable?: boolean;
  description?: string;
}

export interface PortableObject extends PortableBase {
  kind: "object";
  properties: Record<string, PortableSchema>;
}

export interface PortableArray extends PortableBase {
  kind: "array";
  items: PortableSchema;
}

export interface PortableString extends PortableBase {
  kind: "string";
}

export interface PortableNumber extends PortableBase {
  kind: "number";
  integer?: boolean;
}

export interface PortableBoolean extends PortableBase {
  kind: "boolean";
}

export interface PortableEnum extends PortableBase {
  kind: "enum";
  values: string[];
}

/**
 * Compile a zod schema to the portable subset.
 *
 * Goes through zod's own `z.toJSONSchema()` (stable public API) rather than
 * walking zod internals, then normalizes the JSON Schema into
 * {@link PortableSchema}. Throws {@link InvalidRequestError} naming the
 * offending path when the schema falls outside the subset.
 */
export function zodToPortable(schema: z.ZodType): PortableObject {
  let json: unknown;
  try {
    json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" });
  } catch (cause) {
    throw new InvalidRequestError(
      `Schema could not be converted to JSON Schema: ${messageOf(cause)}`,
      { cause },
    );
  }
  const portable = normalize(json, "$");
  if (portable.kind !== "object") {
    throw new InvalidRequestError(
      `Root schema must be an object (all providers require an object root), got "${portable.kind}"`,
    );
  }
  return portable;
}

function normalize(node: unknown, path: string): PortableSchema {
  if (typeof node !== "object" || node === null) {
    reject(path, "schema node is not an object");
  }
  const n = node as Record<string, unknown>;

  if (n.$ref !== undefined) {
    reject(path, "recursive/referenced schemas ($ref) are not in the portable subset");
  }

  // Nullable encodings: `anyOf`/`oneOf` of [T, null] or `type: [T, "null"]`.
  const variants = (n.anyOf ?? n.oneOf) as unknown[] | undefined;
  if (Array.isArray(variants)) {
    const nullIdx = variants.findIndex(
      (v) => typeof v === "object" && v !== null && (v as { type?: unknown }).type === "null",
    );
    if (variants.length === 2 && nullIdx !== -1) {
      const inner = normalize(variants[1 - nullIdx], path);
      return { ...inner, nullable: true, ...descriptionOf(n) };
    }
    reject(path, "unions are not in the portable subset (only `.nullable()` is supported)");
  }

  let type = n.type;
  let nullable = false;
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== "null");
    if (nonNull.length === 1 && type.length === 2) {
      type = nonNull[0];
      nullable = true;
    } else {
      reject(path, `multi-type schemas are not in the portable subset (got ${JSON.stringify(n.type)})`);
    }
  }

  const base = { ...(nullable ? { nullable } : {}), ...descriptionOf(n) };

  switch (type) {
    case "object": {
      // Records/maps compile to an object whose `additionalProperties` is a
      // schema (arbitrary keys). Strict dialects cannot enforce that.
      const additional = n.additionalProperties;
      if (
        typeof additional === "object" &&
        additional !== null &&
        Object.keys(additional).length > 0 &&
        // `{ not: {} }` is JSON Schema for "no additional properties" — fine.
        JSON.stringify(additional) !== '{"not":{}}'
      ) {
        reject(path, "records/maps with arbitrary keys are not in the portable subset");
      }
      const props = (n.properties ?? {}) as Record<string, unknown>;
      const required = new Set((n.required as string[] | undefined) ?? []);
      const properties: Record<string, PortableSchema> = {};
      for (const [key, child] of Object.entries(props)) {
        if (!required.has(key)) {
          reject(
            `${path}.${key}`,
            "optional fields are not in the portable subset (OpenAI strict mode requires every field); use `.nullable()` instead of `.optional()`",
          );
        }
        properties[key] = normalize(child, `${path}.${key}`);
      }
      return { kind: "object", properties, ...base };
    }
    case "array": {
      if (n.items === undefined) {
        reject(path, "arrays must declare an item schema");
      }
      return { kind: "array", items: normalize(n.items, `${path}[]`), ...base };
    }
    case "string": {
      if (Array.isArray(n.enum)) {
        return { kind: "enum", values: stringEnumValues(n.enum, path), ...base };
      }
      if (n.const !== undefined) {
        if (typeof n.const !== "string") {
          reject(path, "only string literals are in the portable subset");
        }
        return { kind: "enum", values: [n.const], ...base };
      }
      return { kind: "string", ...base };
    }
    case "number":
      return { kind: "number", ...base };
    case "integer":
      return { kind: "number", integer: true, ...base };
    case "boolean":
      return { kind: "boolean", ...base };
    default: {
      // Bare enum without a type keyword (e.g. from a native enum).
      if (Array.isArray(n.enum)) {
        return { kind: "enum", values: stringEnumValues(n.enum, path), ...base };
      }
      reject(
        path,
        `type ${JSON.stringify(type ?? "unknown")} is not in the portable subset (objects, arrays, strings, numbers, booleans, string enums)`,
      );
    }
  }
}

function stringEnumValues(values: unknown[], path: string): string[] {
  if (!values.every((v): v is string => typeof v === "string")) {
    reject(path, "only string enums are in the portable subset");
  }
  return values;
}

function descriptionOf(n: Record<string, unknown>): { description?: string } {
  return typeof n.description === "string" ? { description: n.description } : {};
}

function reject(path: string, why: string): never {
  throw new InvalidRequestError(`Unsupported schema at ${path}: ${why}`);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
