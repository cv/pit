import { type Static, Type } from "typebox";

import { CLOSED, shapeGuard } from "../shared/shape-guard.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";

const ProcessResultSchema = Type.Object(
  { stdout: Type.String(), stderr: Type.String(), code: Type.Number(), truncated: Type.Boolean() },
  CLOSED,
);

export type ProcessResult = Static<typeof ProcessResultSchema>;

const isProcessResult = shapeGuard(ProcessResultSchema);

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
  if (!isProcessResult(value)) return;
  return {
    stdout: sanitizeProcessText(value.stdout),
    stderr: sanitizeProcessText(value.stderr),
    code: value.code,
    truncated: value.truncated,
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
