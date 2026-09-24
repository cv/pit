import { highlightCode } from "@earendil-works/pi-coding-agent";

import {
  processOutputLines,
  type DisplayProcessResult,
  parseProcessResult,
  semanticOutcome,
} from "../process/results.js";
import { parseCompleteJson, plural } from "./shared.js";
import type { RenderContext, RenderedResultValue, ResultTheme, ValueRenderer } from "./types.js";

const STATUS_PORCELAIN_PATTERN = /^.. /;
const LOG_ONE_LINE_PATTERN = /^([0-9a-f]{7,40})(\s+)(.*)$/i;
const LOG_COMMIT_LINE_PATTERN = /^(commit)\s+([0-9a-f]{7,40})(.*)$/i;
const SHOW_DIFF_PATTERN = /^(?:commit\s|diff --git )/m;

type ParsedGitRenderer = (
  result: DisplayProcessResult,
  context: RenderContext,
) => RenderedResultValue;

function gitRenderer(renderer: ParsedGitRenderer): ValueRenderer {
  return (value, context) => {
    const result = parseProcessResult(value);
    return result ? renderer(result, context) : undefined;
  };
}

function reportsDifferences(result: DisplayProcessResult): boolean {
  return result.code === 1 && result.stderr.trim() === "";
}

function gitOutcome(method: string, result: DisplayProcessResult) {
  return semanticOutcome(
    result,
    method === "diff" && reportsDifferences(result)
      ? { domainOutcome: "warning", acceptedExitCodes: [1] }
      : {},
  );
}

function gitHeader(method: string, result: DisplayProcessResult, theme: ResultTheme): string {
  const statusColor = gitOutcome(method, result);
  const suffix = result.truncated ? theme.fg("warning", ", truncated") : "";
  return `${theme.fg("toolTitle", theme.bold(`git ${method}`))} ${theme.fg(statusColor, `exit ${result.code}`)}${suffix}`;
}

interface GitResultOptions {
  method: string;
  result: DisplayProcessResult;
  context: RenderContext;
  summary: string;
  stdoutLines: string[];
  stderrAsOutput?: boolean;
}

function gitResult({
  method,
  result,
  context,
  summary,
  stdoutLines,
  stderrAsOutput,
}: GitResultOptions): RenderedResultValue {
  const lines = [gitHeader(method, result, context.theme), ...stdoutLines];
  const stderrLines = processOutputLines(result.stderr);
  if (stderrLines.length > 0) {
    lines.push(
      context.theme.fg(stderrAsOutput && result.code === 0 ? "accent" : "warning", "stderr"),
      ...stderrLines,
    );
  }
  if (stdoutLines.length === 0 && stderrLines.length === 0) {
    lines.push(context.theme.fg("dim", "(no output)"));
  }
  return {
    kind: "git",
    outcome: gitOutcome(method, result),
    lines,
    summary: `${summary}${result.truncated ? ", truncated" : ""}`,
    detailLines: lines.slice(1),
  };
}

function failedSummary(method: string, result: DisplayProcessResult): string | undefined {
  return result.code === 0 ? undefined : `${method}, exit ${result.code}`;
}

function statusLine(line: string, theme: ResultTheme): string {
  if (line.startsWith("##")) {
    return theme.fg("accent", line);
  }
  const code = line.slice(0, 2);
  if (code === "??") {
    return `${theme.fg("warning", code)}${line.slice(2)}`;
  }
  if (code.includes("D")) {
    return `${theme.fg("toolDiffRemoved", code)}${line.slice(2)}`;
  }
  if (code.includes("A")) {
    return `${theme.fg("toolDiffAdded", code)}${line.slice(2)}`;
  }
  if (code.includes("M") || code.includes("R") || code.includes("C")) {
    return `${theme.fg("warning", code)}${line.slice(2)}`;
  }
  return line;
}

const renderGitStatus: ValueRenderer = gitRenderer((result, context) => {
  const output = processOutputLines(result.stdout);
  const failure = failedSummary("status", result);
  if (failure) {
    return gitResult({ method: "status", result, context, summary: failure, stdoutLines: output });
  }

  const porcelain = output.every(
    (line) => line.startsWith("##") || STATUS_PORCELAIN_PATTERN.test(line),
  );
  if (!porcelain) {
    return gitResult({
      method: "status",
      result,
      context,
      summary: `status, ${plural(output.length, "line")}`,
      stdoutLines: output,
    });
  }

  const branch = output.find((line) => line.startsWith("##"))?.slice(3);
  const changes = output.filter((line) => !line.startsWith("##")).length;
  const state = changes === 0 ? "clean" : plural(changes, "change");
  const summary = ["status", branch, state].filter(Boolean).join(", ");
  return gitResult({
    method: "status",
    result,
    context,
    summary,
    stdoutLines: output.map((line) => statusLine(line, context.theme)),
  });
});

const renderGitDiff: ValueRenderer = gitRenderer((result, context) => {
  const output = result.stdout.replace(/\r?\n$/, "");
  const failure = reportsDifferences(result)
    ? "diff, differences found (exit 1)"
    : failedSummary("diff", result);
  const summary =
    failure ?? (output ? `diff, ${plural(output.split("\n").length, "line")}` : "diff, no changes");
  return gitResult({
    method: "diff",
    result,
    context,
    summary,
    stdoutLines: output ? highlightCode(output, "diff") : [],
  });
});

function logLine(line: string, theme: ResultTheme): string {
  const oneLine = line.match(LOG_ONE_LINE_PATTERN);
  if (oneLine) {
    return `${theme.fg("accent", oneLine[1] as string)}${oneLine[2]}${oneLine[3]}`;
  }
  const commit = line.match(LOG_COMMIT_LINE_PATTERN);
  if (commit) {
    return `${theme.fg("toolTitle", commit[1] as string)} ${theme.fg("accent", commit[2] as string)}${commit[3]}`;
  }
  return line;
}

const renderGitLog: ValueRenderer = gitRenderer((result, context) => {
  const output = processOutputLines(result.stdout);
  const commits = output.filter(
    (line) => LOG_ONE_LINE_PATTERN.test(line) || LOG_COMMIT_LINE_PATTERN.test(line),
  ).length;
  const failure = failedSummary("log", result);
  const summary = failure ?? `log, ${plural(commits || output.length, "commit")}`;
  return gitResult({
    method: "log",
    result,
    context,
    summary,
    stdoutLines: output.map((line) => logLine(line, context.theme)),
  });
});

const renderGitAdd: ValueRenderer = gitRenderer((result, context) => {
  const failure = failedSummary("add", result);
  return gitResult({
    method: "add",
    result,
    context,
    summary: failure ?? "add, complete",
    stdoutLines: processOutputLines(result.stdout),
  });
});

const renderGitCommit: ValueRenderer = gitRenderer((result, context) => {
  const output = processOutputLines(result.stdout);
  const styled = output.map((line, index) =>
    index === 0 && result.code === 0 ? context.theme.fg("success", line) : line,
  );
  const failure = failedSummary("commit", result);
  return gitResult({
    method: "commit",
    result,
    context,
    summary: failure ?? "commit, complete",
    stdoutLines: styled,
  });
});

function showLines(output: string, truncated: boolean): string[] {
  if (SHOW_DIFF_PATTERN.test(output)) {
    return highlightCode(output, "diff");
  }
  // Keep malformed, truncated, or scalar JSON-like output as plain text.
  const parsed = parseCompleteJson(output, { truncated, requireContainer: true });
  return parsed === undefined
    ? output.split("\n")
    : highlightCode(JSON.stringify(parsed, null, 2), "json");
}

const renderGitShow: ValueRenderer = gitRenderer((result, context) => {
  const output = result.stdout.replace(/\r?\n$/, "");
  const failure = failedSummary("show", result);
  const summary = failure ?? `show, ${plural(output ? output.split("\n").length : 0, "line")}`;
  return gitResult({
    method: "show",
    result,
    context,
    summary,
    stdoutLines: output ? showLines(output, result.truncated) : [],
  });
});

const renderGitPush: ValueRenderer = gitRenderer((result, context) => {
  const failure = failedSummary("push", result);
  return gitResult({
    method: "push",
    result,
    context,
    summary: failure ?? "push, complete",
    stdoutLines: processOutputLines(result.stdout),
    stderrAsOutput: true,
  });
});

const renderGitTag: ValueRenderer = gitRenderer((result, context) => {
  const output = processOutputLines(result.stdout);
  const failure = failedSummary("tag", result);
  const summary =
    failure ?? (output.length > 0 ? `tag, ${plural(output.length, "tag")}` : "tag, complete");
  return gitResult({
    method: "tag",
    result,
    context,
    summary,
    stdoutLines: output.map((line) => context.theme.fg("accent", line)),
  });
});

export const GIT_RESULT_RENDERERS = {
  status: renderGitStatus,
  diff: renderGitDiff,
  log: renderGitLog,
  add: renderGitAdd,
  commit: renderGitCommit,
  show: renderGitShow,
  push: renderGitPush,
  tag: renderGitTag,
} as const satisfies Record<string, ValueRenderer>;
