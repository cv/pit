import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";

import type { ResultTheme } from "../result-renderer-types.js";

export type JsonRecord = Record<string, unknown>;

export const MAX_RECURSIVE_DEPTH = 4;
export const JSON_CONTAINER_PREFIX = /^\s*[[{]/;
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

export function renderJson(value: unknown): string[] {
  try {
    const source = JSON.stringify(value, null, 2) ?? String(value);
    return highlightCode(source, "json");
  } catch {
    return [String(value)];
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
  const highlighted = highlightCode(
    parsed.map((line) => line.content).join("\n"),
    languageForFile(file),
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
