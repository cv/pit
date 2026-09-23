import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";

import { HangingIndentText } from "../../src/renderers/hanging-indent-text.js";
import { renderTypeScriptToolCall } from "../../src/renderers/typescript-tool-call.js";
import { renderTypeScriptToolResult } from "../../src/renderers/typescript-tool.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
beforeEach(() => initTheme("dark"));

describe("implicit hanging indentation", () => {
  it.each([
    { name: "spaces", prefix: "  ", indent: 2 },
    { name: "tab expansion", prefix: "\t", indent: 3 },
    { name: "wide whitespace", prefix: "\u3000", indent: 2 },
  ])("preserves $name on continuation rows", ({ prefix, indent }) => {
    const component = new HangingIndentText(prefix + "alpha beta gamma delta epsilon");
    const rows = component.render(16).map(stripTerminalSequences);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.slice(1).every((row) => row.startsWith(" ".repeat(indent)))).toBe(true);
    expect(rows.every((row) => visibleWidth(row) <= 16)).toBe(true);
    component.invalidate();
    expect(component.render(8).every((row) => visibleWidth(row) <= 8)).toBe(true);
  });

  it("preserves multiline content styles rather than stripping them as gutter styles", () => {
    const component = new HangingIndentText(
      "\u001b[31m  alpha beta gamma delta\n  epsilon zeta eta theta\u001b[39m",
    );
    const rows = component.render(16);
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.every((row) => row.includes("\u001b[31m"))).toBe(true);
    expect(rows.map(stripTerminalSequences).every((row) => row.startsWith("  "))).toBe(true);
  });

  it("still allows an explicit zero indent override", () => {
    const component = new HangingIndentText("  alpha beta gamma delta", { 0: 0 });
    const rows = component.render(12).map(stripTerminalSequences);
    expect(rows[1]?.startsWith("  ")).toBe(false);
  });

  it.each(["call", "result", "partial", "error"] as const)(
    "preserves indentation in %s views",
    (view) => {
      const value = "WRAP_SENTINEL ".repeat(12).trim();
      const options = { expanded: true, isPartial: view === "partial" };
      const component =
        view === "call"
          ? renderTypeScriptToolCall(
              {
                label: "Inspect inputs",
                code: "async ({}, input) => input",
                params: { message: value },
              },
              theme,
              { expanded: true, argsComplete: true },
              new Map(),
            )
          : view === "partial"
            ? renderTypeScriptToolResult(
                {
                  content: [],
                  details: {
                    progress: [
                      { id: 1, command: "fixture", status: "running", output: `  ${value}` },
                    ],
                  },
                },
                options,
                theme,
                {},
              )
            : view === "error"
              ? renderTypeScriptToolResult(
                  { content: [{ type: "text", text: `failure\n  ${value}` }] },
                  options,
                  theme,
                  { isError: true },
                )
              : renderTypeScriptToolResult(
                  { content: [], details: { value: { message: value } } },
                  options,
                  theme,
                  {},
                );
      const rows = component.render(60).map(stripTerminalSequences);
      const wrapped = rows.filter((row) => row.includes("WRAP_SENTINEL"));
      expect(wrapped.length).toBeGreaterThan(1);
      expect(wrapped.every((row) => row.startsWith("  "))).toBe(true);
      expect(rows.every((row) => visibleWidth(row) <= 60)).toBe(true);
    },
  );
});
