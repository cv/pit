import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";

import { renderTypeScriptInputs } from "../../src/renderers/typescript-tool-call.js";
import { formatTypeScriptSource } from "../../src/tool/source-formatter.js";

vi.mock("../../src/tool/source-formatter.js", () => ({ formatTypeScriptSource: vi.fn() }));

it("does not replace newer inputs when an earlier formatting request completes late", async () => {
  initTheme("dark");
  const finish: Array<(formatted: string) => void> = [];
  vi.mocked(formatTypeScriptSource).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish.push(resolve);
      }),
  );
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const context = { expanded: true, argsComplete: true, invalidate: vi.fn() };
  renderTypeScriptInputs({ code: "first" }, theme, context);
  renderTypeScriptInputs({ code: "second" }, theme, context);
  finish[1]?.("formattedSecond");
  await Promise.resolve();
  expect(context.invalidate).toHaveBeenCalledOnce();
  finish[0]?.("formattedFirst");
  await Promise.resolve();
  expect(context.invalidate).toHaveBeenCalledOnce();
  const output = stripTerminalSequences(renderTypeScriptInputs({ code: "second" }, theme, context));
  expect(output).toContain("formattedSecond");
  expect(output).not.toContain("formattedFirst");
  expect(formatTypeScriptSource).toHaveBeenCalledTimes(2);
});
