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
      line: "✗ shell.exec failed, 0.5s",
    },
    {
      name: "a rejected call",
      traces: [trace(1, "execFile", "rejected", 0, 0)],
      settled: false,
      line: "✗ shell.execFile rejected, 0.0s",
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
});
