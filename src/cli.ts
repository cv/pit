export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number;
  truncated: boolean;
}

export type SemanticOutcome = "success" | "warning" | "error";

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
  maximum: number,
  defaultValue: number,
): number {
  const resolved = Number(value ?? defaultValue);
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return resolved;
}

export function parseProcessResult(value: unknown): ProcessResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== 4) {
    return;
  }
  if (
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    typeof result.code !== "number" ||
    typeof result.truncated !== "boolean"
  ) {
    return;
  }
  return result as unknown as ProcessResult;
}

export function nonemptyLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

export interface SemanticOutcomeOptions {
  domainOutcome?: Exclude<SemanticOutcome, "error">;
  acceptedExitCodes?: readonly number[];
}

export function semanticOutcome(
  result: ProcessResult,
  options: SemanticOutcomeOptions = {},
): SemanticOutcome {
  const accepted = result.code === 0 || options.acceptedExitCodes?.includes(result.code) === true;
  if (!accepted) {
    return "error";
  }
  return options.domainOutcome ?? "success";
}
