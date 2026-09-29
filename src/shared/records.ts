/** A record of JSON-like fields, as any parsed JSON object is at runtime. */
export type JsonRecord = Record<string, unknown>;

/** A non-null, non-array object: how any JSON object looks at runtime. For walking unknown values. */
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
