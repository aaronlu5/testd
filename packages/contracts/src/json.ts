export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A JSON Schema document (draft-07 compatible subset used by Ajv). */
export type JsonSchema = { [keyword: string]: unknown };

/** Dot-separated path with optional `*` wildcard segments, e.g. `headers.Authorization`. */
export type JsonPath = string;
