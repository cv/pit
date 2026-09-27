import type { FunctionCall } from "../functions/call.js";

export type { ResultRendererKey } from "../functions/global-definition.js";

export interface ResultTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface RenderContext {
  theme: ResultTheme;
  seen: WeakSet<object>;
  depth: number;
  syntaxLanguage?: string;
  /** False for summary-only rendering; domain outcomes must still be evaluated. */
  details?: boolean;
  /** The first statically identifiable host call in submitted source. */
  functionCall?: FunctionCall;
}

export interface RenderedResultValue {
  kind: string;
  lines: string[];
  summary?: string;
  /** Domain outcome, propagated through compound results independently of invocation success. */
  outcome?: "success" | "warning" | "error";
  /** Body paired with summary: retain every display-safe field not represented by the summary. */
  detailLines?: string[];
  hangingIndents?: Record<number, number>;
  detailHangingIndents?: Record<number, number>;
}

export type ValueRenderer = (
  value: unknown,
  context: RenderContext,
) => RenderedResultValue | undefined;
