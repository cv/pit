import { highlightCode } from "@earendil-works/pi-coding-agent";
import type { RenderContext, RenderedResultValue } from "../result-renderer-types.js";
import { sanitizeTerminalText } from "../text-sanitization.js";
import {
  indent,
  isRecord,
  type JsonRecord,
  languageForFile,
  MAX_RECURSIVE_DEPTH,
  plural,
  renderJson,
  syntaxLanguageForHint,
} from "./shared.js";

type NestedRenderer = (value: unknown, context: RenderContext) => RenderedResultValue | undefined;

export function renderMultilineText(
  value: unknown,
  context: RenderContext,
): RenderedResultValue | undefined {
  if (typeof value !== "string" || !(value.includes("\n") || value.includes("\r"))) {
    return;
  }
  const source = sanitizeTerminalText(value.replace(/\r\n?/g, "\n"), { preserveSgr: true });
  const lines =
    context.syntaxLanguage && !source.includes("\u001b[")
      ? highlightCode(source, context.syntaxLanguage)
      : source.split("\n");
  return {
    kind: context.syntaxLanguage ?? "text",
    lines,
    summary: plural(lines.length, "line"),
    detailLines: lines,
  };
}

function safeSectionLabel(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/g, " ").trim() || "(unnamed)";
}

const FIELD_LANGUAGES = new Map([
  ["diff", "diff"],
  ["markdown", "markdown"],
  ["md", "markdown"],
  ["patch", "diff"],
]);
const NON_SYNTAX_FORMATS = new Set(["hashed", "raw"]);

function recordSyntaxLanguage(value: JsonRecord): string | undefined {
  for (const key of ["language", "lang", "format"] as const) {
    const hint = value[key];
    if (typeof hint === "string") {
      if (key === "format" && NON_SYNTAX_FORMATS.has(hint.toLowerCase())) {
        continue;
      }
      const language = syntaxLanguageForHint(hint);
      if (language) {
        return language;
      }
    }
  }
  if (typeof value.file === "string") {
    const language = languageForFile(value.file);
    return language === "text" ? undefined : language;
  }
}

function fieldSyntaxLanguage(
  key: string,
  recordLanguage: RenderContext["syntaxLanguage"],
): RenderContext["syntaxLanguage"] {
  return FIELD_LANGUAGES.get(key.toLowerCase()) ?? recordLanguage;
}

export function renderCompound(
  value: unknown,
  context: RenderContext,
  renderNested: NestedRenderer,
): RenderedResultValue | undefined {
  if (!isRecord(value) || context.depth >= MAX_RECURSIVE_DEPTH || context.seen.has(value)) {
    return;
  }
  context.seen.add(value);

  const recognized: Array<[string, RenderedResultValue]> = [];
  const remaining: JsonRecord = {};
  const recordLanguage = recordSyntaxLanguage(value) ?? context.syntaxLanguage;
  for (const [key, entry] of Object.entries(value)) {
    const syntaxLanguage = fieldSyntaxLanguage(key, recordLanguage);
    const rendered = renderNested(entry, {
      ...context,
      depth: context.depth + 1,
      ...(syntaxLanguage ? { syntaxLanguage } : {}),
    });
    if (rendered) {
      recognized.push([key, rendered]);
    } else {
      remaining[key] = entry;
    }
  }
  if (recognized.length === 0) {
    return;
  }

  const lines: string[] = [];
  const hangingIndents: Record<number, number> = {};
  for (const [key, rendered] of recognized) {
    if (lines.length > 0) {
      lines.push("");
    }
    const description = [rendered.kind, rendered.summary].filter(Boolean).join(", ");
    const detailLines = rendered.detailLines ?? rendered.lines;
    const detailStart = lines.length + 1;
    lines.push(
      `${context.theme.fg("accent", context.theme.bold(safeSectionLabel(key)))} ${context.theme.fg("dim", `(${description})`)}`,
      ...indent(detailLines),
    );
    const detailHangingIndents = rendered.detailHangingIndents ?? rendered.hangingIndents ?? {};
    for (const [index, width] of Object.entries(detailHangingIndents)) {
      hangingIndents[detailStart + Number(index)] = width + 2;
    }
  }
  if (Object.keys(remaining).length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(
      context.theme.fg("accent", context.theme.bold("other")),
      ...indent(renderJson(remaining)),
    );
  }
  return {
    kind: "compound",
    lines,
    summary: plural(recognized.length, "section"),
    detailLines: lines,
    hangingIndents,
    detailHangingIndents: hangingIndents,
  };
}

export function renderArrayCompound(
  value: unknown,
  context: RenderContext,
  renderNested: NestedRenderer,
): RenderedResultValue | undefined {
  if (!Array.isArray(value) || context.depth >= MAX_RECURSIVE_DEPTH || context.seen.has(value)) {
    return;
  }
  context.seen.add(value);
  const renderedEntries = value.map((entry) =>
    renderNested(entry, { ...context, depth: context.depth + 1 }),
  );
  if (!renderedEntries.some((entry) => entry !== undefined)) {
    return;
  }

  const lines: string[] = [];
  const hangingIndents: Record<number, number> = {};
  for (const [index, entry] of value.entries()) {
    if (lines.length > 0) {
      lines.push("");
    }
    const rendered = renderedEntries[index] ?? { kind: "json", lines: renderJson(entry) };
    const description = [rendered.kind, rendered.summary].filter(Boolean).join(", ");
    const detailLines = rendered.detailLines ?? rendered.lines;
    const detailStart = lines.length + 1;
    lines.push(
      `${context.theme.fg("accent", context.theme.bold(`[${index}]`))} ${context.theme.fg("dim", `(${description})`)}`,
      ...indent(detailLines),
    );
    const detailHangingIndents = rendered.detailHangingIndents ?? rendered.hangingIndents ?? {};
    for (const [lineIndex, width] of Object.entries(detailHangingIndents)) {
      hangingIndents[detailStart + Number(lineIndex)] = width + 2;
    }
  }
  return {
    kind: "array",
    lines,
    summary: plural(value.length, "item"),
    detailLines: lines,
    hangingIndents,
    detailHangingIndents: hangingIndents,
  };
}
