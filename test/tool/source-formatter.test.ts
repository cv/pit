import { describe, expect, it, vi } from "vitest";

import { formatTypeScriptSource } from "../../src/tool/source-formatter.js";

describe("TypeScript source formatting", () => {
  it("formats completed tool source with the compact Pit style", async () => {
    const source =
      'async({workspace,git})=>{const[file,status]=await Promise.all([workspace.read("package.json",{format:"raw"}),git.status(["--short"])]);return{file,status}}';

    await expect(formatTypeScriptSource(source)).resolves.toBe(`async ({ workspace, git }) => {
  const [file, status] = await Promise.all([
    workspace.read("package.json", { format: "raw" }),
    git.status(["--short"]),
  ]);
  return { file, status };
}`);
  });

  it("removes only the file-level terminator from direct expressions", async () => {
    await expect(formatTypeScriptSource("validatePit({coverage:true})")).resolves.toBe(
      "validatePit({ coverage: true })",
    );
  });

  it.each([
    { name: "empty", source: "" },
    { name: "whitespace", source: "  \n" },
    { name: "malformed", source: "saved.list(" },
  ])("preserves $name source when it cannot be usefully formatted", async ({ source }) => {
    await expect(formatTypeScriptSource(source)).resolves.toBe(source);
  });

  it("falls back when the native formatter throws", async () => {
    vi.resetModules();
    vi.doMock("oxfmt", () => ({
      format: vi.fn(async () => {
        throw new Error("native formatter unavailable");
      }),
    }));
    try {
      const { formatTypeScriptSource: formatWithFailure } =
        await import("../../src/tool/source-formatter.js");
      await expect(formatWithFailure("answer()")).resolves.toBe("answer()");
    } finally {
      vi.doUnmock("oxfmt");
      vi.resetModules();
    }
  });
});
