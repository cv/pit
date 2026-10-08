import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import type { RenderedResultValue, ResultTheme } from "./types.js";

export const MAX_RECURSIVE_DEPTH = 4;
const JSON_CONTAINER_PREFIX = /^\s*[[{]/;
const HASHED_LINE_PATTERN = /^(\d+:[^|]+\|)(.*)$/;

export function indent(lines: string[], prefix = "  "): string[] {
  return lines.map((line) => `${prefix}${line}`);
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** What an elide changed: tool results, tool calls (assistant entries whose arguments it stubbed), or both. */
export function elidedTargets(targets: number, toolCallEntries = 0): string {
  const calls = Math.min(Math.max(0, toolCallEntries), targets);
  const results = targets - calls;
  if (calls === 0) return plural(results, "tool result");
  if (results === 0) return plural(calls, "tool call");
  return `${plural(results, "tool result")} and ${plural(calls, "tool call")}`;
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
// oxlint-disable-next-line no-control-regex
const SGR_SEQUENCE = /\u001b\[([0-9;]*)m/g;

type OpenStyle = "fg" | "bg" | "intensity" | "italic" | "underline" | "inverse" | "strike";

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** The style each SGR parameter opens. 38 and 48 take extended-color parameters. */
const OPENED = new Map<number, OpenStyle>([
  ...[1, 2].map((code) => [code, "intensity"] as const),
  [3, "italic"],
  [4, "underline"],
  [7, "inverse"],
  [9, "strike"],
  ...[...range(30, 38), ...range(90, 97)].map((code) => [code, "fg"] as const),
  ...[...range(40, 48), ...range(100, 107)].map((code) => [code, "bg"] as const),
]);
/** The reset for each style, which is also the parameter that closes it. */
const RESET: Record<OpenStyle, number> = {
  fg: 39,
  bg: 49,
  intensity: 22,
  italic: 23,
  underline: 24,
  inverse: 27,
  strike: 29,
};
const CLOSED = new Map(Object.entries(RESET).map(([style, code]) => [code, style as OpenStyle]));

/**
 * Closes the styles a highlighted line leaves open, such as a block comment's color that
 * continues onto the next line. pi-tui 1.x carries an open style into the next row ahead of its
 * line prefix and then drops the style the line reopens after the prefix, which left later lines
 * of a multi-line token unhighlighted. Only the open styles are reset, so a surrounding
 * background survives.
 */
export function closeOpenStyles(line: string): string {
  const open = new Set<OpenStyle>();
  for (const match of line.matchAll(SGR_SEQUENCE)) {
    // An empty parameter, as in ESC[m, means 0: reset everything.
    const codes = (match[1] as string).split(";").map(Number);
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index] as number;
      if (code === 0) open.clear();
      const closed = CLOSED.get(code);
      if (closed) open.delete(closed);
      const opened = OPENED.get(code);
      if (opened) open.add(opened);
      // Skip an extended color's own parameters: 38;5;n or 38;2;r;g;b.
      if (code === 38 || code === 48) index += codes[index + 1] === 5 ? 2 : 4;
    }
  }
  if (open.size === 0) return line;
  return `${line}\u001b[${[...open].map((style) => RESET[style]).join(";")}m`;
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
    const highlightedContent = closeOpenStyles(highlighted[index] ?? line.content);
    if (line.prefix === undefined) {
      return highlightedContent;
    }
    hangingIndents[index] = line.prefix.length;
    return `${theme.fg("dim", line.prefix)}${highlightedContent}`;
  });
  return { lines, hangingIndents };
}
