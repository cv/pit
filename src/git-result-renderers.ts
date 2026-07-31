import { highlightCode } from "@earendil-works/pi-coding-agent";
import type {
  RenderContext,
  RenderedResultValue,
  ResultTheme,
  ValueRenderer,
} from "./result-renderer-types.js";

interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number;
  truncated: boolean;
}

const STATUS_PORCELAIN_PATTERN = /^.. /;
const LOG_ONE_LINE_PATTERN = /^([0-9a-f]{7,40})(\s+)(.*)$/i;
const LOG_COMMIT_LINE_PATTERN = /^(commit)\s+([0-9a-f]{7,40})(.*)$/i;
const SHOW_DIFF_PATTERN = /^(?:commit\s|diff --git )/m;
const JSON_CONTAINER_PATTERN = /^\s*[\[{]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function processResult(value: unknown): ProcessResult | undefined {
  if (!isRecord(value)) {
    return;
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 4 ||
    !["stdout", "stderr", "code", "truncated"].every((key) => key in value) ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    typeof value.code !== "number" ||
    typeof value.truncated !== "boolean"
  ) {
    return;
  }
  return value as unknown as ProcessResult;
}

type ParsedGitRenderer = (result: ProcessResult, context: RenderContext) => RenderedResultValue;

function gitRenderer(renderer: ParsedGitRenderer): ValueRenderer {
  return (value, context) => {
    const result = processResult(value);
    return result ? renderer(result, context) : undefined;
  };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function nonemptyLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function gitHeader(method: string, result: ProcessResult, theme: ResultTheme): string {
  const statusColor = result.code === 0 ? "success" : "error";
  const suffix = result.truncated ? theme.fg("warning", ", truncated") : "";
  return `${theme.fg("toolTitle", theme.bold(`git ${method}`))} ${theme.fg(statusColor, `exit ${result.code}`)}${suffix}`;
}

function gitResult(
  method: string,
  result: ProcessResult,
  context: RenderContext,
  summary: string,
  stdoutLines: string[],
  options: { stderrAsOutput?: boolean } = {},
): RenderedResultValue {
  const lines = [gitHeader(method, result, context.theme), ...stdoutLines];
  const stderrLines = nonemptyLines(result.stderr);
  if (stderrLines.length > 0) {
    lines.push(
      context.theme.fg(
        options.stderrAsOutput && result.code === 0 ? "accent" : "warning",
        "stderr",
      ),
      ...stderrLines,
    );
  }
  if (stdoutLines.length === 0 && stderrLines.length === 0) {
    lines.push(context.theme.fg("dim", "(no output)"));
  }
  return {
    kind: "git",
    lines,
    summary: `${summary}${result.truncated ? ", truncated" : ""}`,
    detailLines: lines.slice(1),
  };
}

function failedSummary(method: string, result: ProcessResult): string | undefined {
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
  const output = nonemptyLines(result.stdout);
  const failure = failedSummary("status", result);
  if (failure) {
    return gitResult("status", result, context, failure, output);
  }

  const porcelain = output.every(
    (line) => line.startsWith("##") || STATUS_PORCELAIN_PATTERN.test(line),
  );
  if (!porcelain) {
    return gitResult("status", result, context, `status, ${plural(output.length, "line")}`, output);
  }

  const branch = output.find((line) => line.startsWith("##"))?.slice(3);
  const changes = output.filter((line) => !line.startsWith("##")).length;
  const state = changes === 0 ? "clean" : plural(changes, "change");
  const summary = ["status", branch, state].filter(Boolean).join(", ");
  return gitResult(
    "status",
    result,
    context,
    summary,
    output.map((line) => statusLine(line, context.theme)),
  );
});

const renderGitDiff: ValueRenderer = gitRenderer((result, context) => {
  const output = result.stdout.trimEnd();
  const failure = failedSummary("diff", result);
  const summary =
    failure ?? (output ? `diff, ${plural(output.split("\n").length, "line")}` : "diff, no changes");
  return gitResult("diff", result, context, summary, output ? highlightCode(output, "diff") : []);
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
  const output = nonemptyLines(result.stdout);
  const commits = output.filter(
    (line) => LOG_ONE_LINE_PATTERN.test(line) || LOG_COMMIT_LINE_PATTERN.test(line),
  ).length;
  const failure = failedSummary("log", result);
  const summary = failure ?? `log, ${plural(commits || output.length, "commit")}`;
  return gitResult(
    "log",
    result,
    context,
    summary,
    output.map((line) => logLine(line, context.theme)),
  );
});

const renderGitAdd: ValueRenderer = gitRenderer((result, context) => {
  const failure = failedSummary("add", result);
  return gitResult(
    "add",
    result,
    context,
    failure ?? "add, complete",
    nonemptyLines(result.stdout),
  );
});

const renderGitCommit: ValueRenderer = gitRenderer((result, context) => {
  const output = nonemptyLines(result.stdout);
  const styled = output.map((line, index) =>
    index === 0 && result.code === 0 ? context.theme.fg("success", line) : line,
  );
  const failure = failedSummary("commit", result);
  return gitResult("commit", result, context, failure ?? "commit, complete", styled);
});

function showLines(output: string): string[] {
  if (SHOW_DIFF_PATTERN.test(output)) {
    return highlightCode(output, "diff");
  }
  if (JSON_CONTAINER_PATTERN.test(output)) {
    try {
      return highlightCode(JSON.stringify(JSON.parse(output), null, 2), "json");
    } catch {
      // Keep malformed or incomplete JSON-like output as plain text.
    }
  }
  return output.split("\n");
}

const renderGitShow: ValueRenderer = gitRenderer((result, context) => {
  const output = result.stdout.trimEnd();
  const failure = failedSummary("show", result);
  const summary = failure ?? `show, ${plural(output ? output.split("\n").length : 0, "line")}`;
  return gitResult("show", result, context, summary, output ? showLines(output) : []);
});

const renderGitPush: ValueRenderer = gitRenderer((result, context) => {
  const failure = failedSummary("push", result);
  return gitResult(
    "push",
    result,
    context,
    failure ?? "push, complete",
    nonemptyLines(result.stdout),
    { stderrAsOutput: true },
  );
});

const renderGitTag: ValueRenderer = gitRenderer((result, context) => {
  const output = nonemptyLines(result.stdout);
  const failure = failedSummary("tag", result);
  const summary =
    failure ?? (output.length > 0 ? `tag, ${plural(output.length, "tag")}` : "tag, complete");
  return gitResult(
    "tag",
    result,
    context,
    summary,
    output.map((line) => context.theme.fg("accent", line)),
  );
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
