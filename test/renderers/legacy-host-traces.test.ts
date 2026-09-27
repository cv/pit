import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";

import { renderTypeScriptToolResult } from "../../src/renderers/typescript-tool.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const stdout = JSON.stringify({
  pit: { current: "1.0.0", latest: "2.0.0", extra: "RETAINED_LEGACY_FIELD" },
});
const value = { stdout, stderr: "", code: 1, truncated: false };
const trace = {
  id: 1,
  sequence: 1,
  method: "outdated",
  arguments: [],
  startedAt: 100,
  durationMs: 10,
  status: "succeeded",
};
const resultFor = (entry: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  details: { value, truncated: false, traces: [entry], timings: { totalMs: 10, phases: {} } },
});

beforeEach(() => initTheme("dark"));

describe("historical host-call trace replay", () => {
  const compactTokens = ["⚠ npm"];
  const expandedTokens = ["⚠ npm", "RETAINED_LEGACY_FIELD", "npm.outdated"];
  it.each<{ name: string; width: number; expanded: boolean; expected: string[] }>([
    { name: "collapsed at 60 columns", width: 60, expanded: false, expected: compactTokens },
    { name: "collapsed at 80 columns", width: 80, expanded: false, expected: compactTokens },
    { name: "collapsed at 120 columns", width: 120, expanded: false, expected: compactTokens },
    { name: "expanded at 60 columns", width: 60, expanded: true, expected: expandedTokens },
    { name: "expanded at 80 columns", width: 80, expanded: true, expected: expandedTokens },
    { name: "expanded at 120 columns", width: 120, expanded: true, expected: expandedTokens },
  ])("preserves domain outcomes and retained data $name", ({ width, expanded, expected }) => {
    const legacy = resultFor({ ...trace, capability: "npm" });
    const original = structuredClone(legacy);
    const current = resultFor({ ...trace, namespace: "npm" });
    const render = (result: typeof legacy) =>
      renderTypeScriptToolResult(result, { expanded, isPartial: false }, theme, {})
        .render(width)
        .map(stripTerminalSequences);
    const rows = render(legacy);
    expect(rows).toEqual(render(current));
    for (const token of expected) expect(rows.join("\n")).toContain(token);
    expect(rows.join("\n")).not.toContain("Structured view unavailable");
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
    expect(legacy).toEqual(original);
  });

  it("accepts matching transition fields without rewriting retained data", () => {
    const result = resultFor({ ...trace, namespace: "npm", capability: "npm" });
    const original = structuredClone(result);
    const text = renderTypeScriptToolResult(result, { expanded: true, isPartial: false }, theme, {})
      .render(80)
      .join("\n");
    expect(text).toContain("⚠ npm");
    expect(stripTerminalSequences(text).replace(/\s/g, "")).toContain("RETAINED_LEGACY_FIELD");
    expect(result).toEqual(original);
  });

  it.each<{ name: string; entry: unknown }>([
    { name: "null trace", entry: null },
    { name: "array trace", entry: [] },
    { name: "string trace", entry: "not a trace" },
    { name: "missing identity", entry: { ...trace } },
    { name: "invalid canonical identity", entry: { ...trace, namespace: 42, capability: "npm" } },
    { name: "conflicting identities", entry: { ...trace, namespace: "shell", capability: "npm" } },
  ])("keeps raw diagnostics rather than guessing for $name", ({ entry }) => {
    const result = resultFor(entry);
    const original = structuredClone(result);
    const text = renderTypeScriptToolResult(result, { expanded: true, isPartial: false }, theme, {})
      .render(80)
      .join("\n");
    expect(text).toContain("Structured view unavailable");
    expect(stripTerminalSequences(text).replace(/\s/g, "")).toContain("RETAINED_LEGACY_FIELD");
    expect(result).toEqual(original);
  });
});
