import type { CapabilityCall } from "./capability-core.js";

export type { ResultRendererKey } from "./capability-core.js";

export interface ResultTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface RenderContext {
  theme: ResultTheme;
  seen: WeakSet<object>;
  depth: number;
  syntaxLanguage?: string;
  /** The first statically identifiable capability call in submitted source. */
  capabilityCall?: CapabilityCall;
}

export interface RenderedResultValue {
  kind: string;
  lines: string[];
  summary?: string;
  outcome?: "success" | "warning" | "error";
  detailLines?: string[];
  hangingIndents?: Record<number, number>;
  detailHangingIndents?: Record<number, number>;
}

export type ValueRenderer = (
  value: unknown,
  context: RenderContext,
) => RenderedResultValue | undefined;
