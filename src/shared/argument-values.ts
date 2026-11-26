// Embedded as local declarations in command source functions (see functions/command-source.ts),
// which drops imports: keep this module self-contained.

export function recordValue(value: unknown, label = "options"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Rejects keys an options object does not define, so a misspelled or invented option fails
 * instead of being silently ignored. Keys set to `undefined` are treated as absent.
 */
export function knownKeysValue(
  value: Record<string, unknown>,
  label: string,
  keys: readonly string[],
  hints: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  const unknown = Object.keys(value).filter(
    (key) => value[key] !== undefined && !keys.includes(key),
  );
  if (unknown.length > 0) {
    const hint = unknown.map((key) => hints[key]).find((text) => text !== undefined);
    throw new Error(
      `${label} has unknown ${unknown.length === 1 ? "key" : "keys"} ${unknown
        .map((key) => JSON.stringify(key))
        .join(", ")}; expected ${keys.join(", ")}${hint === undefined ? "" : `. ${hint}`}`,
    );
  }
  return value;
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

export function stringArrayValue(value: unknown, label: string): string[] {
  if (!(Array.isArray(value) && value.every((entry) => typeof entry === "string"))) {
    throw new TypeError(`${label} must be an array of strings`);
  }
  return value;
}

export function boundedIntegerValue(
  value: unknown,
  label: string,
  { minimum = 1, maximum, fallback }: { minimum?: number; maximum: number; fallback: number },
): number {
  const resolved = Number(value ?? fallback);
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}
