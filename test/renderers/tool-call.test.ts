import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupHarness,
  renderToolCall,
  renderToolResult,
  setupHarness,
} from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("tool rendering", () => {
  it("renders generated TypeScript source with collapsed and expanded views", () => {
    const code = Array.from({ length: 15 }, (_, index) => `// source line ${index + 1}`).join("\n");

    const collapsed = renderToolCall(
      { label: "Render generated TypeScript", code, timeoutMs: 5000 },
      { expanded: false, argsComplete: true },
    );
    const collapsedLines = collapsed.split("\n");
    expect(collapsedLines[0]).toContain("Render generated TypeScript (15 lines, 0.0s)");
    expect(collapsedLines[0]).not.toContain("timeout=");
    expect(collapsedLines[0]).toContain("\u001b[1m");
    expect(collapsedLines[0]).toContain("› ");
    expect(collapsedLines).toHaveLength(1);
    expect(collapsed).not.toContain("source line 1");
    expect(collapsed).not.toContain("more lines");

    const expanded = renderToolCall({ code }, { expanded: true, argsComplete: true });
    expect(expanded).toContain("Run workspace task (15 lines, 0.0s)");
    expect(expanded).toContain("source line 15");
    expect(expanded).not.toContain("more lines");
    expect(expanded.split("\n")[1]).toContain("source line 1");

    const singleLine = renderToolCall(
      { code: "return 1" },
      { expanded: false, argsComplete: true },
    );
    expect(singleLine).toContain("1 line, 0.0s)");

    const saveOnly = renderToolCall(
      { code: "async function later() {}", saveOnly: true },
      { expanded: false, argsComplete: true },
    );
    expect(saveOnly).toContain("Save later (1 line, 0.0s)");
    expect(saveOnly).toContain("save-only");

    const empty = renderToolCall({ code: "" }, { expanded: false, argsComplete: true });
    expect(empty).not.toContain("empty source");
    const expandedEmpty = renderToolCall({ code: "" }, { expanded: true, argsComplete: true });
    expect(expandedEmpty).toContain("empty source");
    expect(expandedEmpty.split("\n")[1]).toContain("empty source");

    const partial = renderToolCall({ code: undefined }, { expanded: false, argsComplete: false });
    expect(partial).toContain("generating... 0.0s");
    expect(partial).not.toContain("waiting for source…");
    expect(partial).toContain("⠋ ");
    const inferred = renderToolCall(
      {
        label: "  \n ",
        code: 'async ({ workspace }) => workspace.read("README.md")',
      },
      { expanded: false, argsComplete: true },
    );
    expect(inferred).toContain("Read workspace files");

    const git = renderToolCall(
      { code: 'async ({ git }) => git.status(["--short"])' },
      { expanded: false, argsComplete: true },
    );
    expect(git).toContain("Inspect Git status");

    const named = renderToolCall(
      { code: "async function buildProject() { return true; }" },
      { expanded: false, argsComplete: true },
    );
    expect(named).toContain("Define and run buildProject");

    const waiting = renderToolCall({ code: undefined }, { expanded: true, argsComplete: false });
    expect(waiting).toContain("waiting for source…");
    expect(waiting.split("\n")[1]).toContain("waiting for source…");
  });

  it("re-renders completed source with Oxfmt formatting", async () => {
    const args = {
      code: 'async({workspace,git})=>{const[file,status]=await Promise.all([workspace.read("package.json",{format:"raw"}),git.status(["--short"])]);return{file,status}}',
    };
    const state = {};
    const invalidate = vi.fn();
    const context = { expanded: true, argsComplete: true, state, invalidate };

    const initial = renderToolCall(args, context);
    expect(initial).toContain("const[file,status]");
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledOnce());

    const formatted = renderToolCall(args, context);
    expect(formatted).toContain("const [file, status] = await Promise.all([");
    expect(formatted).toContain("return { file, status };");
    expect(formatted).toContain("7 lines, 0.0s");
  });

  it("keeps incomplete streaming source raw", async () => {
    const state = {};
    const invalidate = vi.fn();
    const source = "async({workspace})=>workspace.read(";
    const context = { expanded: true, argsComplete: false, state, invalidate };

    expect(renderToolCall({ code: source }, context)).toContain(source);
    await Promise.resolve();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("keeps hidden call and result descriptions on adjacent lines", () => {
    const call = renderToolCall(
      { label: "Render generated TypeScript", code: "return value" },
      { expanded: false, argsComplete: true },
    );
    const result = renderToolResult(
      { content: [], details: { value: { value: true }, truncated: false } },
      { expanded: false, isPartial: false },
    );

    expect(`${call}\n${result}`.split("\n")).toHaveLength(2);
  });

  it("animates generation every 200ms and freezes timing when generation completes", () => {
    vi.useFakeTimers();
    try {
      const state = {};
      const invalidate = vi.fn();
      const context = { expanded: false, argsComplete: false, state, invalidate };

      expect(renderToolCall({ code: undefined }, context)).toContain(
        "⠋ Run workspace task (generating... 0.0s)",
      );
      vi.advanceTimersByTime(400);
      expect(invalidate).toHaveBeenCalledTimes(2);
      expect(renderToolCall({ code: undefined }, context)).toContain(
        "⠹ Run workspace task (generating... 0.4s)",
      );

      const completed = renderToolCall({ code: "return 1" }, { ...context, isPartial: false });
      expect(completed).toContain("1 line, 0.4s");
      vi.advanceTimersByTime(400);
      expect(invalidate).toHaveBeenCalledTimes(2);
      const executionStarted = renderToolCall(
        { code: "return 1" },
        { expanded: false, argsComplete: false, executionStarted: true, state: {} },
      );
      expect(executionStarted).toContain("1 line, 0.0s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("animates execution every 200ms and freezes timing on the final result", () => {
    vi.useFakeTimers();
    try {
      const state = {};
      const invalidate = vi.fn();
      const context = { state, invalidate, args: { label: "Run command", code: "" } };
      const partialResult = { content: [], details: undefined };

      const started = renderToolResult(
        partialResult,
        { expanded: false, isPartial: true },
        context,
      );
      expect(started).toContain("⠋ Running... (0.0s)");
      expect(started).not.toContain("Run command");
      vi.advanceTimersByTime(400);
      expect(invalidate).toHaveBeenCalledTimes(2);
      expect(
        renderToolResult(partialResult, { expanded: false, isPartial: true }, context),
      ).toContain("⠹ Running... (0.4s)");

      const completed = renderToolResult(
        partialResult,
        { expanded: false, isPartial: false },
        context,
      );
      expect(completed).toContain("No returned value (0 lines, 0.4s)");
      vi.advanceTimersByTime(400);
      expect(invalidate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
