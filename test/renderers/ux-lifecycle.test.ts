import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderTypeScriptToolCall } from "../../src/renderers/typescript-tool-call.js";
import { renderTypeScriptToolResult } from "../../src/renderers/typescript-tool.js";
import { generationTiming } from "../../src/tool/timing.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const options = { expanded: true, isPartial: false };
const plain = (component: { render(width: number): string[] }) =>
  component
    .render(80)
    .map((line) => stripTerminalSequences(line).trimEnd())
    .join("\n");
beforeEach(() => initTheme("dark"));

describe("terminal UX lifecycle and fallback", () => {
  it.each([false, true])(
    "preserves data if presentation metadata is malformed (error=%s)",
    (isError) => {
      const result = {
        content: [{ type: "text", text: "ORIGINAL_SENTINEL" }],
        details: { value: "VALUE_SENTINEL", traces: "invalid metadata" },
      };
      const output = plain(renderTypeScriptToolResult(result, options, theme, { isError }));
      expect(output).toContain("ORIGINAL_SENTINEL");
      expect(output).toContain("VALUE_SENTINEL");
      const collapsed = plain(
        renderTypeScriptToolResult(result, { ...options, expanded: false }, theme, { isError }),
      );
      expect(collapsed).toMatch(/structured view unavailable/i);
      expect(collapsed).toContain("Expand to inspect retained data");
    },
  );

  it("puts settled output ahead of inspectable inputs without duplicating source", () => {
    const args = {
      label: "Read a file",
      code: "async ({}, input) => input.file",
      params: { file: "INPUT_SENTINEL" },
    };
    const context = { args, expanded: true, argsComplete: true, isPartial: false, state: {} };
    const call = plain(renderTypeScriptToolCall(args, theme, context, new Map()));
    const result = plain(
      renderTypeScriptToolResult(
        { content: [], details: { value: "OUTPUT_SENTINEL" } },
        options,
        theme,
        context,
      ),
    );
    expect(call).not.toContain("Source");
    expect(result.indexOf("OUTPUT_SENTINEL")).toBeLessThan(result.indexOf("Inputs"));
    expect(result).toContain("INPUT_SENTINEL");
    expect(result).toContain("Source");
    expect(result).toContain("input.file");
  });

  it("preserves all fallback text blocks and ignores unrelated details", () => {
    const output = plain(
      renderTypeScriptToolResult(
        {
          content: [
            { type: "text", text: "FIRST_SENTINEL" },
            { type: "text", text: "SECOND_SENTINEL" },
          ],
          details: { legacy: true },
        },
        options,
        theme,
        {},
      ),
    );
    expect(output).toContain("FIRST_SENTINEL");
    expect(output).toContain("SECOND_SENTINEL");
    expect(output).not.toContain("undefined");
  });

  it("shows unknown historical timing and clears replay generation timers", () => {
    vi.useFakeTimers();
    try {
      const context = {
        argsComplete: false,
        isPartial: true,
        executionStarted: false,
        state: {},
        invalidate: vi.fn(),
      };
      generationTiming(context);
      expect(vi.getTimerCount()).toBe(1);
      context.argsComplete = true;
      context.isPartial = false;
      expect(generationTiming(context).duration).toBe("time unavailable");
      expect(vi.getTimerCount()).toBe(0);
      const output = plain(
        renderTypeScriptToolResult(
          { content: [], details: { value: true } },
          options,
          theme,
          context,
        ),
      );
      expect(output).toContain("time unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps earlier failures and still-active processes visible during a busy update", () => {
    const progress = Array.from({ length: 8 }, (_, id) => ({
      id,
      command: `command-${id}`,
      status: id === 1 ? "running" : "done",
      code: id === 0 ? 2 : 0,
      output: id === 0 ? "FAILURE_SENTINEL" : "",
    }));
    const output = plain(
      renderTypeScriptToolResult(
        { content: [], details: { progress } },
        { expanded: true, isPartial: true },
        theme,
        {},
      ),
    );
    expect(output).toContain("FAILURE_SENTINEL");
    expect(output).toContain("[running] command-1");
    expect(output).toContain("earlier shell calls omitted");
  });

  it("does not duplicate a returned process log in retained output", () => {
    const output = plain(
      renderTypeScriptToolResult(
        {
          content: [],
          details: {
            value: { stdout: "LOG_SENTINEL", stderr: "", code: 0, truncated: false },
            progress: [
              { id: 1, command: "command", status: "done", code: 0, output: "LOG_SENTINEL" },
            ],
          },
        },
        options,
        theme,
        {},
      ),
    );
    expect(output.match(/LOG_SENTINEL/g)).toHaveLength(1);
    expect(output).toContain("output shown above");
  });

  it("freezes unfinished final traces without claiming they are still running", () => {
    vi.useFakeTimers();
    try {
      const result = {
        content: [],
        details: {
          value: { recovered: true },
          traces: [
            {
              id: 1,
              sequence: 1,
              capability: "shell",
              method: "execFile",
              arguments: [],
              startedAt: Date.now(),
              status: "running",
            },
          ],
        },
      };
      const context = { state: {} };
      const before = plain(renderTypeScriptToolResult(result, options, theme, context));
      vi.advanceTimersByTime(5000);
      const after = plain(renderTypeScriptToolResult(result, options, theme, context));
      expect(after).toBe(before);
      expect(after).toContain("unfinished at end");
      expect(after).not.toContain("●");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports recorded failures even when a helper returns an ordinary summary", () => {
    const output = plain(
      renderTypeScriptToolResult(
        {
          content: [],
          details: {
            value: { recovered: true },
            progress: [{ id: 1, command: "check", status: "done", code: 1, output: "diagnostic" }],
          },
        },
        { expanded: false, isPartial: false },
        theme,
        {},
      ),
    );
    expect(output).toContain("⚠");
    expect(output).toContain("nonzero exits recorded");
  });

  it("prioritizes failed tests in npm summaries", () => {
    const output = plain(
      renderTypeScriptToolResult(
        {
          content: [],
          details: {
            value: { stdout: "Tests 2 failed | 4 passed", stderr: "", code: 1, truncated: false },
          },
        },
        options,
        theme,
        { args: { code: "async ({ npm }) => npm.test()" } },
      ),
    );
    expect(output).toContain("✗ npm test, 2 failed, 4 passed");
    expect(output).toContain("exit: 1");
  });

  it("does not infer provenance from truncated trace history", () => {
    const output = plain(
      renderTypeScriptToolResult(
        {
          content: [],
          details: {
            value: { stdout: "VALUE_SENTINEL", stderr: "", code: 0, truncated: false },
            traces: [
              {
                id: 1,
                sequence: 1,
                capability: "git",
                method: "status",
                arguments: [],
                startedAt: 1,
                durationMs: 1,
                status: "succeeded",
              },
            ],
            tracesTruncated: true,
          },
        },
        options,
        theme,
        { args: { code: "async ({ git }) => git.status()" } },
      ),
    );
    expect(output).toContain("Command exit 0");
    expect(output).not.toContain("Git status");
    expect(output).toContain("VALUE_SENTINEL");
    expect(output).toContain("additional capability traces omitted");
  });

  it.each(
    (["dark", "light"] as const).flatMap((name) => [60, 80, 120].map((width) => ({ name, width }))),
  )(
    "$name theme at $width columns preserves wide, combining, and unbroken content",
    ({ name, width }) => {
      initTheme(name);
      const body = "界e\u0301\t" + "verylongunbrokenidentifier".repeat(8);
      const values: unknown[] = [
        {
          file: "long/界/file.ts",
          format: "hashed",
          content: `1:abc12|${body}`,
          revision: "r",
          lines: 1,
        },
        { stdout: body, stderr: "", code: 1, truncated: false },
        { status: 500, ok: false, headers: {}, body, truncated: false },
        { first: body + "\nnext line", sentinel: "END_SENTINEL" },
      ];
      for (const value of values) {
        const component = renderTypeScriptToolResult(
          { content: [], details: { value } },
          options,
          theme,
          {},
        );
        const rows = component.render(width);
        expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
        component.invalidate();
        expect(component.render(width)).toEqual(rows);
        expect(component.render(40).every((row) => visibleWidth(row) <= 40)).toBe(true);
      }
      const call = renderTypeScriptToolCall(
        { label: "Inspect input", code: "async ({}, input) => input", params: { value: body } },
        theme,
        { expanded: true, argsComplete: true },
        new Map(),
      );
      expect(call.render(width).every((row) => visibleWidth(row) <= width)).toBe(true);
    },
  );
});
