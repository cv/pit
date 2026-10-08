import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { CLOSED, shapeGuard } from "../shared/shape-guard.js";
import {
  languageForFile,
  offsetHangingIndents,
  outcomeMarker,
  plural,
  renderHashedFile,
} from "./shared.js";
import type { RenderContext, RenderedResultValue } from "./types.js";

const isReadResult = shapeGuard(
  Type.Object(
    {
      file: Type.String(),
      format: Type.Union([Type.Literal("hashed"), Type.Literal("raw")]),
      content: Type.String(),
      revision: Type.String(),
      lines: Type.Number(),
      offset: Type.Optional(Type.Number()),
      totalLines: Type.Optional(Type.Number()),
      hasMore: Type.Optional(Type.Literal(true)),
      truncated: Type.Optional(Type.Literal(true)),
    },
    CLOSED,
  ),
);

const isRangeReadResult = shapeGuard(
  Type.Object(
    {
      file: Type.String(),
      format: Type.Literal("hashed"),
      revision: Type.String(),
      ranges: Type.Array(
        Type.Object({ start: Type.Number(), end: Type.Number(), content: Type.String() }, CLOSED),
      ),
      lines: Type.Number(),
      totalLines: Type.Number(),
      truncated: Type.Optional(Type.Literal(true)),
    },
    CLOSED,
  ),
);

const SearchContextLine = Type.Object(
  { line: Type.Number(), anchor: Type.String(), text: Type.String() },
  CLOSED,
);

const isSearchResult = shapeGuard(
  Type.Object(
    {
      matches: Type.Array(
        Type.Object(
          {
            file: Type.String(),
            revision: Type.String(),
            line: Type.Number(),
            anchor: Type.String(),
            column: Type.Number(),
            text: Type.String(),
            before: Type.Array(SearchContextLine),
            after: Type.Array(SearchContextLine),
          },
          CLOSED,
        ),
      ),
      truncated: Type.Boolean(),
      filesSearched: Type.Number(),
      filesSkipped: Type.Number(),
      hint: Type.Optional(Type.String()),
    },
    CLOSED,
  ),
);

const isEditResult = shapeGuard(
  Type.Object(
    {
      file: Type.String(),
      revision: Type.Union([Type.String(), Type.Null()]),
      applied: Type.Number(),
      bytes: Type.Number(),
      deleted: Type.Boolean(),
    },
    CLOSED,
  ),
);

const isWorkspaceList = shapeGuard(
  Type.Array(
    Type.Object(
      {
        name: Type.String(),
        type: Type.Union([
          Type.Literal("file"),
          Type.Literal("directory"),
          Type.Literal("symlink"),
        ]),
      },
      CLOSED,
    ),
    { minItems: 1 },
  ),
);

const isGlobResult = shapeGuard(
  Type.Object({ entries: Type.Array(Type.String()), truncated: Type.Boolean() }, CLOSED),
);

const isStatResult = shapeGuard(
  Type.Object(
    {
      size: Type.Number(),
      modified: Type.String(),
      directory: Type.Boolean(),
      file: Type.Boolean(),
    },
    CLOSED,
  ),
);

type RangeRead = typeof isRangeReadResult extends ((value: unknown) => value is infer T)
  ? T
  : never;

/** A read of several line ranges: each is shown like a hashed read, with a gap marker between. */
function renderRangeRead(value: RangeRead, { theme, details }: RenderContext): RenderedResultValue {
  const spans = value.ranges.map(({ start, end }) =>
    start === end ? `${start}` : `${start}-${end}`,
  );
  const where =
    spans.length === 0 ? "no lines" : `lines ${spans.join(", ")} of ${value.totalLines}`;
  const flags = value.truncated ? "hashed, truncated" : "hashed";
  const summary = `${value.file}, ${where}, ${flags}`;
  const outcome = value.truncated ? "warning" : "success";
  if (details === false) return { kind: "read", summary, outcome, lines: [] };
  const lines = [
    `${theme.fg("toolTitle", theme.bold(value.file))} ${theme.fg("dim", `(${where}; ${flags}; rev ${value.revision})`)}`,
  ];
  const indents: Record<number, number> = {};
  value.ranges.forEach((range, index) => {
    if (index > 0) lines.push(theme.fg("dim", "…"));
    const rendered = renderHashedFile(range.content, value.file, theme, value.totalLines);
    Object.assign(
      indents,
      offsetHangingIndents(rendered.hangingIndents, { lines: lines.length - 1 }),
    );
    lines.push(...rendered.lines);
  });
  return {
    kind: "read",
    outcome,
    lines,
    summary,
    detailLines: [theme.fg("dim", `revision: ${value.revision}`), ...lines.slice(1)],
    hangingIndents: offsetHangingIndents(indents, { lines: 1 }),
    detailHangingIndents: offsetHangingIndents(indents, { lines: 1 }),
  };
}

export function renderRead(
  value: unknown,
  context: RenderContext,
): RenderedResultValue | undefined {
  if (isRangeReadResult(value)) return renderRangeRead(value, context);
  if (!isReadResult(value)) return undefined;
  const { theme, details } = context;

  const offset = value.offset ?? 1;
  const total = value.totalLines ?? value.lines;
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

export function renderSearch(
  value: unknown,
  { theme }: RenderContext,
): RenderedResultValue | undefined {
  if (!isSearchResult(value)) return undefined;

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
  if (value.hint !== undefined) lines.push(theme.fg("warning", value.hint));
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
  if (!isEditResult(value)) return undefined;

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
  if (!isWorkspaceList(value)) return undefined;

  const marker = { file: "f", directory: "d", symlink: "l" } as const;
  const entryLines = value.map(
    (entry) => `${theme.fg("dim", `[${marker[entry.type]}]`)} ${entry.name}`,
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
  if (!isGlobResult(value)) return undefined;

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
  if (!isStatResult(value)) return undefined;
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
