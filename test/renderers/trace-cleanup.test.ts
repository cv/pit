import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";

import type { CapabilityTrace } from "../../src/execution/capability-trace.js";
import type { ShellProgress } from "../../src/execution/types.js";
import { renderExecutionDashboard } from "../../src/renderers/execution-dashboard.js";
import { renderResultValue } from "../../src/renderers/generic.js";
import { renderTypeScriptToolResult } from "../../src/renderers/typescript-tool.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const read = (file: string, extra = {}) => ({
  file,
  format: "raw",
  content: "FILE_SENTINEL\n",
  revision: "rev",
  lines: 2,
  ...extra,
});
const processResult = (code = 0) => ({ stdout: "31\n", stderr: "", code, truncated: false });
const trace = (sequence: number, extra: Partial<CapabilityTrace> = {}): CapabilityTrace => ({
  id: sequence,
  sequence,
  capability: "shell",
  method: "execFile",
  arguments: [],
  startedAt: 0,
  durationMs: 68,
  status: "succeeded",
  ...extra,
});
function render(value: unknown, expanded: boolean, extra = {}, width = 80) {
  const rows = renderTypeScriptToolResult(
    { content: [], details: { value, truncated: false, ...extra } },
    { expanded, isPartial: false },
    theme,
    { executionStarted: false },
  ).render(width);
  expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
  return rows.map((row) => stripTerminalSequences(row).trimEnd()).join("\n");
}

beforeEach(() => initTheme("dark"));

describe("trace cleanup rendering", () => {
  it.each<{ name: string; value: unknown }>([
    { name: "one read", value: read("one.ts") },
    { name: "two reads", value: [read("one.ts"), read("two.ts")] },
    {
      name: "paged reads",
      value: [read("one.ts"), read("two.ts", { hasMore: true, totalLines: 12 })],
    },
    { name: "process", value: processResult() },
    { name: "failed process", value: processResult(2) },
    { name: "truncated process", value: { ...processResult(), truncated: true } },
    { name: "compound with nested failure", value: { counts: [4, 27], sum: processResult(2) } },
    { name: "multiline string", value: "ONE\nTWO" },
  ])("defers $name bodies without changing summaries or outcomes", ({ value }) => {
    const before = JSON.stringify(value);
    const summary = renderResultValue(value, theme, undefined, false);
    const detail = renderResultValue(value, theme);
    expect(summary).toMatchObject({ kind: detail?.kind, summary: detail?.summary });
    expect(summary?.outcome).toBe(detail?.outcome);
    expect(summary?.lines).toEqual([]);
    expect(detail?.lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each<{ name: string; value: unknown; visible: string }>([
    { name: "number", value: 42, visible: "42" },
    { name: "zero", value: 0, visible: ": 0" },
    { name: "false", value: false, visible: "false" },
    { name: "tab stays expanded-only", value: "before\tafter", visible: "Returned string (" },
    {
      name: "non-finite value does not become a null preview",
      value: Infinity,
      visible: "Returned number (",
    },
    {
      name: "wide scalar stays expanded-only",
      value: "界".repeat(40),
      visible: "Returned string (",
    },
    { name: "empty string", value: "", visible: '""' },
    { name: "short stdout", value: processResult(), visible: 'stdout: "31"' },
    { name: "homogeneous reads", value: [read("one.ts"), read("two.ts")], visible: "Read 2 files" },
  ])("exposes $name in collapsed views at realistic widths", ({ value, visible }) => {
    for (const width of [60, 80, 120]) expect(render(value, false, {}, width)).toContain(visible);
  });

  it("keeps large scalars and unfamiliar fields available on expansion", () => {
    const text = "界".repeat(80) + "TAIL_SENTINEL";
    expect(render(text, false)).not.toContain("TAIL_SENTINEL");
    expect(render(text, true, {}, 60)).toContain("TAIL_SENTINEL");
    const value = { ...read("one.ts"), unfamiliar: "UNKNOWN_SENTINEL" };
    const expanded = render(value, true);
    expect(expanded).toContain("UNKNOWN_SENTINEL");
    expect(expanded).toContain("FILE_SENTINEL");
  });

  it("replays recorded timing without inventing a clock for legacy entries", () => {
    const metadata = {
      timings: { totalMs: 75, phases: { formatting: 5, validation: 10, execution: 60 } },
    };
    expect(render(42, false, metadata)).toContain("75ms");
    const before = render(42, true, metadata);
    expect(before).toContain("10ms validation");
    expect(before).toBe(render(42, true, metadata));
    expect(render(42, false)).toContain("time unavailable");
  });

  it.each<{
    name: string;
    timings: { totalMs: number; phases: Record<string, number> };
    ranking: string;
  }>([
    {
      name: "execution dominates with minor and zero phases aggregated",
      timings: {
        totalMs: 1071,
        phases: {
          formatting: 1,
          preparation: 0,
          validation: 67,
          compilation: 3,
          execution: 1000,
          commit: 0,
          result: 0,
        },
      },
      ranking: "1.1s total: 1.0s execution, 67ms validation, 4ms rest",
    },
    {
      name: "validation dominates instead of execution",
      timings: {
        totalMs: 840,
        phases: { execution: 200, compilation: 20, formatting: 10, validation: 610 },
      },
      ranking: "840ms total: 610ms validation, 200ms execution, 30ms rest",
    },
    {
      name: "three phases fit without an aggregate or repeated detail",
      timings: { totalMs: 75, phases: { formatting: 5, validation: 10, execution: 60 } },
      ranking: "75ms total: 60ms execution, 10ms validation, 5ms formatting",
    },
    {
      name: "ties retain their recorded order",
      timings: { totalMs: 12, phases: { formatting: 4, execution: 4, validation: 4 } },
      ranking: "12ms total: 4ms formatting, 4ms execution, 4ms validation",
    },
    {
      name: "zero measurements remain distinct from absent phases",
      timings: { totalMs: 0, phases: { formatting: 0, validation: 0 } },
      ranking: "0ms total: 0ms formatting, 0ms validation",
    },
    {
      name: "recorded total is not replaced by an incomplete phase sum",
      timings: { totalMs: 90, phases: { execution: 30, validation: 20 } },
      ranking: "90ms total: 30ms execution, 20ms validation",
    },
    {
      name: "unknown phase names survive",
      timings: { totalMs: 15, phases: { execution: 10, future: 5 } },
      ranking: "15ms total: 10ms execution, 5ms future",
    },
  ])("ranks invocation costs: $name", ({ timings, ranking }) => {
    const before = structuredClone(timings);
    for (const width of [60, 80, 120]) {
      const output = render(42, true, { timings }, width).replace(/\s+/g, " ").trim();
      expect(output).toContain(ranking);
      expect(output).not.toContain("rest:");
      expect(render(42, false, { timings }, width)).not.toContain("total:");
    }
    expect(timings).toEqual(before);
  });

  it("shows invocation timing on one uniformly muted line without emphasis", () => {
    const styledTheme = {
      fg: (color: string, text: string) => `\x1b[${color === "muted" ? 90 : 37}m${text}\x1b[39m`,
      bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    };
    const rows = renderTypeScriptToolResult(
      {
        content: [],
        details: {
          value: 42,
          truncated: false,
          timings: {
            totalMs: 840,
            phases: { execution: 200, compilation: 20, formatting: 10, validation: 610 },
          },
        },
      },
      { expanded: true, isPartial: false },
      styledTheme,
      { executionStarted: false },
    ).render(120);
    const timingStart = rows.findIndex((row) => row.includes("840ms total"));
    expect(timingStart).toBeGreaterThanOrEqual(0);
    const timingRows = rows
      .slice(timingStart)
      .filter((row) => stripTerminalSequences(row).trim())
      .map((row) => row.trimEnd());
    expect(timingRows).toEqual([
      styledTheme.fg("muted", "840ms total: 610ms validation, 200ms execution, 30ms rest"),
    ]);
  });

  it("joins by sequence, preserves nested attribution and distinct processes, and avoids duplicate sections", () => {
    const traces = [
      trace(7, { function: { invocationId: 2, name: "sumFiles", scope: "project", depth: 1 } }),
    ];
    const progress: ShellProgress[] = [
      {
        id: 1,
        traceSequence: 7,
        command: "wc one.txt",
        status: "done",
        code: 0,
        output: "4 one.txt",
      },
      {
        id: 2,
        traceSequence: 7,
        command: "wc two.txt",
        status: "done",
        code: 0,
        output: "27 two.txt",
      },
    ];
    for (const width of [60, 80, 120]) {
      const output = render(31, true, { traces, progress }, width);
      expect(output).toContain("project function sumFiles");
      expect(output).toContain("68ms");
      expect(output.match(/wc one.txt/g)).toHaveLength(1);
      expect(output.match(/wc two.txt/g)).toHaveLength(1);
      expect(output).toContain("4 one.txt");
      expect(output).toContain("27 two.txt");
      expect(output).not.toContain("Retained process output");
    }
  });

  it("does not group distinct linked calls or infer joins from legacy IDs", () => {
    const traces = [trace(1), trace(2)];
    const progress: ShellProgress[] = [
      { id: 20, traceSequence: 1, command: "first", status: "done", code: 0, output: "FIRST" },
      { id: 21, traceSequence: 2, command: "second", status: "done", code: 0, output: "SECOND" },
      { id: 1, command: "legacy", status: "done", code: 0, output: "LEGACY" },
      { id: 22, traceSequence: 999, command: "pruned", status: "done", code: 0, output: "ORPHAN" },
    ];
    const output = render(null, true, { traces, progress });
    expect(output.match(/shell.execFile/g)).toHaveLength(2);
    for (const text of ["FIRST", "SECOND", "LEGACY", "ORPHAN"]) expect(output).toContain(text);
    expect(output).toContain("Retained process output");
  });

  it("retains an early nonzero process and active output in a bounded live dashboard", () => {
    const traces = Array.from({ length: 16 }, (_, index) => trace(index + 1));
    const progress: ShellProgress[] = traces.map((entry) => ({
      id: entry.sequence,
      traceSequence: entry.sequence,
      command: `job-${entry.sequence}`,
      status: "done",
      code: entry.sequence === 1 ? 2 : 0,
      output: entry.sequence === 1 ? "EARLY_FAILURE" : "",
    }));
    progress[1] = {
      id: 2,
      traceSequence: 2,
      command: "active-job",
      status: "running",
      output: "ACTIVE_OUTPUT",
    };
    const output = renderExecutionDashboard({ traces, progress }, theme);
    expect(output).toContain("EARLY_FAILURE");
    expect(output).toContain("[exit 2]");
    expect(output).toContain("ACTIVE_OUTPUT");
    expect(output).toContain("hidden while running");
    expect(output).not.toContain("job-3");
  });

  it("settles unfinished process output honestly and retains failure diagnostics", () => {
    const details = {
      value: undefined,
      truncated: false,
      timings: { totalMs: 100, phases: { execution: 100 } },
      traces: [trace(9, { status: "failed" })],
      progress: [
        {
          id: 1,
          traceSequence: 9,
          command: "interrupted",
          status: "running",
          output: "LAST_DIAGNOSTIC",
        },
      ],
      failure: { kind: "cancelled", rootError: "Cancelled by user", functionPath: [] },
    };
    const output = renderTypeScriptToolResult(
      { content: [], details },
      { expanded: true, isPartial: false },
      theme,
      { isError: true, executionStarted: false },
    )
      .render(80)
      .map(stripTerminalSequences)
      .join("\n");
    expect(output).toContain("Cancelled");
    expect(output).toContain("100ms");
    expect(output).toContain("unfinished when invocation ended");
    expect(output).toContain("LAST_DIAGNOSTIC");
  });
});
