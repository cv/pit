import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";

import { renderStructuredData } from "../../src/renderers/compound.js";
import { renderTypeScriptInputs } from "../../src/renderers/typescript-tool-call.js";
import { renderTypeScriptToolResult } from "../../src/renderers/typescript-tool.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const options = { expanded: true, isPartial: false };
const plain = (component: { render(width: number): string[] }) =>
  component
    .render(120)
    .map((row) => stripTerminalSequences(row).trimEnd())
    .join("\n");
beforeEach(() => initTheme("dark"));

describe("renderer inspection boundaries", () => {
  it.each(["audit", "outdated", "pack"])(
    "does not reinterpret truncated npm %s JSON as a full result",
    (method) => {
      const stdout = '{"field":"KEEP_SENTINEL"}';
      const output = plain(
        renderTypeScriptToolResult(
          { content: [], details: { value: { stdout, stderr: "", code: 0, truncated: true } } },
          options,
          theme,
          { args: { code: `async ({ npm }) => npm.${method}()` } },
        ),
      );
      expect(output).toContain("⚠");
      expect(output).toContain("truncated");
      expect(output).toContain(stdout);
    },
  );

  it.each([
    {
      name: "complete JSON",
      stdout: JSON.stringify({ note: "FIRST_SENTINEL\nLAST_SENTINEL" }),
      expected: "LAST_SENTINEL",
    },
    { name: "malformed JSON", stdout: "[INCOMPLETE_SENTINEL", expected: "[INCOMPLETE_SENTINEL" },
  ])("keeps generic process $name readable", ({ stdout, expected }) => {
    const output = plain(
      renderTypeScriptToolResult(
        { content: [], details: { value: { stdout, stderr: "", code: 0, truncated: false } } },
        options,
        theme,
        {},
      ),
    );
    expect(output).toContain(expected);
    expect(output).not.toContain("[object Object]");
  });

  it("warns about an incomplete successful HTTP response", () => {
    const output = plain(
      renderTypeScriptToolResult(
        {
          content: [],
          details: {
            value: { status: 200, ok: true, headers: {}, body: "partial", truncated: true },
          },
        },
        options,
        theme,
        {},
      ),
    );
    expect(output).toContain("⚠ Received HTTP 200, truncated");
    expect(output).toContain("partial");
  });

  it("shows timeout diagnostics, unfinished calls, unknown exits, and capture limits", () => {
    const output = plain(
      renderTypeScriptToolResult(
        {
          content: [],
          details: {
            failure: {
              kind: "timeout",
              rootError: "Timed out while checking target",
              functionPath: [],
            },
            progress: [
              { id: 1, command: "check target", status: "running", output: "LAST_DIAGNOSTIC" },
              { id: 2, command: "legacy command", status: "done", output: "" },
            ],
            progressTruncated: true,
          },
        },
        options,
        theme,
        { isError: true },
      ),
    );
    expect(output).toContain("✗ Timed out");
    expect(output).toContain("LAST_DIAGNOSTIC");
    expect(output).toContain("unfinished when invocation ended");
    expect(output).toContain("exit unknown");
    expect(output).toContain("earlier shell calls were not retained");
  });

  it("preserves fallback inputs even when a legacy text block has no text", () => {
    const output = plain(
      renderTypeScriptToolResult(
        { content: [{ type: "text" }], details: { traces: {} } },
        options,
        theme,
        { args: { params: { file: "INPUT_SENTINEL" } } },
      ),
    );
    expect(output).toContain("Structured view unavailable");
    expect(output).toContain("INPUT_SENTINEL");
  });

  it("labels save-only input without interpreting input objects as operation results", () => {
    const output = stripTerminalSequences(
      renderTypeScriptInputs(
        {
          code: "async function later() {}",
          saveOnly: true,
          functionId: "project.later",
          params: { stdout: "VALUE_SENTINEL", stderr: "", code: 1, truncated: false },
        },
        theme,
        { expanded: true, argsComplete: true },
      ),
    );
    expect(output).toContain("saveOnly: true");
    expect(output).toContain("project.later");
    expect(output).toContain('"code": 1');
    expect(output).toContain("VALUE_SENTINEL");
    expect(output).not.toContain("shell exit");
  });

  it("preserves content with an empty syntax hint", () => {
    const output = renderStructuredData(
      { language: "  ", content: "first\nlast" },
      { theme, seen: new WeakSet(), depth: 0 },
    ).lines.join("\n");
    expect(stripTerminalSequences(output)).toContain("first\n  last");
  });
});
