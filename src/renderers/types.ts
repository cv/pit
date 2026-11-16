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
  /** The skills of returned reads, recorded by file when the call finished. */
  skillFiles?: Readonly<Record<string, SkillFile>>;
}

/** The skill a returned read's file belongs to, as the tool recorded it. */
export interface SkillFile {
  name: string;
  kind: "skill" | "reference";
  /** A reference's path relative to its skill's directory. */
  reference?: string;
}

/** A returned read of a skill's file: what the transcript shows in Pi's `[skill] name` style. */
export interface SkillMention extends SkillFile {
  /** Line spans the read returned. */
  spans: Array<[number, number]>;
  totalLines: number;
  /** The read's range and flags, as its `Read` headline shows them after the file. */
  detail: string;
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
  /** Skill files this value returned the reads of, in order, for `[skill]` rows. */
  skills?: SkillMention[];
}

export type ValueRenderer = (
  value: unknown,
  context: RenderContext,
) => RenderedResultValue | undefined;
