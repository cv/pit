export function recordValue(value: unknown, label = "options"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
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
