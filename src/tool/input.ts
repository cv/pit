import { programInputAdmitsString } from "../functions/source.js";

/**
 * Some clients deliver the `params` tool argument as a JSON string. Decode a string that holds a
 * JSON object or array when the program's declared input cannot accept a string; otherwise pass
 * the value through unchanged so validation reports any mismatch against the declared type. A
 * string that is itself a JSON string literal ("line\\nline") is decoded for every input.
 */
export function resolveToolInput(source: string, params: unknown): unknown {
  if (typeof params !== "string") return params;
  const text = params.trim();
  // A string sent JSON-encoded, quotes and \n escapes included, is never meant literally.
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      const decoded = JSON.parse(text) as unknown;
      if (typeof decoded === "string") return decoded;
    } catch {
      // Not a JSON string: keep it.
    }
  }
  if (programInputAdmitsString(source) !== false) return params;
  if (!(text.startsWith("{") || text.startsWith("["))) return params;
  try {
    // Text that starts with { or [ can only parse to an object or array.
    return JSON.parse(text) as unknown;
  } catch {
    return params;
  }
}

const OPTIONAL_ARGUMENTS = ["label", "functionId", "params", "saveOnly", "timeoutMs"] as const;

/**
 * Treats a `null` optional tool argument as omitted. A provider sampling arguments against a strict
 * JSON schema must send every property, so it sends `null` for options the model left out. Pi drops
 * such a `null` only where the property's schema rejects it, which excludes `params`. `code` is
 * required, so a `null` there is left for validation to report.
 */
export function omitNullArguments<T>(args: T): T {
  if (typeof args !== "object" || args === null) return args;
  const record = args as Record<string, unknown>;
  if (!OPTIONAL_ARGUMENTS.some((name) => record[name] === null)) return args;
  const result = { ...record };
  for (const name of OPTIONAL_ARGUMENTS) {
    if (result[name] === null) delete result[name];
  }
  return result as T;
}
