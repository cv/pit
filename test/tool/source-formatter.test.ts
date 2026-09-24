import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { formatTypeScriptSource } from "../../src/tool/source-formatter.js";

describe("TypeScript source formatting", () => {
  it("normalizes minified source idempotently without changing its calls or returned value", async () => {
    const source =
      'async({workspace,git})=>{const[file,status]=await Promise.all([workspace.read("package.json",{format:"raw"}),git.status(["--short"])]);return{file,status}}';
    const formatted = await formatTypeScriptSource(source);
    expect(formatted).not.toBe(source);
    expect(formatted.split("\n").length).toBeGreaterThan(1);
    expect(await formatTypeScriptSource(formatted)).toBe(formatted);
    const read = vi.fn(async () => ({ content: "file contents" }));
    const status = vi.fn(async () => "clean");
    const execute = runInNewContext(`(${formatted})`) as (capabilities: object) => Promise<unknown>;
    expect(await execute({ workspace: { read }, git: { status } })).toEqual({
      file: { content: "file contents" },
      status: "clean",
    });
    expect(read).toHaveBeenCalledWith("package.json", { format: "raw" });
    expect(status).toHaveBeenCalledWith(["--short"]);
  });

  it("keeps a direct expression embeddable while preserving semicolons inside data", async () => {
    const formatted = await formatTypeScriptSource('capture({coverage:true,text:"keep;this"});');
    const capture = vi.fn((input: unknown) => input);
    expect(runInNewContext(`(${formatted})`, { capture })).toEqual({
      coverage: true,
      text: "keep;this",
    });
    expect(capture).toHaveBeenCalledExactlyOnceWith({ coverage: true, text: "keep;this" });
  });

  it.each([
    { name: "empty", source: "" },
    { name: "whitespace", source: "  \n" },
    { name: "malformed", source: "saved.list(" },
  ])("preserves $name source when it cannot be usefully formatted", async ({ source }) => {
    await expect(formatTypeScriptSource(source)).resolves.toBe(source);
  });
});
