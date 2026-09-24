import { sanitizeTerminalText } from "../shared/text-sanitization.js";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number;
  truncated: boolean;
}

export type SemanticOutcome = "success" | "warning" | "error";

declare const sanitizedText: unique symbol;

/** Display-safe process text: controls removed, line endings normalized, foreground SGR kept. */
export type SanitizedText = string & { readonly [sanitizedText]: true };

/** A returned process result whose streams were sanitized once for display. */
export interface DisplayProcessResult extends Omit<ProcessResult, "stdout" | "stderr"> {
  stdout: SanitizedText;
  stderr: SanitizedText;
}

export function sanitizeProcessText(value: string): SanitizedText {
  return sanitizeTerminalText(value, { preserveSgr: true }) as SanitizedText;
}

export function parseProcessResult(value: unknown): DisplayProcessResult | undefined {
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
  return {
    stdout: sanitizeProcessText(result.stdout),
    stderr: sanitizeProcessText(result.stderr),
    code: result.code,
    truncated: result.truncated,
  };
}

export function processOutputLines(value: SanitizedText): string[] {
  return value.split("\n").filter((line, index, all) => index < all.length - 1 || line !== "");
}

export interface SemanticOutcomeOptions {
  domainOutcome?: Exclude<SemanticOutcome, "error">;
  acceptedExitCodes?: readonly number[];
}

export function semanticOutcome(
  result: Pick<ProcessResult, "code" | "truncated">,
  options: SemanticOutcomeOptions = {},
): SemanticOutcome {
  const accepted = result.code === 0 || options.acceptedExitCodes?.includes(result.code) === true;
  if (!accepted) {
    return "error";
  }
  return options.domainOutcome ?? (result.truncated ? "warning" : "success");
}
