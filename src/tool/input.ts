import { programInputAdmitsString } from "../functions/source.js";

/**
 * Some clients deliver the `params` tool argument as a JSON string. Decode a string that holds a
 * JSON object or array when the program's declared input cannot accept a string; otherwise pass
 * the value through unchanged so validation reports any mismatch against the declared type.
 */
export function resolveToolInput(source: string, params: unknown): unknown {
  if (typeof params !== "string" || programInputAdmitsString(source) !== false) return params;
  const text = params.trim();
  if (!(text.startsWith("{") || text.startsWith("["))) return params;
  try {
    // Text that starts with { or [ can only parse to an object or array.
    return JSON.parse(text) as unknown;
  } catch {
    return params;
  }
}
