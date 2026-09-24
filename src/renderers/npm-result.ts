import {
  processOutputLines as lines,
  type DisplayProcessResult,
  parseProcessResult,
  type SemanticOutcome,
  semanticOutcome,
} from "../process/results.js";
import { isRecord, renderJson } from "./shared.js";
import type { RenderedResultValue, ValueRenderer } from "./types.js";

// oxlint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const TEST_COUNTS_PATTERN = /\bTests\s+([^\r\n]+)/i;
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
  summarize: (result: DisplayProcessResult) => {
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
      detailLines: [`exit: ${result.code}`, ...display.slice(1)],
    } satisfies RenderedResultValue;
  };
}

const run = renderer("run", (result) => ({ summary: `run, exit ${result.code}` }));
const test = renderer("test", (result) => {
  const plain = result.stdout.replace(ANSI_PATTERN, "");
  const counts = plain.match(TEST_COUNTS_PATTERN)?.[1] ?? "";
  const passed = Number(counts.match(/(\d+)\s+passed/i)?.[1] ?? 0);
  const failed = Number(counts.match(/(\d+)\s+failed/i)?.[1] ?? 0);
  return {
    summary: failed
      ? `test, ${failed} failed, ${passed} passed`
      : passed
        ? `test, ${plural(passed, "test")} passed`
        : `test, exit ${result.code}`,
    output: lines(result.stdout),
    ...(failed > 0 ? { outcome: "warning" as const } : {}),
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
  const parsed = (result.truncated ? undefined : json(result.stdout)) as
    | { metadata?: { vulnerabilities?: Record<string, number> } }
    | undefined;
  const vulnerabilities = parsed?.metadata?.vulnerabilities;
  const total = typeof vulnerabilities?.total === "number" ? vulnerabilities.total : 0;
  const output = parsed === undefined ? lines(result.stdout) : renderJson(parsed);
  return {
    summary:
      typeof vulnerabilities?.total === "number"
        ? `audit, ${plural(total, "vulnerability", "vulnerabilities")}`
        : `audit, exit ${result.code}`,
    output,
    ...(total > 0 ? { outcome: "warning" as const, acceptedExitCodes: [1] } : {}),
  };
});
const outdated = renderer("outdated", (result) => {
  const parsed = result.truncated ? undefined : json(result.stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { summary: `outdated, exit ${result.code}`, output: lines(result.stdout) };
  }
  const entries = Object.entries(parsed);
  const findings =
    entries.length > 0 &&
    entries.every(
      ([, item]) =>
        isRecord(item) &&
        [item.current, item.wanted, item.latest].some((version) => typeof version === "string"),
    );
  return {
    summary:
      findings || entries.length === 0
        ? `outdated, ${plural(entries.length, "package")}`
        : `outdated, exit ${result.code}`,
    output: renderJson(parsed),
    ...(findings ? { outcome: "warning" as const, acceptedExitCodes: [1] } : {}),
  };
});
const pack = renderer("pack", (result) => {
  const parsed = result.truncated ? undefined : json(result.stdout);
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
    output: renderJson(parsed),
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
