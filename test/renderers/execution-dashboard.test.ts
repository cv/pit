import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CapabilityTrace } from "../../src/execution/capability-trace.js";
import { renderExecutionDashboard } from "../../src/renderers/execution-dashboard.js";

const theme = { fg: (_color: string, text: string) => text };
const NOW = 20_000;

function trace(
  sequence: number,
  method: string,
  status: CapabilityTrace["status"],
  startedAt: number,
  durationMs?: number,
): CapabilityTrace {
  return {
    id: sequence,
    sequence,
    capability: "shell",
    method,
    arguments: [],
    startedAt,
    ...(durationMs === undefined ? {} : { durationMs }),
    status,
  };
}

function interleaved(groups: number, firstSequence: number): CapabilityTrace[] {
  return Array.from({ length: groups }, (_, index) =>
    trace(
      firstSequence + index,
      index % 2 === 0 ? "exec" : "execFile",
      "succeeded",
      index * 100,
      50,
    ),
  );
}

function inFunction(entry: CapabilityTrace, invocationId: number, name: string): CapabilityTrace {
  return { ...entry, function: { invocationId, name, scope: "project", depth: 1 } };
}

function rows(text: string): string[] {
  return text.split("\n").slice(1);
}

describe("execution dashboard rendering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each<{ name: string; traces: CapabilityTrace[]; settled: boolean; line: string }>([
    {
      name: "a completed call",
      traces: [trace(1, "exec", "succeeded", 0, 1_500)],
      settled: false,
      line: "· shell.exec completed, 1.5s",
    },
    {
      name: "repeated completed calls",
      traces: [
        trace(1, "exec", "succeeded", 0, 1_000),
        trace(2, "exec", "succeeded", 2_000, 1_000),
      ],
      settled: true,
      line: "· shell.exec completed ×2 over 3.0s",
    },
    {
      name: "a live running call",
      traces: [trace(1, "exec", "running", NOW - 2_000)],
      settled: false,
      line: "● shell.exec running, 2.0s",
    },
    {
      name: "a live mixed group",
      traces: [
        trace(1, "exec", "succeeded", 1_000, 100),
        trace(2, "exec", "succeeded", 6_000, 100),
        trace(3, "exec", "running", 11_000),
      ],
      settled: false,
      line: "● shell.exec 2 completed, 1 running over 19.0s",
    },
    {
      name: "a settled unfinished call without a finish time",
      traces: [trace(1, "exec", "running", NOW - 2_000)],
      settled: true,
      line: "? shell.exec unfinished at end",
    },
    {
      name: "a settled mixed group without a finish time",
      traces: [trace(1, "exec", "succeeded", 1_000, 100), trace(2, "exec", "running", 11_000)],
      settled: true,
      line: "? shell.exec 1 completed, 1 unfinished at end",
    },
    {
      name: "a failed call",
      traces: [trace(1, "exec", "failed", 0, 500)],
      settled: true,
      line: "✗ shell.exec failed, 500ms",
    },
    {
      name: "a rejected call",
      traces: [trace(1, "execFile", "rejected", 0, 0)],
      settled: false,
      line: "✗ shell.execFile rejected, 0ms",
    },
  ])("words $name from structured call facts", ({ traces, settled, line }) => {
    expect(renderExecutionDashboard({ traces }, theme, settled).trim()).toBe(line);
  });

  it("keeps a settled unfinished view stable as time passes", () => {
    const details = {
      traces: [trace(1, "exec", "succeeded", 1_000, 100), trace(2, "exec", "running", 11_000)],
    };
    const before = renderExecutionDashboard(details, theme, true);
    vi.advanceTimersByTime(60_000);
    expect(renderExecutionDashboard(details, theme, true)).toBe(before);
  });
  it("shows every call group while running when the recent budget suffices", () => {
    const traces = interleaved(12, 1);
    const live = rows(renderExecutionDashboard({ traces }, theme));
    expect(live).toHaveLength(12);
    expect(live.join("\n")).not.toContain("hidden while running");
  });

  it("hides older completed groups while running but keeps failures, active calls, and a count", () => {
    const traces = [
      trace(1, "exec", "succeeded", 0, 50),
      trace(2, "exec", "succeeded", 100, 50),
      trace(3, "execFile", "failed", 200, 100),
      ...interleaved(20, 4),
      trace(24, "spawn", "running", NOW - 1_000),
    ];
    const live = rows(renderExecutionDashboard({ traces }, theme));
    expect(live[0]).toBe("… 11 earlier completed calls hidden while running; listed when finished");
    expect(live[1]).toBe("✗ shell.execFile failed, 100ms");
    expect(live).toHaveLength(14);
    expect(live.at(-1)).toBe("● shell.spawn running, 1.0s");

    const settled = rows(renderExecutionDashboard({ traces }, theme, true));
    expect(settled).toHaveLength(23);
    expect(settled[0]).toMatch(/^· shell\.exec completed ×2 over /);
    expect(settled.join("\n")).not.toContain("hidden while running");
  });

  it("keeps a function header while running only when it still has a visible call", () => {
    const traces = [
      inFunction(trace(1, "exec", "succeeded", 0, 10), 1, "early"),
      {
        ...inFunction(trace(2, "savedFunctionRun", "succeeded", 20, 1), 2, "pure"),
        capability: "__pit",
      },
      ...interleaved(14, 3),
      inFunction(trace(17, "spawn", "succeeded", 2_000, 10), 3, "late"),
    ];
    const live = rows(renderExecutionDashboard({ traces }, theme));
    expect(live[0]).toBe("… 4 earlier completed calls hidden while running; listed when finished");
    expect(live).toContain("↳ project function pure #2");
    expect(live.slice(-2)).toEqual([
      "↳ project function late #3",
      "  · shell.spawn completed, 10ms",
    ]);
    expect(live.join("\n")).not.toContain("function early");
    expect(rows(renderExecutionDashboard({ traces }, theme, true))).toContain(
      "↳ project function early #1",
    );
  });
});
