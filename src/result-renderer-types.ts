import type { CapabilityCall } from "./capability-presentation.js";

export type ResultRendererKey =
  | "read"
  | "edit"
  | "batch"
  | "list"
  | "glob"
  | "search"
  | "stat"
  | "shell"
  | "http"
  | "gh"
  | "git.status"
  | "git.diff"
  | "git.log"
  | "git.add"
  | "git.commit"
  | "git.show"
  | "git.push"
  | "git.tag"
  | "npm.run"
  | "npm.test"
  | "npm.install"
  | "npm.audit"
  | "npm.outdated"
  | "npm.pack";

export interface ResultTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface RenderContext {
  theme: ResultTheme;
  seen: WeakSet<object>;
  depth: number;
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
