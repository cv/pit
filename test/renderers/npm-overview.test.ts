import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";

import type { CapabilityTrace } from "../../src/execution/capability-trace.js";
import { renderTypeScriptToolResult } from "../../src/renderers/typescript-tool.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const trace = (method: string): CapabilityTrace => ({
  id: 1,
  sequence: 1,
  capability: "npm",
  method,
  arguments: [],
  startedAt: 1,
  durationMs: 10,
  status: "succeeded",
});

interface RenderOptions {
  code?: number;
  expanded?: boolean;
  width?: number;
  nested?: boolean;
}
function renderRows(method: string, payload: unknown, options: RenderOptions = {}): string[] {
  const { code = 0, expanded = true, width = 160, nested = false } = options;
  const value = { stdout: JSON.stringify(payload), stderr: "", code, truncated: false };
  return renderTypeScriptToolResult(
    {
      content: [],
      details: {
        value: nested ? { result: value } : value,
        truncated: false,
        traces: [trace(method)],
      },
    },
    { expanded, isPartial: false },
    theme,
    {},
  ).render(width);
}
const plain = (rows: string[]) => rows.map((row) => stripTerminalSequences(row).trimEnd());
const header = (rows: string[]) => rows.find((row) => row.trim() !== "") ?? "";
const indexOfLabel = (rows: string[], label: string, from = 0) =>
  rows.findIndex((row, index) => index >= from && row.trim() === label);
const leading = (row: string) => row.length - row.trimStart().length;

const audit = {
  auditReportVersion: 2,
  vulnerabilities: {
    "make-dir": {
      severity: "moderate",
      via: ["semver"],
      range: "2.0.0 - 3.1.0",
      fixAvailable: false,
    },
    semver: {
      severity: "moderate",
      via: [{ title: "semver ReDoS", url: "https://github.com/advisories/URL_SENTINEL" }],
      range: "<7.5.2",
      fixAvailable: { name: "eslint", version: "9.0.0", isSemVerMajor: true },
    },
    "@babel/traverse": {
      severity: "critical",
      via: [{ title: "Babel arbitrary code execution when compiling crafted malicious code" }],
      range: "<7.23.2",
      fixAvailable: true,
    },
  },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 2, high: 0, critical: 1, total: 3 } },
};

beforeEach(() => initTheme("dark"));

interface OverviewCase {
  name: string;
  method: string;
  payload: unknown;
  code: number;
  summary: string;
  label: string;
  rows: string[];
  retained: string;
}

describe("npm result overviews", () => {
  it.each<OverviewCase>([
    {
      name: "audit findings, most severe first",
      method: "audit",
      payload: audit,
      code: 1,
      summary: "⚠ npm audit, 3 vulnerabilities (1 critical, 2 moderate)",
      label: "vulnerabilities",
      rows: [
        "critical @babel/traverse <7.23.2: Babel arbitrary code execution when compiling crafted malicious code; fix available",
        "moderate make-dir 2.0.0 - 3.1.0: via semver; no fix available",
        "moderate semver <7.5.2: semver ReDoS; fix: eslint@9.0.0 (semver-major)",
      ],
      retained: "URL_SENTINEL",
    },
    {
      name: "outdated packages, including one not installed",
      method: "outdated",
      payload: {
        esbuild: { wanted: "0.28.2", latest: "0.28.2", dependent: "DEPENDENT_SENTINEL" },
        typescript: { current: "6.0.2", wanted: "6.0.3", latest: "7.0.2" },
      },
      code: 1,
      summary: "⚠ npm outdated, 2 packages",
      label: "packages",
      rows: [
        "esbuild: not installed, wanted 0.28.2, latest 0.28.2",
        "typescript: current 6.0.2, wanted 6.0.3, latest 7.0.2",
      ],
      retained: "DEPENDENT_SENTINEL",
    },
    {
      name: "pack tarball identity, sizes, and file count",
      method: "pack",
      payload: [
        {
          name: "pit",
          version: "0.16.1",
          filename: "pit-0.16.1.tgz",
          size: 6_873_619,
          unpackedSize: 17_872_301,
          files: [{ path: "FILE_SENTINEL", size: 6844, mode: 420 }],
          entryCount: 212,
        },
      ],
      code: 0,
      summary: "✓ npm pack, pit@0.16.1, 212 files",
      label: "tarball",
      rows: ["pit@0.16.1: pit-0.16.1.tgz, 6.9 MB packed, 17.9 MB unpacked, 212 files"],
      retained: "FILE_SENTINEL",
    },
    {
      name: "workspace pack tarballs",
      method: "pack",
      payload: [
        { name: "a", version: "1.0.0", size: 999, files: [] },
        { filename: "b-2.0.0.tgz", shasum: "SHASUM_SENTINEL" },
      ],
      code: 0,
      summary: "✓ npm pack, 2 tarballs",
      label: "tarballs",
      rows: ["a@1.0.0: 999 bytes packed, 0 files", "b-2.0.0.tgz"],
      retained: "SHASUM_SENTINEL",
    },
  ])("$name lead the expanded view before the full stdout", (row) => {
    const collapsed = plain(
      renderRows(row.method, row.payload, { code: row.code, expanded: false }),
    );
    const expanded = plain(renderRows(row.method, row.payload, { code: row.code }));
    expect(header(collapsed).startsWith(row.summary)).toBe(true);
    expect(header(expanded).startsWith(row.summary)).toBe(true);
    const label = indexOfLabel(expanded, row.label);
    const stdout = indexOfLabel(expanded, "stdout", label);
    expect(label).toBeGreaterThan(0);
    expect(expanded.slice(label + 1, stdout).map((line) => line.trim())).toEqual(row.rows);
    expect(expanded.slice(stdout).join("\n")).toContain(row.retained);
  });

  it("shows a clean audit as its complete stdout without an empty overview", () => {
    const expanded = plain(
      renderRows("audit", { vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }),
    );
    expect(header(expanded).startsWith("✓ npm audit, 0 vulnerabilities")).toBe(true);
    expect(indexOfLabel(expanded, "vulnerabilities")).toBe(-1);
    expect(expanded.slice(indexOfLabel(expanded, "stdout")).join("\n")).toContain('"total": 0');
  });

  it("keeps decoded terminal controls and newlines out of overview rows", () => {
    const rows = renderRows(
      "outdated",
      { "\u001b]0;TITLE\u0007evil\npkg": { current: "1.0.0", latest: "2.0.0" } },
      { code: 1 },
    );
    const expanded = plain(rows);
    const label = indexOfLabel(expanded, "packages");
    expect(expanded[label + 1]?.trim()).toBe("evil pkg: current 1.0.0, latest 2.0.0");
    expect(rows.join("\n")).not.toContain("\u0007");
  });

  it.each([
    { name: "directly", nested: false },
    { name: "inside a named object", nested: true },
  ])("wraps overview rows under their text at narrow widths $name", ({ nested }) => {
    const rows = renderRows("audit", audit, { code: 1, width: 60, nested });
    const expanded = plain(rows);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(60);
    const finding = expanded.findIndex((row) => row.trim().startsWith("critical @babel/traverse"));
    const continuation = expanded[finding + 1] ?? "";
    expect(continuation.trim().startsWith("moderate")).toBe(false);
    expect(leading(continuation)).toBe(leading(expanded[finding] ?? "") + 2);
  });
});
