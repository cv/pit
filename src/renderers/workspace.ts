import { highlightCode } from "@earendil-works/pi-coding-agent";

import {
  hasOnlyKeys,
  isRecord,
  languageForFile,
  offsetHangingIndents,
  outcomeMarker,
  plural,
  renderHashedFile,
} from "./shared.js";
import type { RenderContext, RenderedResultValue } from "./types.js";

export function renderRead(
  value: unknown,
  { theme, details }: RenderContext,
): RenderedResultValue | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      ["file", "format", "content", "revision", "lines"],
      ["offset", "totalLines", "hasMore", "truncated"],
    ) ||
    typeof value.file !== "string" ||
    (value.format !== "hashed" && value.format !== "raw") ||
    typeof value.content !== "string" ||
    typeof value.revision !== "string" ||
    typeof value.lines !== "number" ||
    (value.offset !== undefined && typeof value.offset !== "number") ||
    (value.totalLines !== undefined && typeof value.totalLines !== "number") ||
    (value.hasMore !== undefined && value.hasMore !== true) ||
    (value.truncated !== undefined && value.truncated !== true)
  ) {
    return undefined;
  }

  const offset = typeof value.offset === "number" ? value.offset : 1;
  const total = typeof value.totalLines === "number" ? value.totalLines : value.lines;
  const range = value.lines === 0 ? "empty" : `${offset}-${offset + value.lines - 1} of ${total}`;
  const flags = [
    value.format,
    value.hasMore ? "more available" : "",
    value.truncated ? "truncated" : "",
  ]
    .filter(Boolean)
    .join(", ");
  const summary = `${value.file}, ${range}, ${flags}`;
  const outcome = value.truncated || value.hasMore ? "warning" : "success";
  if (details === false) return { kind: "read", summary, outcome, lines: [] };
  const lines = [
    `${theme.fg("toolTitle", theme.bold(value.file))} ${theme.fg("dim", `(${range}; ${flags}; rev ${value.revision})`)}`,
  ];
  const detailHangingIndents: Record<number, number> = {};
  if (value.content) {
    let contentLines: string[];
    if (value.format === "raw") {
      contentLines = highlightCode(value.content, languageForFile(value.file));
    } else {
      const rendered = renderHashedFile(value.content, value.file, theme, total);
      contentLines = rendered.lines;
      Object.assign(detailHangingIndents, rendered.hangingIndents);
    }
    lines.push(...contentLines);
  } else {
    lines.push(theme.fg("dim", "(empty file)"));
  }
  return {
    kind: "read",
    outcome,
    lines,
    summary,
    detailLines: [theme.fg("dim", `revision: ${value.revision}`), ...lines.slice(1)],
    hangingIndents: offsetHangingIndents(detailHangingIndents, { lines: 1 }),
    detailHangingIndents: offsetHangingIndents(detailHangingIndents, { lines: 1 }),
  };
}

function isSearchContextLine(
  value: unknown,
): value is { line: number; anchor: string; text: string } {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["line", "anchor", "text"]) &&
    typeof value.line === "number" &&
    typeof value.anchor === "string" &&
    typeof value.text === "string"
  );
}

function isSearchMatch(value: unknown): value is {
  file: string;
  revision: string;
  line: number;
  anchor: string;
  column: number;
  text: string;
  before: Array<{ line: number; anchor: string; text: string }>;
  after: Array<{ line: number; anchor: string; text: string }>;
} {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "file",
      "revision",
      "line",
      "anchor",
      "column",
      "text",
      "before",
      "after",
    ]) &&
    typeof value.file === "string" &&
    typeof value.revision === "string" &&
    typeof value.line === "number" &&
    typeof value.anchor === "string" &&
    typeof value.column === "number" &&
    typeof value.text === "string" &&
    Array.isArray(value.before) &&
    value.before.every(isSearchContextLine) &&
    Array.isArray(value.after) &&
    value.after.every(isSearchContextLine)
  );
}

export function renderSearch(
  value: unknown,
  { theme }: RenderContext,
): RenderedResultValue | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["matches", "truncated", "filesSearched", "filesSkipped"], ["hint"]) ||
    !(value.hint === undefined || typeof value.hint === "string") ||
    !Array.isArray(value.matches) ||
    !value.matches.every(isSearchMatch) ||
    typeof value.truncated !== "boolean" ||
    typeof value.filesSearched !== "number" ||
    typeof value.filesSkipped !== "number"
  ) {
    return undefined;
  }

  const summary = [
    plural(value.matches.length, "match", "matches"),
    `${plural(value.filesSearched, "file")} searched`,
    value.filesSkipped > 0 ? `${value.filesSkipped} skipped` : "",
    value.truncated ? "truncated" : "",
    // The collapsed row explains its warning; the full hint is in the expanded lines.
    value.hint !== undefined ? "regex syntax in a literal query" : "",
  ]
    .filter(Boolean)
    .join(", ");
  const lines = [
    `${theme.fg("toolTitle", theme.bold("search"))} ${theme.fg("dim", `(${summary})`)}`,
  ];
  for (const match of value.matches) {
    lines.push(theme.fg("accent", `${match.file}:${match.line}:${match.column} (${match.anchor})`));
    lines.push(theme.fg("dim", `  revision: ${match.revision}`));
    for (const contextLine of match.before) {
      lines.push(theme.fg("dim", `  ${contextLine.anchor}|${contextLine.text}`));
    }
    lines.push(`> ${match.line}  ${match.text}`);
    for (const contextLine of match.after) {
      lines.push(theme.fg("dim", `  ${contextLine.anchor}|${contextLine.text}`));
    }
  }
  if (value.matches.length === 0) {
    lines.push(theme.fg("dim", "(no matches)"));
  }
  // A likely misread query is a warning, not a clean empty result.
  if (typeof value.hint === "string") lines.push(theme.fg("warning", value.hint));
  return {
    kind: "search",
    outcome:
      value.truncated || value.filesSkipped > 0 || value.hint !== undefined ? "warning" : "success",
    lines,
    summary,
    detailLines: lines.slice(1),
  };
}

export function renderEdit(
  value: unknown,
  { theme }: RenderContext,
): RenderedResultValue | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["file", "revision", "applied", "bytes", "deleted"]) ||
    typeof value.file !== "string" ||
    (typeof value.revision !== "string" && value.revision !== null) ||
    typeof value.applied !== "number" ||
    typeof value.bytes !== "number" ||
    typeof value.deleted !== "boolean"
  ) {
    return undefined;
  }

  const action = value.deleted ? "deleted" : "updated";
  const revision = value.revision === null ? "no revision" : `rev ${value.revision}`;
  return {
    kind: "edit",
    lines: [
      `${outcomeMarker(theme, "success")} ${theme.fg("toolTitle", theme.bold(value.file))} ${action} ${theme.fg("dim", `(${plural(value.applied, "change")}, ${value.bytes} bytes, ${revision})`)}`,
    ],
    summary: `${value.file}, ${action}, ${plural(value.applied, "change")}, ${value.bytes} bytes`,
    detailLines: [theme.fg("dim", revision)],
  };
}

export function renderWorkspaceList(
  value: unknown,
  { theme }: RenderContext,
): RenderedResultValue | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (entry) =>
        isRecord(entry) &&
        hasOnlyKeys(entry, ["name", "type"]) &&
        typeof entry.name === "string" &&
        (entry.type === "file" || entry.type === "directory" || entry.type === "symlink"),
    )
  ) {
    return undefined;
  }

  const marker = { file: "f", directory: "d", symlink: "l" } as const;
  const entryLines = value.map(
    (entry) => `${theme.fg("dim", `[${marker[entry.type as keyof typeof marker]}]`)} ${entry.name}`,
  );
  return {
    kind: "list",
    lines: [
      `${theme.fg("toolTitle", theme.bold("workspace"))} ${theme.fg("dim", `(${plural(value.length, "entry", "entries")})`)}`,
      ...entryLines,
    ],
    summary: plural(value.length, "entry", "entries"),
    detailLines: entryLines,
  };
}

export function renderGlob(
  value: unknown,
  { theme }: RenderContext,
): RenderedResultValue | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["entries", "truncated"]) ||
    !Array.isArray(value.entries) ||
    !value.entries.every((entry) => typeof entry === "string") ||
    typeof value.truncated !== "boolean"
  ) {
    return undefined;
  }

  const state = `${plural(value.entries.length, "entry", "entries")}${value.truncated ? ", truncated" : ""}`;
  const entryLines = value.entries.length > 0 ? value.entries : [theme.fg("dim", "(no entries)")];
  return {
    kind: "glob",
    outcome: value.truncated ? "warning" : "success",
    lines: [
      `${theme.fg("toolTitle", theme.bold("glob"))} ${theme.fg(value.truncated ? "warning" : "dim", `(${state})`)}`,
      ...entryLines,
    ],
    summary: state,
    detailLines: entryLines,
  };
}
export function renderStat(
  value: unknown,
  { theme }: RenderContext,
): RenderedResultValue | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["size", "modified", "directory", "file"]) ||
    typeof value.size !== "number" ||
    typeof value.modified !== "string" ||
    typeof value.directory !== "boolean" ||
    typeof value.file !== "boolean"
  ) {
    return undefined;
  }
  const kind = value.directory ? "directory" : value.file ? "file" : "other";
  return {
    kind: "stat",
    lines: [
      `${theme.fg("toolTitle", theme.bold("stat"))} ${kind} ${theme.fg("dim", `(${value.size} bytes, modified ${value.modified})`)}`,
    ],
    summary: `${kind}, ${value.size} bytes`,
    detailLines: [`modified: ${value.modified}`],
  };
}
