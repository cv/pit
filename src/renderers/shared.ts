import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import type { RenderedResultValue, ResultTheme } from "./types.js";

export type JsonRecord = Record<string, unknown>;

export const MAX_RECURSIVE_DEPTH = 4;
const JSON_CONTAINER_PREFIX = /^\s*[[{]/;
const HASHED_LINE_PATTERN = /^(\d+:[^|]+\|)(.*)$/;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(
  value: JsonRecord,
  required: string[],
  optional: string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  );
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

export function indent(lines: string[], prefix = "  "): string[] {
  return lines.map((line) => `${prefix}${line}`);
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

type Outcome = NonNullable<RenderedResultValue["outcome"]>;

const OUTCOME_MARKERS: Readonly<Record<Outcome, string>> = {
  success: "✓",
  warning: "⚠",
  error: "✗",
};

/** The colored glyph for a semantic outcome, shared by result headers, batch entries, and dashboards. */
export function outcomeMarker(theme: Pick<ResultTheme, "fg">, outcome: Outcome): string {
  return theme.fg(outcome, OUTCOME_MARKERS[outcome]);
}

/**
 * Moves nested hanging indents into an enclosing view: source line N becomes line N + `lines`, and
 * each width grows by `columns`. `before` keeps only source lines shown in a prefix of the view.
 */
export function offsetHangingIndents(
  indents: Readonly<Record<number, number>> | undefined,
  {
    lines = 0,
    columns = 0,
    before = Number.POSITIVE_INFINITY,
  }: { lines?: number; columns?: number; before?: number },
): Record<number, number> {
  const shifted: Record<number, number> = {};
  for (const [line, width] of Object.entries(indents ?? {})) {
    if (Number(line) < before) {
      shifted[lines + Number(line)] = width + columns;
    }
  }
  return shifted;
}

export function combinedOutcome(
  values: Array<RenderedResultValue | undefined>,
): NonNullable<RenderedResultValue["outcome"]> {
  if (values.some((value) => value?.outcome === "error")) return "error";
  return values.some((value) => value?.outcome === "warning") ? "warning" : "success";
}

/**
 * Parses JSON only from complete text; `undefined` means the text must stay literal.
 * `requireContainer` limits structured views to objects and arrays so scalar output stays text.
 */
export function parseCompleteJson(
  text: string,
  { truncated, requireContainer = false }: { truncated: boolean; requireContainer?: boolean },
): unknown {
  if (truncated || (requireContainer && !JSON_CONTAINER_PREFIX.test(text))) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function renderJson(value: unknown): string[] {
  let source: string;
  try {
    source = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    source = String(value);
  }
  try {
    return highlightCode(source, "json");
  } catch {
    return sanitizeTerminalText(source).split("\n");
  }
}

const FILE_LANGUAGE_OVERRIDES: Readonly<Record<string, string>> = {
  diff: "diff",
  patch: "diff",
};
const LANGUAGE_HINT_ALIASES: Readonly<Record<string, string>> = {
  patch: "diff",
  shell: "bash",
};

export function syntaxLanguageForHint(hint: string): string | undefined {
  const normalized = hint.trim().toLowerCase();
  if (!normalized) {
    return;
  }
  return (
    LANGUAGE_HINT_ALIASES[normalized] ?? getLanguageFromPath(`file.${normalized}`) ?? normalized
  );
}

export function languageForFile(file: string): string {
  const extension = file.toLowerCase().split(".").pop() ?? "";
  return FILE_LANGUAGE_OVERRIDES[extension] ?? getLanguageFromPath(file) ?? "text";
}
export function renderHashedFile(
  content: string,
  file: string,
  theme: ResultTheme,
  maxLineNumber: number,
): { lines: string[]; hangingIndents: Record<number, number> } {
  const lineNumberWidth = String(maxLineNumber).length;
  const parsed = content.split("\n").map((line) => {
    const match = line.match(HASHED_LINE_PATTERN);
    if (!match) {
      return { prefix: undefined, content: line };
    }
    const prefix = match[1] as string;
    const separator = prefix.indexOf(":");
    return {
      prefix: `${prefix.slice(0, separator).padStart(lineNumberWidth)}${prefix.slice(separator)}`,
      content: match[2] as string,
    };
  });
  const highlightedSource = highlightCode(
    parsed.map((line) => line.content).join("\n"),
    languageForFile(file),
  ).join("\n");
  const highlighted = wrapTextWithAnsi(
    highlightedSource,
    Math.max(1, ...parsed.map((line) => visibleWidth(line.content))),
  );
  const hangingIndents: Record<number, number> = {};
  const lines = parsed.map((line, index) => {
    const highlightedContent = highlighted[index] ?? line.content;
    if (line.prefix === undefined) {
      return highlightedContent;
    }
    hangingIndents[index] = line.prefix.length;
    return `${theme.fg("dim", line.prefix)}${highlightedContent}`;
  });
  return { lines, hangingIndents };
}
