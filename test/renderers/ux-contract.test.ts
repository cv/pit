import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CapabilityTrace } from "../../src/execution/capability-trace.js";
import { processOutputLines, sanitizeProcessText } from "../../src/process/results.js";
import { GIT_RESULT_RENDERERS } from "../../src/renderers/git-result.js";
import { renderTypeScriptToolCall } from "../../src/renderers/typescript-tool-call.js";
import { renderTypeScriptToolResult } from "../../src/renderers/typescript-tool.js";
import { structureTypeScriptFailure } from "../../src/tool/failure-context.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const processValue = (stdout = "", code = 0, truncated = false) => ({
  stdout,
  stderr: "",
  code,
  truncated,
});
const trace = (capability: string, method: string, id = 1): CapabilityTrace => ({
  id,
  sequence: id,
  capability,
  method,
  arguments: [],
  startedAt: 1,
  durationMs: 10,
  status: "succeeded",
});
const readValue = {
  file: "src/example.ts",
  format: "hashed",
  content: "1:abc12|export const answer = 42;",
  revision: "REVISION_SENTINEL",
  lines: 1,
};
function render(value: unknown, traces: CapabilityTrace[] = [], expanded = true, width = 80) {
  return renderTypeScriptToolResult(
    { content: [], details: { value, truncated: false, traces } },
    { expanded, isPartial: false },
    theme,
    {},
  )
    .render(width)
    .map((line) => stripTerminalSequences(line).trimEnd())
    .join("\n");
}

beforeEach(() => initTheme("dark"));

interface OutcomeCase {
  name: string;
  value: unknown;
  marker: string;
  capability?: string;
  method?: string;
}
const outcomes: OutcomeCase[] = [
  {
    name: "Git diff differences",
    value: processValue("", 1),
    marker: "⚠",
    capability: "git",
    method: "diff",
  },
  { name: "nonzero shell", value: processValue("failure", 2), marker: "✗" },
  {
    name: "failed Git",
    value: processValue("fatal", 128),
    marker: "✗",
    capability: "git",
    method: "status",
  },
  {
    name: "HTTP error",
    value: { status: 503, ok: false, body: "unavailable", headers: {}, truncated: false },
    marker: "✗",
  },
  {
    name: "mixed batch",
    value: { results: [{ kind: "read", index: 0, ok: false, error: "missing.ts" }] },
    marker: "✗",
  },
  { name: "truncated read", value: { ...readValue, truncated: true }, marker: "⚠" },
  { name: "paged read", value: { ...readValue, hasMore: true, totalLines: 20 }, marker: "⚠" },
  { name: "truncated glob", value: { entries: ["a.ts"], truncated: true }, marker: "⚠" },
  {
    name: "incomplete search",
    value: { matches: [], filesSearched: 10, filesSkipped: 1, truncated: false },
    marker: "⚠",
  },
  { name: "truncated process", value: processValue("partial", 0, true), marker: "⚠" },
  {
    name: "npm audit finding",
    value: processValue(
      JSON.stringify({ metadata: { vulnerabilities: { total: 1, high: 1 } } }),
      1,
    ),
    marker: "⚠",
    capability: "npm",
    method: "audit",
  },
  {
    name: "npm outdated finding",
    value: processValue(JSON.stringify({ pit: { current: "1", latest: "2" } }), 1),
    marker: "⚠",
    capability: "npm",
    method: "outdated",
  },
  {
    name: "npm outdated command failure",
    value: processValue(JSON.stringify({ error: { message: "offline" } }), 1),
    marker: "✗",
    capability: "npm",
    method: "outdated",
  },
  {
    name: "GitHub failed check",
    value: processValue(JSON.stringify({ statusCheckRollup: [{ conclusion: "FAILURE" }] })),
    marker: "⚠",
    capability: "gh",
    method: "prView",
  },
  { name: "empty successful process", value: processValue(), marker: "✓" },
];

describe("terminal UX contract", () => {
  it.each(
    outcomes.flatMap((row) =>
      (["direct", "array", "object"] as const).map((wrapper) =>
        Object.assign({}, row, { wrapper }),
      ),
    ),
  )(
    "$name / $wrapper preserves outcome when collapsed and expanded",
    ({ value, marker, capability, method, wrapper }) => {
      const wrapped =
        wrapper === "array" ? [value] : wrapper === "object" ? { result: value } : value;
      const traces = capability && method ? [trace(capability, method)] : [];
      for (const expanded of [false, true])
        expect(render(wrapped, traces, expanded).trimStart()[0]).toBe(marker);
    },
  );

  it.each([
    {
      name: "GitHub arbitrary array",
      capability: "gh",
      method: "api",
      payload: [{ filename: "FILE_SENTINEL", patch: "PATCH_SENTINEL" }],
    },
    {
      name: "GitHub fields beyond eight",
      capability: "gh",
      method: "prView",
      payload: {
        ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`field${i}`, i])),
        sentinel: "FIELD_SENTINEL",
      },
    },
    {
      name: "npm audit remediation",
      capability: "npm",
      method: "audit",
      payload: {
        metadata: { vulnerabilities: { total: 1 } },
        vulnerabilities: { library: { fixAvailable: "FIX_SENTINEL" } },
      },
    },
    {
      name: "npm pack inventory",
      capability: "npm",
      method: "pack",
      payload: [
        { name: "pit", files: [{ path: "FILE_SENTINEL" }] },
        { filename: "SECOND_SENTINEL" },
      ],
    },
    {
      name: "npm outdated extra fields",
      capability: "npm",
      method: "outdated",
      payload: { library: { current: "1", wanted: "2", location: "LOCATION_SENTINEL" } },
    },
  ])("$name retains every sentinel", ({ capability, method, payload }) => {
    const output = render(
      processValue(JSON.stringify(payload)),
      [trace(capability, method)],
      true,
      120,
    );
    for (const sentinel of JSON.stringify(payload).match(/[A-Z]+_SENTINEL/g) ?? [])
      expect(output).toContain(sentinel);
  });

  it("renders arbitrary API patches as readable multiline data without losing extra fields", () => {
    const output = render(
      processValue(
        JSON.stringify([{ filename: "FILE_SENTINEL", patch: "-before\n+after", reviewed: false }]),
      ),
      [trace("gh", "api")],
    );
    expect(output).toContain("-before\n    +after");
    expect(output).toContain("reviewed: false");
    expect(output).toContain("FILE_SENTINEL");
    expect(output).not.toContain("before\\n+after");
  });

  it("preserves process blank lines and trailing diff spaces", () => {
    expect(processOutputLines(sanitizeProcessText("first  \n\nlast \n"))).toEqual([
      "first  ",
      "",
      "last ",
    ]);
    const rendered = GIT_RESULT_RENDERERS.diff(processValue("@@ -1 +1 @@\n-old\n+new  \n"), {
      theme,
      seen: new WeakSet(),
      depth: 0,
    });
    expect(rendered?.lines.map(stripTerminalSequences)).toContain("+new  ");
  });

  it("distinguishes null, explicit undefined, and fallback text", () => {
    expect(render(null)).toContain("Returned null");
    expect(render(undefined)).toContain("No returned value");
    const fallback = renderTypeScriptToolResult(
      { content: [{ type: "text", text: "hello" }] },
      { expanded: false, isPartial: false },
      theme,
      {},
    )
      .render(80)
      .join("\n");
    expect(fallback).toContain("Returned text");
  });

  it("shows consequential inputs without executing them", () => {
    const registry = new Map();
    const output = renderTypeScriptToolCall(
      {
        label: "Read target",
        code: "async ({}, input) => input.file",
        params: { file: "TARGET_SENTINEL", patch: "OLD_SENTINEL\nNEW_SENTINEL" },
        timeoutMs: 12345,
      },
      theme,
      { expanded: true, argsComplete: true, state: {} },
      registry,
    )
      .render(80)
      .map(stripTerminalSequences)
      .join("\n");
    for (const expected of [
      "Params",
      "TARGET_SENTINEL",
      "OLD_SENTINEL",
      "NEW_SENTINEL",
      "timeoutMs: 12345",
      "Source",
    ])
      expect(output).toContain(expected);
  });

  it("shows a partial-read warning on the batch item as well as the outer result", () => {
    const output = render({
      results: [
        {
          kind: "read",
          index: 0,
          ok: true,
          value: { ...readValue, totalLines: 20, hasMore: true },
        },
      ],
    });
    expect(output.trimStart().startsWith("⚠ Batch")).toBe(true);
    expect(output).toContain("⚠ [0] read");
    expect(output).not.toContain("✓ [0] read");
  });

  it("preserves field ordering and metadata through compound views", () => {
    const output = render({ identity: "FIRST_SENTINEL", read: readValue, last: "LAST_SENTINEL" });
    expect(output.indexOf("FIRST_SENTINEL")).toBeLessThan(output.indexOf("export const"));
    expect(output.indexOf("export const")).toBeLessThan(output.indexOf("LAST_SENTINEL"));
    expect(output).toContain("REVISION_SENTINEL");
    expect(output).not.toContain("\nother\n");
    expect(
      render({ stat: { size: 4, modified: "DATE_SENTINEL", directory: false, file: true } }),
    ).toContain("DATE_SENTINEL");
  });

  it.each([60, 80, 120])(
    "preserves hashed batch continuation indentation at %i columns",
    (width) => {
      const content = '1:abc12|const message = "' + "word ".repeat(50) + '";';
      const output = render(
        { results: [{ kind: "read", index: 0, ok: true, value: { ...readValue, content } }] },
        [],
        true,
        width,
      );
      const rows = output.split("\n");
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
      const source = rows.findIndex((row) => row.includes("1:abc12|"));
      expect(rows[source + 1]).toMatch(/^ {9,}/);
    },
  );

  it("keeps the diagnostic tail and puts the cause ahead of execution bookkeeping", () => {
    const message =
      Array.from({ length: 20 }, (_, i) => `diagnostic ${i}`).join("\n") + "\nCAUSE_SENTINEL";
    const output = renderTypeScriptToolResult(
      {
        content: [{ type: "text", text: message }],
        details: {
          failure: { rootError: message, functionPath: [], kind: "user" },
          traces: [trace("shell", "execFile")],
        },
      },
      { expanded: true, isPartial: false },
      theme,
      { isError: true },
    )
      .render(80)
      .map(stripTerminalSequences)
      .join("\n");
    expect(output).toContain("CAUSE_SENTINEL");
    expect(output.indexOf("diagnostic 0")).toBeLessThan(output.indexOf("Execution"));
    const bounded = structureTypeScriptFailure(
      "FIRST_SENTINEL\n" + "x\n".repeat(100) + "LAST_SENTINEL",
      [],
    );
    expect(bounded.rootError).toContain("FIRST_SENTINEL");
    expect(bounded.rootError).toContain("LAST_SENTINEL");
    expect(bounded.rootError).toContain("not retained");
    expect(Buffer.byteLength(bounded.rootError)).toBeLessThanOrEqual(8000);
  });

  it("does not silently drop an earlier failed trace", () => {
    const traces = Array.from({ length: 20 }, (_, i) =>
      trace("git", i % 2 ? "status" : "diff", i + 1),
    );
    traces[0] = { ...trace("shell", "execFile"), status: "failed" };
    const output = render({ recovered: true }, traces);
    expect(output).toContain("shell.execFile failed");
    expect(output.indexOf('"recovered"')).toBeLessThan(output.indexOf("Execution"));
    expect(output).not.toContain("✓ git.status succeeded");
  });

  it("retains process diagnostics after the returned summary settles", () => {
    const output = renderTypeScriptToolResult(
      {
        content: [],
        details: {
          value: { complete: true },
          progress: [
            { id: 1, command: "check", status: "done", code: 1, output: "DIAGNOSTIC_SENTINEL" },
          ],
        },
      },
      { expanded: true, isPartial: false },
      theme,
      {},
    )
      .render(80)
      .map(stripTerminalSequences)
      .join("\n");
    expect(output).toContain("DIAGNOSTIC_SENTINEL");
    expect(output).toContain("[exit 1] check");
  });

  it("stops a live timer and reports cancellation even on a partial error", () => {
    vi.useFakeTimers();
    try {
      const context = { state: {}, invalidate: vi.fn(), isError: false };
      renderTypeScriptToolResult(
        { content: [] },
        { expanded: true, isPartial: true },
        theme,
        context,
      );
      expect(vi.getTimerCount()).toBe(1);
      context.isError = true;
      const output = renderTypeScriptToolResult(
        { content: [], details: { failure: { rootError: "cancelled", kind: "cancelled" } } },
        { expanded: true, isPartial: true },
        theme,
        context,
      )
        .render(80)
        .join("\n");
      expect(output).toContain("Cancelled");
      expect(output).not.toContain("Running...");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([60, 80, 120])(
    "sanitizes hostile controls without mutating data at %i columns",
    (width) => {
      const value = {
        status: 200,
        ok: true,
        headers: { "x-test": "\u001b]52;c;secret\u0007header" },
        body: "body\u001b[2J",
        truncated: false,
      };
      const original = JSON.stringify(value);
      const output = render(value, [], true, width);
      expect(output).not.toContain("secret");
      expect(output).not.toContain("\u001b");
      expect(output).toContain("body");
      expect(JSON.stringify(value)).toBe(original);
    },
  );
});
