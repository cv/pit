import { highlightCode } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { display } from "../../src/tool/typescript.js";
import { cleanupHarness, setupHarness, tool } from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const shell = { stdout: "tests passed", stderr: "warning", code: 0, truncated: false };
const renderValue = (resultValue: unknown, source?: string) =>
  tool
    .renderResult?.(
      {
        content: [{ type: "text", text: display(resultValue) }],
        details: { value: resultValue, truncated: false },
      },
      { expanded: true, isPartial: false },
      theme,
      { isError: false, ...(source ? { args: { code: source } } : {}) },
    )
    .render(240)
    .join("\n") ?? "";

describe("result renderers", () => {
  it("renders shell and Git process results", () => {
    const shellOutput = renderValue(shell);
    expect(shellOutput).toContain("Command exit 0");
    expect(shellOutput).toContain("stdout");
    expect(shellOutput).toContain("tests passed");
    expect(shellOutput).toContain("stderr");
    expect(shellOutput).toContain("warning");
    const coloredShell = renderValue({
      stdout: "\u001b[32msuccess\u001b[0m\u001b[2J",
      stderr: "",
      code: 0,
      truncated: false,
    });
    expect(coloredShell).toContain(
      "\u001b[32msuccess\u001b[10;22;23;24;25;27;28;29;39;50;54;55;59;65;75m",
    );
    expect(coloredShell).not.toContain("\u001b[2J");

    const gitOutput = renderValue(shell, 'async ({ git }) => git.status(["--short"])');
    expect(gitOutput).toContain("✓ Git status");
    expect(gitOutput).toContain("Git status, 1 line");
  });

  it("renders workspace read, search, edit, list, and glob results", () => {
    const readOutput = renderValue({
      file: "src/example.ts",
      format: "raw",
      content: "export const answer = 42;",
      revision: "rev-1",
      offset: 5,
      lines: 1,
      totalLines: 10,
      hasMore: true,
    });
    expect(readOutput).toContain("Read src/example.ts, 5-5 of 10, raw, more available");
    expect(readOutput).toContain("revision: rev-1");
    expect(stripTerminalSequences(readOutput)).toContain("export const answer");

    const searchOutput = renderValue({
      matches: [
        {
          file: "src/example.ts",
          revision: "rev-1",
          line: 8,
          anchor: "8:abc",
          column: 3,
          text: "  answer();",
          before: [{ line: 7, anchor: "7:def", text: "function run() {" }],
          after: [{ line: 9, anchor: "9:ghi", text: "}" }],
        },
      ],
      truncated: false,
      filesSearched: 3,
      filesSkipped: 1,
    });
    expect(searchOutput).toContain("Found 1 match, 3 files searched, 1 skipped");
    expect(searchOutput).toContain("src/example.ts:8:3 (8:abc)");
    expect(searchOutput).toContain("> 8    answer();");

    expect(
      renderValue({
        file: "src/example.ts",
        revision: "rev-2",
        applied: 2,
        bytes: 80,
        deleted: false,
      }),
    ).toContain("✓ Edit src/example.ts, updated, 2 changes, 80 bytes");

    const listOutput = renderValue([
      { name: "src", type: "directory" },
      { name: "README.md", type: "file" },
    ]);
    expect(listOutput).toContain("Listed 2 entries");
    expect(listOutput).toContain("[d] src");
    expect(listOutput).toContain("[f] README.md");

    const globOutput = renderValue({
      entries: ["src/index.ts", "src/workspace.ts"],
      truncated: true,
    });
    expect(globOutput).toContain("Listed 2 entries, truncated");
    expect(globOutput).toContain("src/workspace.ts");
  });

  it("renders HTTP, batch, and compound results", () => {
    const httpOutput = renderValue({
      status: 200,
      ok: true,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
      truncated: false,
    });
    expect(httpOutput).toContain("HTTP 200");
    expect(httpOutput).toContain("headers");
    expect(httpOutput).toContain("content-type: application/json");
    expect(httpOutput).toContain('"ok": true');

    const batchOutput = renderValue({
      results: [
        {
          kind: "edit",
          index: 0,
          ok: true,
          value: { file: "a.ts", revision: "r1", applied: 1, bytes: 4, deleted: false },
        },
        { kind: "read", index: 1, ok: false, error: "missing" },
      ],
    });
    expect(batchOutput).toContain("Batch 2 operations, 1 succeeded, 1 failed");
    expect(batchOutput).toContain("✓ [0] edit");
    expect(batchOutput).toContain("a.ts updated");
    expect(batchOutput).toContain("✗ [1] read");
    expect(batchOutput).toContain("missing");

    const compoundOutput = renderValue({
      status: shell,
      sources: { entries: ["a.ts", "b.ts"], truncated: false },
      note: "kept as JSON",
    });
    expect(compoundOutput).toContain("status (shell, exit 0)");
    expect(compoundOutput).toContain("sources (glob, 2 entries)");
    expect(compoundOutput).toContain("note:");
    expect(compoundOutput).toContain('"kept as JSON"');
  });

  it("renders fallback and edge-case result shapes", () => {
    const falsePositive = renderValue({ ...shell, extra: true });
    expect(falsePositive).not.toContain("shell exit 0");
    expect(falsePositive).toContain('"stdout": "tests passed"');
    expect(
      renderValue({ results: [{ kind: "unknown", index: 0, ok: true, value: null }] }),
    ).toContain('"kind": "unknown"');

    const failedShell = renderValue({
      stdout: "",
      stderr: "",
      code: 2,
      truncated: true,
    });
    expect(failedShell).toContain("Command exit 2, truncated");
    expect(failedShell).toContain("(no output)");

    const hashedRead = renderValue({
      file: "README.unknown",
      format: "hashed",
      content: "1:abc|heading",
      revision: "rev-3",
      lines: 1,
      truncated: true,
    });
    expect(hashedRead).toContain("1-1 of 1, hashed, truncated");
    expect(stripTerminalSequences(hashedRead)).toContain("1:abc|heading");
    expect(
      renderValue({
        file: "Makefile",
        format: "raw",
        content: "",
        revision: "rev-4",
        lines: 0,
      }),
    ).toContain("Read Makefile, empty, raw");

    expect(
      renderValue({
        matches: [],
        truncated: true,
        filesSearched: 0,
        filesSkipped: 0,
      }),
    ).toContain("Found 0 matches, 0 files searched, truncated");
    expect(
      renderValue({ file: "old.ts", revision: null, applied: 1, bytes: 0, deleted: true }),
    ).toContain("old.ts, deleted, 1 change, 0 bytes");
    expect(renderValue([{ name: "current", type: "symlink" }])).toContain("[l] current");
    expect(renderValue({ entries: [], truncated: false })).toContain("Listed 0 entries");
    expect(renderValue({ entries: [], truncated: false })).toContain("(no entries)");

    const failedHttp = renderValue({
      status: 503,
      ok: false,
      headers: {},
      body: "[not json",
      truncated: true,
    });
    expect(failedHttp).toContain("HTTP 503, truncated");
    expect(failedHttp).toContain("[not json");
    expect(
      renderValue({ status: 204, ok: true, headers: {}, body: "", truncated: false }),
    ).toContain("(empty body)");

    expect(
      renderValue({
        results: [{ kind: "read", index: 0, ok: true, value: Symbol("nested") }],
      }),
    ).toContain("Symbol(nested)");
    expect(
      renderValue({ size: 12, modified: "2026-01-01T00:00:00.000Z", directory: true, file: false }),
    ).toContain("Stat directory");
    expect(
      renderValue({ size: 8, modified: "2026-01-01T00:00:00.000Z", directory: false, file: true }),
    ).toContain("Stat file");
    expect(
      renderValue({ size: 0, modified: "2026-01-01T00:00:00.000Z", directory: false, file: false }),
    ).toContain("Stat other");

    const recursive: Record<string, unknown> = { status: shell };
    recursive.self = recursive;
    const recursiveOutput = renderValue(recursive);
    expect(recursiveOutput).toContain("status");
    expect(recursiveOutput).toContain("[object Object]");
  });

  it("renders multiline strings as safe, readable recursive sections", () => {
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const render = (value: unknown) =>
      (
        tool
          .renderResult?.(
            {
              content: [{ type: "text", text: display(value) }],
              details: { value, truncated: false },
            },
            { expanded: true, isPartial: false },
            theme,
            { isError: false },
          )
          .render(160) ?? []
      )
        .map((line) => line.trimEnd())
        .join("\n");

    const direct = render("first\r\nsecond\n\u001b[31mthird\u001b[0m\u001b[2J");
    expect(direct).toContain("Returned 3 lines (0.0s)");
    expect(direct).toContain(
      "\nfirst\nsecond\n\u001b[31mthird\u001b[10;22;23;24;25;27;28;29;39;50;54;55;59;65;75m",
    );
    expect(direct).not.toContain("\u001b[2J");
    expect(direct).not.toContain("first\\r\\nsecond");

    const compound = render({ status: "failed", output: "first line\nsecond line", code: 1 });
    expect(compound).toContain("output (text, 2 lines)");
    expect(compound).toContain("\n  first line\n  second line");
    expect(compound).toContain("status:");
    expect(compound).toContain('"failed"');
    expect(stripTerminalSequences(compound)).toContain("code: 1");
    expect(compound).not.toContain('"output":');

    const nested = render({
      rows: [{ id: 1, output: "alpha\nbeta" }, "plain", { id: 2, output: "gamma\ndelta" }],
    });
    expect(nested).toContain("rows (array, 3 items)");
    expect(nested).toContain("[0] (compound, 2 fields)");
    expect(nested).toContain("[1] (json)");
    expect(nested).toContain("[2] (compound, 2 fields)");
    expect(nested).toContain("output (text, 2 lines)");
    expect(nested).toContain("id:");
    expect(stripTerminalSequences(nested)).toContain("id: 1");
    expect(stripTerminalSequences(nested)).toContain("id: 2");

    const nestedRead = render({
      items: [
        {
          file: "README.md",
          format: "hashed",
          content: "1:abc|heading",
          revision: "rev-array",
          lines: 1,
        },
      ],
    });
    expect(nestedRead).toContain("items (array, 1 item)");
    expect(stripTerminalSequences(nestedRead)).toContain("1:abc|heading");

    expect(render("first\rsecond")).toContain("\nfirst\nsecond");
    expect(render({ "\u001b": "first\nsecond" })).toContain("(unnamed) (text, 2 lines)");
  });

  it("syntax highlights multiline sections from semantic hints", () => {
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const render = (value: unknown) =>
      (
        tool
          .renderResult?.(
            {
              content: [{ type: "text", text: display(value) }],
              details: { value, truncated: false },
            },
            { expanded: true, isPartial: false },
            theme,
            { isError: false },
          )
          .render(160) ?? []
      )
        .map((line) => line.trimEnd())
        .join("\n");

    const markdownSource = "# Heading\n- **bold** item";
    const highlightedMarkdown = highlightCode(markdownSource, "markdown");
    const markdownValues: Array<[unknown, string]> = [
      [{ markdown: markdownSource }, "markdown (markdown, 2 lines)"],
      [{ md: [markdownSource] }, "[0] (markdown, 2 lines)"],
      [{ format: "markdown", content: markdownSource }, "content (markdown, 2 lines)"],
      [{ file: "README.md", output: markdownSource }, "output (markdown, 2 lines)"],
      [{ file: "GUIDE.markdown", text: markdownSource }, "text (markdown, 2 lines)"],
    ];
    for (const [value, description] of markdownValues) {
      const output = render(value);
      expect(output).toContain(description);
      for (const line of highlightedMarkdown) {
        expect(output).toContain(line);
      }
    }

    const syntaxValues: Array<[unknown, string, string, string]> = [
      [
        { file: "src/example.ts", output: "const answer = 42;\nconsole.log(answer);" },
        "typescript",
        "output (typescript, 2 lines)",
        "const answer = 42;\nconsole.log(answer);",
      ],
      [
        { format: "py", content: "def answer():\n    return 42" },
        "python",
        "content (python, 2 lines)",
        "def answer():\n    return 42",
      ],
      [
        { language: "json", body: '{\n  "ok": true\n}' },
        "json",
        "body (json, 3 lines)",
        '{\n  "ok": true\n}',
      ],
      [
        { format: "raw", file: "main.go", content: "package main\nfunc main() {}" },
        "go",
        "content (go, 2 lines)",
        "package main\nfunc main() {}",
      ],
      [
        { lang: "shell", script: "echo hello\nprintf '%s\\n' done" },
        "bash",
        "script (bash, 2 lines)",
        "echo hello\nprintf '%s\\n' done",
      ],
      [
        { file: "setup.zsh", content: "export READY=1\necho $READY" },
        "bash",
        "content (bash, 2 lines)",
        "export READY=1\necho $READY",
      ],
      [
        { diff: "@@ -1 +1 @@\n-old value\n+new value" },
        "diff",
        "diff (diff, 3 lines)",
        "@@ -1 +1 @@\n-old value\n+new value",
      ],
      [
        { file: "changes.patch", content: "--- a/file\n+++ b/file\n+added" },
        "diff",
        "content (diff, 3 lines)",
        "--- a/file\n+++ b/file\n+added",
      ],
      [
        { format: "diff", output: "@@ -1 +1 @@\n-before\n+after" },
        "diff",
        "output (diff, 3 lines)",
        "@@ -1 +1 @@\n-before\n+after",
      ],
      [
        { file: "config.toml", content: '[package]\nname = "pit"' },
        "toml",
        "content (toml, 2 lines)",
        '[package]\nname = "pit"',
      ],
    ];
    for (const [value, language, description, source] of syntaxValues) {
      const output = render(value);
      expect(output).toContain(description);
      for (const line of highlightCode(source, language)) {
        expect(output).toContain(line);
      }
    }

    const ordinary = render(["one", "two"]);
    expect(ordinary).toContain('"one"');
    expect(ordinary).not.toContain("[0] (json)");
  });

  it("dims hashed read prefixes and hangs wrapped content under the text column", () => {
    const theme = {
      fg: (color: string, text: string) =>
        color === "dim" ? `\u001b[2m\u001b[90m${text}\u001b[39m\u001b[22m` : text,
      bold: (text: string) => text,
    };
    const readValue = {
      file: "README.md",
      format: "hashed",
      content:
        "12:abc12|alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega",
      revision: "rev-1",
      lines: 1,
      totalLines: 20,
    };
    const render = (value: unknown, width: number) => {
      const component = tool.renderResult?.(
        {
          content: [{ type: "text", text: display(value) }],
          details: { value, truncated: false },
        },
        { expanded: true, isPartial: false },
        theme,
        { isError: false },
      );
      const first = component?.render(width) ?? [];
      const cached = component?.render(width) ?? [];
      expect(cached).toEqual(first);
      component?.invalidate();
      expect(component?.render(width)).toEqual(first);
      return first;
    };

    const direct = render(readValue, 32);
    const directLine = direct.findIndex((line) => line.includes("12:abc12|"));
    expect(directLine).toBeGreaterThan(-1);
    expect(direct[directLine]).toContain("\u001b[2m\u001b[90m12:abc12|\u001b[22m\u001b[39m");
    expect(direct[directLine + 1]?.startsWith(" ".repeat(9))).toBe(true);

    const compound = render({ readme: readValue }, 80);
    const compoundLine = compound.findIndex((line) => line.includes("12:abc12|"));
    expect(
      compound.some((line) => line.includes("readme ") && line.includes("read, README.md")),
    ).toBe(true);
    expect(compound[compoundLine]).toContain("  \u001b[2m\u001b[90m12:abc12|\u001b[22m\u001b[39m");
    expect(compound[compoundLine + 1]?.startsWith(" ".repeat(11))).toBe(true);

    expect(render(readValue, 8).length).toBeGreaterThan(1);
    expect(render({ ...readValue, content: "not-a-hashed-line" }, 40).join("\n")).toContain(
      "not-a-hashed-line",
    );
  });

  it("right-aligns hashed read prefixes to the largest line number", () => {
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const value = {
      file: "README.md",
      format: "hashed",
      content: "1:aaaaa|one\n23:bbbbb|twenty-three\n123:ccccc|one hundred twenty-three",
      revision: "rev-aligned",
      lines: 3,
      totalLines: 123,
    };
    const component = tool.renderResult?.(
      {
        content: [{ type: "text", text: display(value) }],
        details: { value, truncated: false },
      },
      { expanded: true, isPartial: false },
      theme,
      { isError: false },
    );
    const rendered = component?.render(120) ?? [];

    expect(
      stripTerminalSequences(rendered.find((line) => line.includes("1:aaaaa|")) ?? "").trimEnd(),
    ).toBe("  1:aaaaa|one");
    expect(
      stripTerminalSequences(rendered.find((line) => line.includes("23:bbbbb|")) ?? "").trimEnd(),
    ).toBe(" 23:bbbbb|twenty-three");
    expect(
      stripTerminalSequences(rendered.find((line) => line.includes("123:ccccc|")) ?? "").trimEnd(),
    ).toBe("123:ccccc|one hundred twenty-three");
  });

  it("syntax highlights hashed contents independently from their line prefixes", () => {
    const theme = {
      fg: (color: string, text: string) =>
        color === "dim" ? `\u001b[2m\u001b[90m${text}\u001b[39m\u001b[22m` : text,
      bold: (text: string) => text,
    };
    const source = "const answer = 42;\n/* first\nsecond */";
    const prefixes = ["1:aaa|", "2:bbb|", "3:ccc|"];
    const component = tool.renderResult?.(
      {
        content: [{ type: "text", text: source }],
        details: {
          value: {
            file: "src/example.ts",
            format: "hashed",
            content: prefixes
              .map((prefix, index) => `${prefix}${source.split("\n")[index]}`)
              .join("\n"),
            revision: "rev-syntax",
            lines: 3,
          },
          truncated: false,
        },
      },
      { expanded: true, isPartial: false },
      theme,
      { isError: false },
    );
    const rendered = component?.render(120) ?? [];
    const highlighted = wrapTextWithAnsi(highlightCode(source, "typescript").join("\n"), 120);

    for (const [index, prefix] of prefixes.entries()) {
      const line = rendered.find((candidate) => candidate.includes(prefix));
      expect(line).toContain(`\u001b[2m\u001b[90m${prefix}\u001b[22m`);
      const expectedLine = highlighted[index] as string;
      expect(line).toContain(
        expectedLine.endsWith("\u001b[39m") ? expectedLine.slice(0, -5) : expectedLine,
      );
    }
  });
});
