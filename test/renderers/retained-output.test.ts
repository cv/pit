import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ExecutionProgressController,
  retainShellOutputTail,
} from "../../src/execution/progress.js";
import { renderResultValue } from "../../src/renderers/generic.js";
import { renderTypeScriptToolResult } from "../../src/renderers/typescript-tool.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const result = (stdout: string, stderr = "") => ({ stdout, stderr, code: 0, truncated: false });
const shared = result("SENTINEL\nNEXT\n");
const json = JSON.stringify({ text: "SENTINEL\nNEXT" }) + "\n";
const longOutput = `${Array.from({ length: 12 }, (_, index) =>
  index === 11 ? "SENTINEL" : `line ${index}`,
).join("\n")}\n`;
interface Case {
  name: string;
  value: unknown;
  captured: string;
  occurrences: number;
  alreadyShown: boolean;
}
const cases: Case[] = [
  {
    name: "direct output ending in a newline",
    value: shared,
    captured: shared.stdout,
    occurrences: 1,
    alreadyShown: true,
  },
  {
    name: "named result indentation",
    value: { job: shared },
    captured: shared.stdout,
    occurrences: 1,
    alreadyShown: true,
  },
  {
    name: "array result indentation",
    value: [shared],
    captured: shared.stdout,
    occurrences: 1,
    alreadyShown: true,
  },
  {
    name: "separate stdout and stderr blocks",
    value: result("SENTINEL\n", "NOTICE\n"),
    captured: "SENTINEL\nNOTICE\n",
    occurrences: 1,
    alreadyShown: true,
  },
  {
    name: "formatted JSON stdout",
    value: result(json),
    captured: json,
    occurrences: 1,
    alreadyShown: true,
  },
  {
    name: "styled nested output",
    value: { job: result("\u001b[32mSENTINEL\u001b[0m\nNEXT\n") },
    captured: "SENTINEL\nNEXT\n",
    occurrences: 1,
    alreadyShown: true,
  },
  {
    name: "normalized carriage returns",
    value: { job: result("SENTINEL\r\nNEXT\r\n") },
    captured: "SENTINEL\nNEXT\n",
    occurrences: 1,
    alreadyShown: true,
  },
  {
    name: "shared process references retain both returned fields",
    value: { first: shared, second: shared },
    captured: shared.stdout,
    occurrences: 2,
    alreadyShown: true,
  },
  {
    name: "interleaved streams preserve extra ordering information",
    value: result("SENTINEL\nLAST\n", "NOTICE\n"),
    captured: "SENTINEL\nNOTICE\nLAST\n",
    occurrences: 2,
    alreadyShown: false,
  },
  {
    name: "helper summary does not replace its diagnostics",
    value: { done: true },
    captured: "SENTINEL\n",
    occurrences: 1,
    alreadyShown: false,
  },
  {
    name: "extra captured text stays inspectable",
    value: result("last only\n"),
    captured: "SENTINEL\nlast only\n",
    occurrences: 1,
    alreadyShown: false,
  },
  {
    name: "null return does not replace its diagnostics",
    value: null,
    captured: "SENTINEL\n",
    occurrences: 1,
    alreadyShown: false,
  },
  {
    name: "returned stdout text",
    value: shared.stdout,
    captured: shared.stdout,
    occurrences: 1,
    alreadyShown: true,
  },
  {
    name: "long output compared by its retained tail",
    value: result(longOutput),
    captured: retainShellOutputTail(longOutput),
    occurrences: 1,
    alreadyShown: true,
  },
  {
    name: "unrelated returned text containing the output",
    value: { summary: "before SENTINEL after" },
    captured: "SENTINEL",
    occurrences: 2,
    alreadyShown: false,
  },
  {
    name: "returned result with a different exit code",
    value: { ...result("SENTINEL\n"), code: 1 },
    captured: "SENTINEL\n",
    occurrences: 2,
    alreadyShown: false,
  },
];

beforeEach(() => initTheme("dark"));

describe("retained process output", () => {
  it.each(cases)("$name", ({ value, captured, occurrences, alreadyShown }) => {
    const rendered = renderTypeScriptToolResult(
      {
        content: [],
        details: {
          value,
          truncated: false,
          progress: [
            { id: 1, command: "smoke fixture", status: "done", code: 0, output: captured },
          ],
        },
      },
      { expanded: true, isPartial: false },
      theme,
      {},
    );
    const output = rendered
      .render(120)
      .map((row) => stripTerminalSequences(row).trimEnd())
      .join("\n");
    expect(output.split("SENTINEL").length - 1).toBe(occurrences);
    expect(output.includes("(output shown above)")).toBe(alreadyShown);
    expect(output).toContain("[exit 0] smoke fixture");
  });

  it("shows image identity and a text-only warning in collapsed output", () => {
    const rawRows = renderTypeScriptToolResult(
      {
        content: [{ type: "image" }, { type: "text", text: "value omitted" }],
        details: {
          value: undefined,
          truncated: false,
          imageAttachments: [
            {
              file: "plot.png",
              mimeType: "image/png",
              // The flag, not Pi's note wording, identifies a text-only model.
              note: "",
              omitted: true,
            },
          ],
        },
      },
      { expanded: false, isPartial: false },
      theme,
      {},
    ).render(32);
    const output = rawRows.map(stripTerminalSequences).join("\n");
    const normalized = output.replace(/\s+/g, " ");

    expect(output).toContain("Image attached");
    expect(output).toContain("plot.png (image/png)");
    expect(normalized).toContain("image omitted for text-only model");
    expect(output).not.toContain("(no result)");
    expect(rawRows.every((line) => visibleWidth(line) <= 32)).toBe(true);
  });

  it("sanitizes hostile image labels without rendering image bytes", () => {
    const imageBlock = { type: "image", data: "SECRET_BASE64", mimeType: "image/png" };

    const rawRows = renderTypeScriptToolResult(
      {
        content: [imageBlock, { type: "text", text: "value omitted" }],
        details: {
          value: { done: true },
          truncated: false,
          imageAttachments: [
            {
              file: "plots/βeta\n\u001b[2Jsecret.png",
              mimeType: "image/png",
              note: "Resized to model limit; current model does not support images.",
            },
          ],
        },
      },
      { expanded: true, isPartial: false },
      theme,
      {},
    ).render(32);
    const output = rawRows.map(stripTerminalSequences).join("\n");
    const normalized = output.replace(/\s+/g, " ");

    expect(output).toContain("Images");
    expect(output).toContain("plots/βeta");
    expect(output).toContain("secret.png (image/png)");
    expect(output).toContain("Resized to model limit");
    expect(normalized).toContain("current model does not support images");
    expect(rawRows.join("\n")).not.toContain("\u001b[2J");
    expect(output).not.toContain("SECRET_BASE64");
    expect(rawRows.every((line) => visibleWidth(line) <= 32)).toBe(true);
  });

  it("renders attachment identity when processing note is empty", () => {
    const output = renderTypeScriptToolResult(
      {
        content: [{ type: "image" }, { type: "text", text: "done" }],
        details: {
          value: { done: true },
          truncated: false,
          imageAttachments: [{ file: "plain.png", mimeType: "image/png", note: "" }],
        },
      },
      { expanded: true, isPartial: false },
      theme,
      {},
    )
      .render(80)
      .map(stripTerminalSequences)
      .join("\n");
    expect(output).toContain("plain.png (image/png)");
    expect(output).not.toContain("undefined");
  });

  it("falls back safely for malformed retained image metadata", () => {
    const output = renderTypeScriptToolResult(
      {
        content: [{ type: "text", text: "visible fallback" }],
        details: { imageAttachments: [{}] } as any,
      },
      { expanded: true, isPartial: false },
      theme,
      {},
    )
      .render(80)
      .map(stripTerminalSequences)
      .join("\n");
    expect(output).toContain("Structured view unavailable");
    expect(output).toContain("visible fallback");

    const collapsed = renderTypeScriptToolResult(
      {
        content: [{ type: "text", text: "visible fallback" }],
        details: { imageAttachments: [{}] } as any,
      },
      { expanded: false, isPartial: false },
      theme,
      {},
    )
      .render(80)
      .map(stripTerminalSequences)
      .join("\n");
    expect(collapsed).toContain("Expand to inspect retained data.");
  });

  it("does not render generic structured details while collapsed", () => {
    const output = renderTypeScriptToolResult(
      {
        content: [{ type: "text", text: "summary" }],
        details: { value: { payload: "uniqueImageDetailMarker" }, truncated: false },
      },
      { expanded: false, isPartial: false },
      theme,
      {},
    )
      .render(80)
      .map(stripTerminalSequences)
      .join("\n");
    expect(output).not.toContain("uniqueImageDetailMarker");
  });

  it.each([
    { name: "tool error", isError: true, truncated: false, value: shared },
    { name: "unretained truncated result", isError: false, truncated: true, value: undefined },
  ])(
    "keeps diagnostics when $name does not display the returned value",
    ({ isError, truncated, value }) => {
      const rendered = renderTypeScriptToolResult(
        {
          content: [{ type: "text", text: "Original diagnostic or retained prefix" }],
          details: {
            value,
            truncated,
            progress: [
              { id: 1, command: "smoke fixture", status: "done", code: 0, output: shared.stdout },
            ],
          },
        },
        { expanded: true, isPartial: false },
        theme,
        { isError },
      );
      const output = rendered.render(120).map(stripTerminalSequences).join("\n");
      expect(output).toContain("SENTINEL");
      expect(output).not.toContain("(output shown above)");
    },
  );

  it.each<{ name: string; output: string; marker: string; kept: string; dropped: string }>([
    {
      name: "whole lines",
      output: Array.from({ length: 50 }, (_, index) => `OUT_${index}\n`).join(""),
      marker: "… 42 lines omitted …",
      kept: "OUT_42",
      dropped: "OUT_41",
    },
    {
      name: "part of one long line",
      output: `START_${"y".repeat(10_000)}END_SENTINEL`,
      marker: "bytes omitted …",
      kept: "END_SENTINEL",
      dropped: "START_",
    },
  ])("marks dropped $name in live and settled views", ({ output, marker, kept, dropped }) => {
    const controller = new ExecutionProgressController();
    controller.recordShell({ id: 1, command: "noisy", phase: "start" });
    controller.recordShell({
      id: 1,
      command: "noisy",
      phase: "output",
      stream: "stdout",
      chunk: output,
    });
    const render = (details: object, isPartial: boolean) =>
      renderTypeScriptToolResult(
        { content: [{ type: "text", text: "done" }], details },
        { expanded: true, isPartial },
        theme,
        {},
      )
        .render(120)
        .map(stripTerminalSequences)
        .join("\n");
    const live = render(controller.snapshot(), true);
    controller.recordShell({ id: 1, command: "noisy", phase: "end", code: 0 });
    const settled = render({ value: "done", truncated: false, ...controller.snapshot() }, false);

    for (const view of [live, settled]) {
      // Join wrapped rows so a long retained line reads as one string.
      const flat = view.replace(/\n\s*/g, "");
      const at = flat.indexOf(marker);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(flat.indexOf(kept)).toBeGreaterThan(at);
      expect(flat).not.toContain(dropped);
    }
  });

  it("keeps an unfinished call's tail even when a returned text matches it", () => {
    const rendered = renderTypeScriptToolResult(
      {
        content: [],
        details: {
          value: shared.stdout,
          truncated: false,
          progress: [{ id: 1, command: "smoke fixture", status: "running", output: shared.stdout }],
        },
      },
      { expanded: true, isPartial: false },
      theme,
      {},
    );
    const output = rendered.render(120).map(stripTerminalSequences).join("\n");
    expect(output.split("SENTINEL").length - 1).toBe(2);
    expect(output).toContain("[unfinished when invocation ended] smoke fixture");
    expect(output).not.toContain("(output shown above)");
  });

  it("does not turn stream-ending newlines into extra blank rows", () => {
    const rendered = renderResultValue(result("first  \n\nlast  \n", "notice  \n"), theme);
    expect(rendered?.lines.map(stripTerminalSequences)).toEqual([
      "shell exit 0",
      "stdout",
      "first  ",
      "",
      "last  ",
      "stderr",
      "notice  ",
    ]);
  });
});
