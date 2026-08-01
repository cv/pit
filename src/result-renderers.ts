import { highlightCode } from "@earendil-works/pi-coding-agent";
import { type CapabilityCall, capabilityResultRenderer } from "./capability-presentation.js";
import { GIT_RESULT_RENDERERS } from "./git-result-renderers.js";
import { NPM_RESULT_RENDERERS } from "./npm-result-renderers.js";
import type {
  RenderContext,
  RenderedResultValue,
  ResultTheme,
  ValueRenderer,
} from "./result-renderer-types.js";

export type { RenderedResultValue } from "./result-renderer-types.js";

type JsonRecord = Record<string, unknown>;

const MAX_RECURSIVE_DEPTH = 4;
const JSON_CONTAINER_PREFIX = /^\s*[\[{]/;
const HASHED_LINE_PATTERN = /^(\d+:[^|]+\|)(.*)$/;
const FILE_LANGUAGES: Readonly<Record<string, string>> = {
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
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "typescript",
  yaml: "yaml",
  yml: "yaml",
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonRecord, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function indent(lines: string[], prefix = "  "): string[] {
  return lines.map((line) => `${prefix}${line}`);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function renderJson(value: unknown): string[] {
  try {
    const source = JSON.stringify(value, null, 2) ?? String(value);
    return highlightCode(source, "json");
  } catch {
    return [String(value)];
  }
}

function languageForFile(file: string): string {
  const extension = file.toLowerCase().split(".").pop();
  return FILE_LANGUAGES[extension ?? ""] ?? "text";
}
function renderHashedFile(
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

function renderShell(value: unknown, { theme }: RenderContext): RenderedResultValue | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["stdout", "stderr", "code", "truncated"]) ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    typeof value.code !== "number" ||
    typeof value.truncated !== "boolean"
  ) {
    return undefined;
  }

  const statusColor = value.code === 0 ? "success" : "error";
  const suffix = value.truncated ? theme.fg("warning", ", truncated") : "";
  const lines = [
    `${theme.fg("toolTitle", theme.bold("shell"))} ${theme.fg(statusColor, `exit ${value.code}`)}${suffix}`,
  ];
  if (value.stdout) {
    lines.push(theme.fg("accent", "stdout"), ...value.stdout.split("\n"));
  }
  if (value.stderr) {
    lines.push(theme.fg("warning", "stderr"), ...value.stderr.split("\n"));
  }
  if (!value.stdout && !value.stderr) {
    lines.push(theme.fg("dim", "(no output)"));
  }
  return {
    kind: "shell",
    lines,
    summary: `exit ${value.code}${value.truncated ? ", truncated" : ""}`,
    detailLines: lines.slice(1),
  };
}

/** Direct capability results route here before shape-based fallback rendering. */
const CAPABILITY_RESULT_RENDERERS: Readonly<Record<string, ValueRenderer>> = {
  read: renderRead,
  edit: renderEdit,
  batch: renderBatch,
  list: renderWorkspaceList,
  glob: renderGlob,
  search: renderSearch,
  stat: renderStat,
  shell: renderShell,
  http: renderHttp,
  "git.status": GIT_RESULT_RENDERERS.status,
  "git.diff": GIT_RESULT_RENDERERS.diff,
  "git.log": GIT_RESULT_RENDERERS.log,
  "git.add": GIT_RESULT_RENDERERS.add,
  "git.commit": GIT_RESULT_RENDERERS.commit,
  "git.show": GIT_RESULT_RENDERERS.show,
  "git.push": GIT_RESULT_RENDERERS.push,
  "git.tag": GIT_RESULT_RENDERERS.tag,
  "npm.run": NPM_RESULT_RENDERERS.run,
  "npm.test": NPM_RESULT_RENDERERS.test,
  "npm.install": NPM_RESULT_RENDERERS.install,
  "npm.audit": NPM_RESULT_RENDERERS.audit,
  "npm.outdated": NPM_RESULT_RENDERERS.outdated,
  "npm.pack": NPM_RESULT_RENDERERS.pack,
};

function renderRead(value: unknown, { theme }: RenderContext): RenderedResultValue | undefined {
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
  const lines = [
    `${theme.fg("toolTitle", theme.bold(value.file))} ${theme.fg("dim", `(${range}; ${flags}; rev ${value.revision})`)}`,
  ];
  const detailHangingIndents: Record<number, number> = {};
  if (value.content) {
    let contentLines: string[];
    if (value.format === "raw") {
      contentLines = highlightCode(value.content, languageForFile(value.file));
    } else {
      const rendered = renderHashedFile(value.content, value.file, theme);
      contentLines = rendered.lines;
      Object.assign(detailHangingIndents, rendered.hangingIndents);
    }
    lines.push(...contentLines);
  } else {
    lines.push(theme.fg("dim", "(empty file)"));
  }
  return {
    kind: "read",
    lines,
    summary: `${value.file}, ${range}, ${flags}`,
    detailLines: lines.slice(1),
    hangingIndents: Object.fromEntries(
      Object.entries(detailHangingIndents).map(([index, width]) => [Number(index) + 1, width]),
    ),
    detailHangingIndents,
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

function renderSearch(value: unknown, { theme }: RenderContext): RenderedResultValue | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["matches", "truncated", "filesSearched", "filesSkipped"]) ||
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
  ]
    .filter(Boolean)
    .join(", ");
  const lines = [
    `${theme.fg("toolTitle", theme.bold("search"))} ${theme.fg("dim", `(${summary})`)}`,
  ];
  for (const match of value.matches) {
    lines.push(theme.fg("accent", `${match.file}:${match.line}:${match.column} (${match.anchor})`));
    for (const contextLine of match.before) {
      lines.push(theme.fg("dim", `  ${contextLine.line}  ${contextLine.text}`));
    }
    lines.push(`> ${match.line}  ${match.text}`);
    for (const contextLine of match.after) {
      lines.push(theme.fg("dim", `  ${contextLine.line}  ${contextLine.text}`));
    }
  }
  if (value.matches.length === 0) {
    lines.push(theme.fg("dim", "(no matches)"));
  }
  return { kind: "search", lines, summary, detailLines: lines.slice(1) };
}

function renderEdit(value: unknown, { theme }: RenderContext): RenderedResultValue | undefined {
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
      `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold(value.file))} ${action} ${theme.fg("dim", `(${plural(value.applied, "change")}, ${value.bytes} bytes, ${revision})`)}`,
    ],
    summary: `${value.file}, ${action}, ${plural(value.applied, "change")}, ${value.bytes} bytes`,
    detailLines: [],
  };
}

function renderWorkspaceList(
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

function renderGlob(value: unknown, { theme }: RenderContext): RenderedResultValue | undefined {
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
    lines: [
      `${theme.fg("toolTitle", theme.bold("glob"))} ${theme.fg(value.truncated ? "warning" : "dim", `(${state})`)}`,
      ...entryLines,
    ],
    summary: state,
    detailLines: entryLines,
  };
}

function renderHttp(value: unknown, { theme }: RenderContext): RenderedResultValue | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["status", "ok", "headers", "body", "truncated"]) ||
    typeof value.status !== "number" ||
    typeof value.ok !== "boolean" ||
    !isStringRecord(value.headers) ||
    typeof value.body !== "string" ||
    typeof value.truncated !== "boolean"
  ) {
    return undefined;
  }

  const state = [`HTTP ${value.status}`, value.truncated ? "truncated" : ""]
    .filter(Boolean)
    .join(", ");
  const lines = [theme.fg(value.ok ? "success" : "error", theme.bold(state))];
  const headers = Object.entries(value.headers);
  if (headers.length > 0) {
    lines.push(theme.fg("accent", "headers"));
    lines.push(
      ...headers.map(([name, headerValue]) => `${theme.fg("dim", `${name}:`)} ${headerValue}`),
    );
  }
  if (value.body) {
    lines.push(theme.fg("accent", "body"));
    const contentType = Object.entries(value.headers).find(
      ([name]) => name.toLowerCase() === "content-type",
    )?.[1];
    const shouldParseJson =
      contentType?.toLowerCase().includes("json") === true ||
      JSON_CONTAINER_PREFIX.test(value.body);
    let bodyLines = value.body.split("\n");
    if (shouldParseJson) {
      try {
        bodyLines = renderJson(JSON.parse(value.body));
      } catch {
        // Keep malformed or mislabeled response bodies as text.
      }
    }
    lines.push(...bodyLines);
  } else {
    lines.push(theme.fg("dim", "(empty body)"));
  }
  return { kind: "http", lines, summary: state, detailLines: lines.slice(1) };
}

function isBatchEntry(value: unknown): value is JsonRecord {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !["read", "edit"].includes(value.kind) ||
    typeof value.index !== "number" ||
    typeof value.ok !== "boolean"
  ) {
    return false;
  }
  if (value.ok) {
    return hasOnlyKeys(value, ["kind", "index", "ok", "value"]);
  }
  return (
    value.kind === "read" &&
    hasOnlyKeys(value, ["kind", "index", "ok", "error"], ["value"]) &&
    typeof value.error === "string" &&
    value.value === undefined
  );
}

function renderBatch(value: unknown, context: RenderContext): RenderedResultValue | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["results"]) ||
    !Array.isArray(value.results) ||
    !value.results.every(isBatchEntry)
  ) {
    return undefined;
  }

  const succeeded = value.results.filter((entry) => entry.ok).length;
  const failed = value.results.length - succeeded;
  const summary = [
    plural(value.results.length, "operation"),
    `${succeeded} succeeded`,
    failed ? `${failed} failed` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const lines = [
    `${context.theme.fg("toolTitle", context.theme.bold("batch"))} ${context.theme.fg(failed ? "warning" : "dim", `(${summary})`)}`,
  ];
  for (const entry of value.results) {
    const status = entry.ok ? context.theme.fg("success", "✓") : context.theme.fg("error", "✗");
    lines.push(`${status} [${entry.index}] ${entry.kind}`);
    if (entry.ok) {
      const nested = renderValueWithFallback(entry.value, {
        ...context,
        depth: context.depth + 1,
      });
      lines.push(...indent(nested.lines));
    } else {
      lines.push(context.theme.fg("error", `  ${entry.error}`));
    }
  }
  return { kind: "batch", lines, summary, detailLines: lines.slice(1) };
}

function renderStat(value: unknown, { theme }: RenderContext): RenderedResultValue | undefined {
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
    detailLines: [],
  };
}

const VALUE_RENDERERS: ValueRenderer[] = [
  renderShell,
  renderRead,
  renderSearch,
  renderEdit,
  renderGlob,
  renderHttp,
  renderBatch,
  renderStat,
  renderWorkspaceList,
];

function renderCompound(value: unknown, context: RenderContext): RenderedResultValue | undefined {
  if (!isRecord(value) || context.depth >= MAX_RECURSIVE_DEPTH || context.seen.has(value)) {
    return undefined;
  }
  context.seen.add(value);

  const recognized: Array<[string, RenderedResultValue]> = [];
  const remaining: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    const rendered = renderKnownValue(entry, { ...context, depth: context.depth + 1 });
    if (rendered) {
      recognized.push([key, rendered]);
    } else {
      remaining[key] = entry;
    }
  }
  if (recognized.length === 0) {
    return undefined;
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
      `${context.theme.fg("accent", context.theme.bold(key))} ${context.theme.fg("dim", `(${description})`)}`,
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

function renderKnownValue(value: unknown, context: RenderContext): RenderedResultValue | undefined {
  if (context.depth === 0 && context.capabilityCall) {
    const rendererName = capabilityResultRenderer(context.capabilityCall);
    const renderer = rendererName ? CAPABILITY_RESULT_RENDERERS[rendererName] : undefined;
    const rendered = renderer?.(value, context);
    if (rendered) {
      return rendered;
    }
  }

  for (const renderer of VALUE_RENDERERS) {
    const rendered = renderer(value, context);
    if (rendered) {
      return rendered;
    }
  }
  return renderCompound(value, context);
}

function renderValueWithFallback(value: unknown, context: RenderContext): RenderedResultValue {
  return renderKnownValue(value, context) || { kind: "json", lines: renderJson(value) };
}

export function renderResultValue(
  value: unknown,
  theme: ResultTheme,
  capabilityCall?: CapabilityCall,
): RenderedResultValue | undefined {
  return renderKnownValue(value, {
    theme,
    seen: new WeakSet(),
    depth: 0,
    ...(capabilityCall ? { capabilityCall } : {}),
  });
}
