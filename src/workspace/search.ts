import { readFile, stat } from "node:fs/promises";

import fg from "fast-glob";

import { recordValue as object, stringValue as string } from "../shared/argument-values.js";
import { fileRevision, lineAnchor } from "./hashline.js";
import { checkAbort, resolveWorkspacePath, workspaceResultPath } from "./paths.js";
import { InterruptibleRegexMatcher } from "./regex-worker.js";

const MAX_SEARCH_FILE_BYTES = 1_000_000;
const MAX_SEARCH_FILES = 2000;
const MAX_SEARCH_RESULTS = 500;

interface SearchContextLine {
  line: number;
  anchor: string;
  text: string;
}

interface SearchMatch extends SearchContextLine {
  file: string;
  revision: string;
  column: number;
  before: SearchContextLine[];
  after: SearchContextLine[];
}

interface SearchRequest {
  query: string;
  options: Record<string, unknown>;
  searchPath: string;
  regex: boolean;
  caseSensitive: boolean;
  contextLines: number;
  limit: number;
}

function parseSearchRequest(cwd: string, args: unknown[]): SearchRequest {
  const query = string(args[0], "query");
  if (!query) {
    throw new Error("query must not be empty");
  }
  const options = args[1] === undefined ? {} : object(args[1], "options");
  const searchPath = options.path === undefined ? cwd : resolveWorkspacePath(cwd, options.path);
  const regex = options.regex === undefined ? false : Boolean(options.regex);
  const caseSensitive = options.caseSensitive === undefined ? true : Boolean(options.caseSensitive);
  const contextLines = Number(options.contextLines ?? 0);
  const limit = Number(options.limit ?? 100);
  if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 10) {
    throw new Error("contextLines must be an integer between 0 and 10");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
    throw new Error(`limit must be an integer between 1 and ${MAX_SEARCH_RESULTS}`);
  }
  if (regex) {
    try {
      RegExp(query, caseSensitive ? "g" : "gi");
    } catch (error) {
      throw new Error(`Invalid search regex: ${String(error)}`, { cause: error });
    }
  }
  return { query, options, searchPath, regex, caseSensitive, contextLines, limit };
}

async function discoverSearchFiles(request: SearchRequest): Promise<string[]> {
  const pathInfo = await stat(request.searchPath);
  if (pathInfo.isFile()) {
    return [request.searchPath];
  }
  if (!pathInfo.isDirectory()) {
    throw new Error("search path must be a file or directory");
  }
  const patterns =
    typeof request.options.glob === "string" || Array.isArray(request.options.glob)
      ? (request.options.glob as string | string[])
      : "**/*";
  const ignore = [
    "**/.git/**",
    "**/node_modules/**",
    ...(Array.isArray(request.options.ignore) ? request.options.ignore.map(String) : []),
  ];
  const discovered: string[] = [];
  const stream = fg.stream(patterns, {
    cwd: request.searchPath,
    dot: Boolean(request.options.dot),
    onlyFiles: true,
    ignore,
    followSymbolicLinks: false,
    absolute: true,
  });
  for await (const entry of stream) {
    discovered.push(String(entry));
    /* v8 ignore next -- the hard file cap is impractical to exercise in unit fixtures. */
    if (discovered.length === MAX_SEARCH_FILES) {
      break;
    }
  }
  return discovered.sort((a, b) => a.localeCompare(b));
}

function literalMatchColumns(input: {
  text: string;
  query: string;
  caseSensitive: boolean;
  maximum: number;
}): number[] {
  const haystack = input.caseSensitive ? input.text : input.text.toLowerCase();
  const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
  const columns: number[] = [];
  let offset = 0;
  while (offset <= haystack.length - needle.length && columns.length < input.maximum) {
    const found = haystack.indexOf(needle, offset);
    if (found < 0) {
      break;
    }
    columns.push(found);
    offset = found + Math.max(1, needle.length);
  }
  return columns;
}

async function scanSearchFile(input: {
  cwd: string;
  file: string;
  request: SearchRequest;
  regexMatcher?: InterruptibleRegexMatcher;
  matches: SearchMatch[];
  signal?: AbortSignal;
}): Promise<{ searched: boolean; skipped: boolean; truncated: boolean }> {
  checkAbort(input.signal);
  let buffer: Buffer;
  try {
    const info = await stat(input.file);
    if (info.size > MAX_SEARCH_FILE_BYTES) {
      return { searched: false, skipped: true, truncated: false };
    }
    buffer = await readFile(input.file, { signal: input.signal });
  } catch {
    return { searched: false, skipped: true, truncated: false };
  }
  if (buffer.includes(0)) {
    return { searched: false, skipped: true, truncated: false };
  }
  const contents = buffer.toString("utf8");
  const revision = fileRevision(contents);
  const filePath = workspaceResultPath(input.cwd, input.file);
  const lines = contents
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const contextLine = (lineIndex: number): SearchContextLine => {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const text = lines[lineIndex]!;
    return { line: lineIndex + 1, anchor: lineAnchor(lineIndex + 1, text), text };
  };
  const remaining = input.request.limit - input.matches.length;
  const regexMatches = input.regexMatcher ? await input.regexMatcher.match(lines, remaining) : [];
  const regexColumns = new Map<number, number[]>();
  for (const match of regexMatches) {
    const columns = regexColumns.get(match.lineIndex) ?? [];
    columns.push(match.column);
    regexColumns.set(match.lineIndex, columns);
  }
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const text = lines[lineIndex]!;
    const columns = input.regexMatcher
      ? (regexColumns.get(lineIndex) ?? [])
      : literalMatchColumns({
          text,
          query: input.request.query,
          caseSensitive: input.request.caseSensitive,
          maximum: input.request.limit - input.matches.length,
        });
    for (const column of columns) {
      input.matches.push({
        file: filePath,
        revision,
        line: lineIndex + 1,
        anchor: lineAnchor(lineIndex + 1, text),
        column: column + 1,
        text,
        before: Array.from(
          { length: Math.min(input.request.contextLines, lineIndex) },
          (_, index) =>
            contextLine(lineIndex - Math.min(input.request.contextLines, lineIndex) + index),
        ),
        after: Array.from(
          { length: Math.min(input.request.contextLines, lines.length - lineIndex - 1) },
          (_, index) => contextLine(lineIndex + index + 1),
        ),
      });
      if (input.matches.length >= input.request.limit) {
        return { searched: true, skipped: false, truncated: true };
      }
    }
  }
  return { searched: true, skipped: false, truncated: false };
}

// Syntax that means something only to a regular expression. A literal search for it that finds
// nothing almost always meant regex: true.
const REGEX_SYNTAX = /\||\\[bdswBDSW]|\.[*+]|\(\?|^\^|\$$/;

function regexSyntaxHint(query: string): string | undefined {
  const token = REGEX_SYNTAX.exec(query)?.[0];
  return token === undefined
    ? undefined
    : `No literal matches, but the query contains regular expression syntax (${JSON.stringify(token)}). Pass regex: true to search it as a pattern.`;
}

export async function searchWorkspace(cwd: string, args: unknown[], signal?: AbortSignal) {
  const request = parseSearchRequest(cwd, args);
  const files = await discoverSearchFiles(request);
  const matches: SearchMatch[] = [];
  let filesSearched = 0;
  let filesSkipped = 0;
  let truncated = false;
  const regexMatcher = request.regex
    ? new InterruptibleRegexMatcher(request.query, request.caseSensitive)
    : undefined;
  try {
    for (const file of files) {
      const scanned = await scanSearchFile({
        cwd,
        file,
        request,
        ...(regexMatcher ? { regexMatcher } : {}),
        matches,
        ...(signal ? { signal } : {}),
      });
      filesSearched += scanned.searched ? 1 : 0;
      filesSkipped += scanned.skipped ? 1 : 0;
      if (scanned.truncated) {
        truncated = true;
        break;
      }
    }
  } finally {
    await regexMatcher?.close();
  }
  const hint = request.regex || matches.length > 0 ? undefined : regexSyntaxHint(request.query);
  return { matches, truncated, filesSearched, filesSkipped, ...(hint ? { hint } : {}) };
}
