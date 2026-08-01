import {
  nonemptyLines as lines,
  type ProcessResult,
  parseProcessResult,
  type SemanticOutcome,
  semanticOutcome,
} from "./cli.js";
import type { RenderedResultValue, ValueRenderer } from "./result-renderer-types.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape prefix is intentional.
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const TEST_COUNT_PATTERN = /Tests\s+(\d+)\s+passed/i;
const INSTALL_SUMMARY_PATTERN = /^(added|removed|changed|up to date|audited)\b/i;

function plural(count: number, noun: string, pluralForm = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralForm}`;
}
function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // Keep malformed or truncated JSON as process output.
  }
}
function renderer(
  method: string,
  summarize: (result: ProcessResult) => {
    summary: string;
    output?: string[];
    outcome?: Exclude<SemanticOutcome, "error">;
    acceptedExitCodes?: readonly number[];
  },
): ValueRenderer {
  return (value, context) => {
    const result = parseProcessResult(value);
    if (!result) {
      return;
    }
    const rendered = summarize(result);
    const status = semanticOutcome(result, {
      ...(rendered.outcome ? { domainOutcome: rendered.outcome } : {}),
      ...(rendered.acceptedExitCodes ? { acceptedExitCodes: rendered.acceptedExitCodes } : {}),
    });
    const suffix = result.truncated ? context.theme.fg("warning", ", truncated") : "";
    const output = rendered.output ?? lines(result.stdout);
    const display = [
      `${context.theme.fg("toolTitle", context.theme.bold(`npm ${method}`))} ${context.theme.fg(status, `exit ${result.code}`)}${suffix}`,
      ...output,
    ];
    const stderr = lines(result.stderr);
    if (stderr.length > 0) {
      display.push(context.theme.fg("warning", "stderr"), ...stderr);
    }
    if (output.length === 0 && stderr.length === 0) {
      display.push(context.theme.fg("dim", "(no output)"));
    }
    return {
      kind: "npm",
      lines: display,
      outcome: status,
      summary: `${rendered.summary}${result.truncated ? ", truncated" : ""}`,
      detailLines: display.slice(1),
    } satisfies RenderedResultValue;
  };
}

const run = renderer("run", (result) => ({ summary: `run, exit ${result.code}` }));
const test = renderer("test", (result) => {
  const plain = result.stdout.replace(ANSI_PATTERN, "");
  const count = Number(plain.match(TEST_COUNT_PATTERN)?.[1] ?? 0);
  return {
    summary: count ? `test, ${plural(count, "test")} passed` : `test, exit ${result.code}`,
    output: lines(result.stdout),
  };
});
const install = renderer("install", (result) => {
  const output = lines(result.stdout);
  const summaryLine = output.find((line) => INSTALL_SUMMARY_PATTERN.test(line));
  return {
    summary: summaryLine ? `install, ${summaryLine}` : `install, exit ${result.code}`,
    output,
  };
});
const audit = renderer("audit", (result) => {
  const parsed = json(result.stdout) as
    | { metadata?: { vulnerabilities?: Record<string, number> } }
    | undefined;
  const vulnerabilities = parsed?.metadata?.vulnerabilities;
  const total = typeof vulnerabilities?.total === "number" ? vulnerabilities.total : 0;
  const output = vulnerabilities
    ? [
        "vulnerabilities",
        ...["critical", "high", "moderate", "low", "info"].map(
          (severity) => `${severity}: ${vulnerabilities[severity] ?? 0}`,
        ),
      ]
    : lines(result.stdout);
  return {
    summary: parsed
      ? `audit, ${plural(total, "vulnerability", "vulnerabilities")}`
      : `audit, exit ${result.code}`,
    output,
    ...(total > 0 ? { outcome: "warning" as const, acceptedExitCodes: [1] } : {}),
  };
});
const outdated = renderer("outdated", (result) => {
  const parsed = json(result.stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { summary: `outdated, exit ${result.code}`, output: lines(result.stdout) };
  }
  const entries = Object.entries(
    parsed as Record<string, { current?: string; wanted?: string; latest?: string }>,
  );
  return {
    summary: `outdated, ${plural(entries.length, "package")}`,
    output: entries.map(
      ([name, item]) =>
        `${name}: ${item.current ?? "?"} → ${item.wanted ?? item.latest ?? "?"}${item.latest && item.latest !== item.wanted ? ` (latest ${item.latest})` : ""}`,
    ),
    ...(entries.length > 0 ? { outcome: "warning" as const, acceptedExitCodes: [1] } : {}),
  };
});
const pack = renderer("pack", (result) => {
  const parsed = json(result.stdout);
  const item = Array.isArray(parsed)
    ? (parsed[0] as
        | {
            name?: string;
            version?: string;
            filename?: string;
            size?: number;
            unpackedSize?: number;
          }
        | undefined)
    : undefined;
  if (!item) {
    return { summary: `pack, exit ${result.code}`, output: lines(result.stdout) };
  }
  const identity = [item.name, item.version].filter(Boolean).join("@");
  return {
    summary: `pack, ${identity || item.filename || "complete"}`,
    output: [
      item.filename ? `file: ${item.filename}` : "",
      item.size === undefined ? "" : `size: ${item.size} bytes`,
      item.unpackedSize === undefined ? "" : `unpacked: ${item.unpackedSize} bytes`,
    ].filter(Boolean),
  };
});

export const NPM_RESULT_RENDERERS = {
  run,
  test,
  install,
  audit,
  outdated,
  pack,
} as const satisfies Record<string, ValueRenderer>;
