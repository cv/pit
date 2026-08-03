import { highlightCode } from "@earendil-works/pi-coding-agent";
import type { ResultTheme } from "../result-renderer-types.js";

export type JsonRecord = Record<string, unknown>;

export const MAX_RECURSIVE_DEPTH = 4;
export const JSON_CONTAINER_PREFIX = /^\s*[\[{]/;
const HASHED_LINE_PATTERN = /^(\d+:[^|]+\|)(.*)$/;
const FILE_LANGUAGES: Readonly<Record<string, string>> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "typescript",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

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

const LANGUAGE_HINT_ALIASES: Readonly<Record<string, string>> = {
  ...FILE_LANGUAGES,
  shell: "bash",
};
const SYNTAX_LANGUAGES = new Set(Object.values(FILE_LANGUAGES));

export function syntaxLanguageForHint(hint: string): string | undefined {
  const normalized = hint.toLowerCase();
  return (
    LANGUAGE_HINT_ALIASES[normalized] ?? (SYNTAX_LANGUAGES.has(normalized) ? normalized : undefined)
  );
}

export function languageForFile(file: string): string {
  const extension = file.toLowerCase().split(".").pop();
  return FILE_LANGUAGES[extension ?? ""] ?? "text";
}
export function renderHashedFile(
  content: string,
  file: string,
  theme: ResultTheme,
): { lines: string[]; hangingIndents: Record<number, number> } {
  const parsed = content.split("\n").map((line) => {
    const match = line.match(HASHED_LINE_PATTERN);
    return match
      ? { prefix: match[1] as string, content: match[2] as string }
      : { prefix: undefined, content: line };
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
