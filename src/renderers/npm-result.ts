import {
  processOutputLines as lines,
  type DisplayProcessResult,
  parseProcessResult,
  type SemanticOutcome,
  semanticOutcome,
} from "../process/results.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import { isRecord, renderJson } from "./shared.js";
import type { RenderedResultValue, ResultTheme, ValueRenderer } from "./types.js";

// oxlint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const TEST_COUNTS_PATTERN = /\bTests\s+([^\r\n]+)/i;
const INSTALL_SUMMARY_PATTERN = /^(added|removed|changed|up to date|audited)\b/i;
const SEVERITIES = ["critical", "high", "moderate", "low", "info"] as const;
/** Overview rows are indented by two columns; wrapped continuations sit two further in. */
const ROW_HANGING_INDENT = 4;

interface NpmSummary {
  summary: string;
  output?: string[];
  /** Hanging indents keyed by output line index. */
  hangingIndents?: Record<number, number>;
  outcome?: Exclude<SemanticOutcome, "error">;
  acceptedExitCodes?: readonly number[];
}

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
function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}
/** Parsed JSON strings can decode escaped controls and newlines; overview rows stay on one line. */
function inline(value: string): string {
  return sanitizeTerminalText(value).replace(/\s*\n\s*/g, " ");
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? inline(value) : undefined;
}
function bytes(count: number): string {
  if (count < 1000) return plural(count, "byte");
  const units = ["kB", "MB", "GB", "TB"];
  let value = count / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
/** Decisive facts first, then the complete parsed stdout as the lossless view. */
function overviewThenStdout(
  theme: ResultTheme,
  label: string,
  rows: string[],
  parsed: unknown,
): Pick<NpmSummary, "output" | "hangingIndents"> {
  const overview =
    rows.length > 0 ? [theme.fg("accent", label), ...rows.map((row) => `  ${row}`)] : [];
  return {
    output: [...overview, theme.fg("accent", "stdout"), ...renderJson(parsed)],
    hangingIndents: Object.fromEntries(rows.map((_, index) => [index + 1, ROW_HANGING_INDENT])),
  };
}
function renderer(
  method: string,
  summarize: (result: DisplayProcessResult, theme: ResultTheme) => NpmSummary,
): ValueRenderer {
  return (value, context) => {
    const result = parseProcessResult(value);
    if (!result) {
      return;
    }
    const rendered = summarize(result, context.theme);
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
    // Both views keep exactly one line (header or exit code) before the output.
    const hangingIndents = Object.fromEntries(
      Object.entries(rendered.hangingIndents ?? {}).map(([index, width]) => [
        Number(index) + 1,
        width,
      ]),
    );
    return {
      kind: "npm",
      lines: display,
      outcome: status,
      summary: `${rendered.summary}${result.truncated ? ", truncated" : ""}`,
      detailLines: [`exit: ${result.code}`, ...display.slice(1)],
      ...(Object.keys(hangingIndents).length > 0
        ? { hangingIndents, detailHangingIndents: hangingIndents }
        : {}),
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
function severityRank(severity: unknown): number {
  const rank = SEVERITIES.findIndex((known) => known === severity);
  return rank === -1 ? SEVERITIES.length : rank;
}
function advisories(via: unknown): string[] {
  if (!Array.isArray(via)) return [];
  const titles = via.flatMap((item) => {
    const title = text(field(item, "title"));
    return title ? [title] : [];
  });
  const packages = via.flatMap((item) => {
    const name = text(item);
    return name ? [name] : [];
  });
  return [...titles, ...(packages.length > 0 ? [`via ${packages.join(", ")}`] : [])];
}
function remedy(fix: unknown): string[] {
  if (fix === true) return ["fix available"];
  if (fix === false) return ["no fix available"];
  const name = text(field(fix, "name"));
  const version = text(field(fix, "version"));
  if (!name || !version) return [];
  return [
    `fix: ${name}@${version}${field(fix, "isSemVerMajor") === true ? " (semver-major)" : ""}`,
  ];
}
/** Affected packages, most severe first; the stdout section keeps npm's own order. */
function auditRows(vulnerabilities: unknown): string[] {
  if (!isRecord(vulnerabilities)) return [];
  return Object.entries(vulnerabilities)
    .flatMap(([name, entry]) => (isRecord(entry) ? [{ name, entry }] : []))
    .sort((left, right) => severityRank(left.entry.severity) - severityRank(right.entry.severity))
    .map(({ name, entry }) => {
      const range = text(entry.range);
      const facts = [...advisories(entry.via), ...remedy(entry.fixAvailable)];
      return [
        `${text(entry.severity) ?? "unknown severity"} ${inline(name)}${range ? ` ${range}` : ""}`,
        ...(facts.length > 0 ? [facts.join("; ")] : []),
      ].join(": ");
    });
}
function severityBreakdown(counts: unknown): string {
  return SEVERITIES.flatMap((severity) => {
    const count = field(counts, severity);
    return typeof count === "number" && count > 0 ? [`${count} ${severity}`] : [];
  }).join(", ");
}
const audit = renderer("audit", (result, theme) => {
  const parsed = result.truncated ? undefined : json(result.stdout);
  const counts = field(field(parsed, "metadata"), "vulnerabilities");
  const total = field(counts, "total");
  const breakdown = severityBreakdown(counts);
  return {
    summary:
      typeof total === "number"
        ? `audit, ${plural(total, "vulnerability", "vulnerabilities")}${breakdown ? ` (${breakdown})` : ""}`
        : `audit, exit ${result.code}`,
    ...(parsed === undefined
      ? { output: lines(result.stdout) }
      : overviewThenStdout(
          theme,
          "vulnerabilities",
          auditRows(field(parsed, "vulnerabilities")),
          parsed,
        )),
    ...(typeof total === "number" && total > 0
      ? { outcome: "warning" as const, acceptedExitCodes: [1] }
      : {}),
  };
});
function outdatedRow(name: string, item: Record<string, unknown>): string {
  const current = text(item.current);
  const targets = (["wanted", "latest"] as const).flatMap((key) => {
    const version = text(item[key]);
    return version ? [`${key} ${version}`] : [];
  });
  return `${inline(name)}: ${[current ? `current ${current}` : "not installed", ...targets].join(", ")}`;
}
const outdated = renderer("outdated", (result, theme) => {
  const parsed = result.truncated ? undefined : json(result.stdout);
  if (!isRecord(parsed)) {
    return { summary: `outdated, exit ${result.code}`, output: lines(result.stdout) };
  }
  const entries = Object.entries(parsed);
  const packages = entries.flatMap(([name, item]) =>
    isRecord(item) &&
    [item.current, item.wanted, item.latest].some((version) => typeof version === "string")
      ? [{ name, item }]
      : [],
  );
  const findings = entries.length > 0 && packages.length === entries.length;
  return {
    summary:
      findings || entries.length === 0
        ? `outdated, ${plural(entries.length, "package")}`
        : `outdated, exit ${result.code}`,
    ...overviewThenStdout(
      theme,
      "packages",
      findings ? packages.map(({ name, item }) => outdatedRow(name, item)) : [],
      parsed,
    ),
    ...(findings ? { outcome: "warning" as const, acceptedExitCodes: [1] } : {}),
  };
});
function packIdentity(item: Record<string, unknown>): string | undefined {
  return [text(item.name), text(item.version)].filter(Boolean).join("@") || undefined;
}
function packFileCount(item: Record<string, unknown>): number | undefined {
  if (typeof item.entryCount === "number") return item.entryCount;
  return Array.isArray(item.files) ? item.files.length : undefined;
}
function packRow(item: Record<string, unknown>): string {
  const identity = packIdentity(item);
  const filename = text(item.filename);
  const files = packFileCount(item);
  const facts = [
    ...(identity && filename ? [filename] : []),
    ...(typeof item.size === "number" ? [`${bytes(item.size)} packed`] : []),
    ...(typeof item.unpackedSize === "number" ? [`${bytes(item.unpackedSize)} unpacked`] : []),
    ...(files === undefined ? [] : [plural(files, "file")]),
  ];
  const head = identity ?? filename ?? "package";
  return facts.length > 0 ? `${head}: ${facts.join(", ")}` : head;
}
const pack = renderer("pack", (result, theme) => {
  const parsed = result.truncated ? undefined : json(result.stdout);
  const items = Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  const [first] = items;
  if (!first) {
    return { summary: `pack, exit ${result.code}`, output: lines(result.stdout) };
  }
  const files = packFileCount(first);
  const summary =
    items.length > 1
      ? plural(items.length, "tarball")
      : [
          packIdentity(first) ?? text(first.filename) ?? "complete",
          ...(files === undefined ? [] : [plural(files, "file")]),
        ].join(", ");
  return {
    summary: `pack, ${summary}`,
    ...overviewThenStdout(
      theme,
      items.length > 1 ? "tarballs" : "tarball",
      items.map(packRow),
      parsed,
    ),
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
