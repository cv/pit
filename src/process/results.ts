import { sanitizeTerminalText } from "../shared/text-sanitization.js";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number;
  truncated: boolean;
}

export type SemanticOutcome = "success" | "warning" | "error";

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

export function processOutputLines(value: string): string[] {
  return sanitizeTerminalText(value, { preserveSgr: true })
    .split("\n")
    .filter((line, index, all) => index < all.length - 1 || line !== "");
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
  return options.domainOutcome ?? (result.truncated ? "warning" : "success");
}
