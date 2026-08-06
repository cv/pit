import * as ts from "typescript";
import { describe, expect, it } from "vitest";

import { formatDiagnostic, validateTypeScript } from "../../src/sandbox/validation.js";

describe("validateTypeScript", () => {
  it("formats global and non-program diagnostics", () => {
    expect(
      formatDiagnostic({
        category: ts.DiagnosticCategory.Error,
        code: 1,
        messageText: "global error",
        file: undefined,
        start: undefined,
        length: undefined,
      }),
    ).toBe("global error");

    const file = ts.createSourceFile("/other.ts", "bad", ts.ScriptTarget.ES2022);
    expect(
      formatDiagnostic({
        category: ts.DiagnosticCategory.Error,
        code: 2,
        messageText: "file error",
        file,
        start: 0,
        length: 3,
      }),
    ).toBe("/other.ts:1:1 file error\n  bad\n  ^");

    const missingLineFile = {
      fileName: "/missing.ts",
      text: "bad",
      getLineAndCharacterOfPosition: () => ({ line: 4, character: 2 }),
    } as unknown as ts.SourceFile;
    expect(
      formatDiagnostic({
        category: ts.DiagnosticCategory.Error,
        code: 3,
        messageText: "missing line",
        file: missingLineFile,
        start: 0,
        length: 1,
      }),
    ).toBe("/missing.ts:5:3 missing line");
  });

  it("reports concise syntax-first diagnostics with source excerpts", () => {
    let message = "";
    try {
      validateTypeScript(`async ({ missing }) => {
        const broken = ;
        return missing.call();
      }`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("TypeScript validation failed");
    expect(message).toContain("const broken = ;");
    expect(message).toContain("^");
    expect(message).not.toContain("Property 'missing'");
    expect(message.split("\n- ").length - 1).toBeLessThanOrEqual(8);

    const manyErrors = Array.from({ length: 10 }, (_, index) => `const broken${index} = ;`).join(
      "\n",
    );
    expect(() => validateTypeScript(`async () => {\n${manyErrors}\n}`)).toThrow(
      /more diagnostics? omitted/,
    );
    const nineErrors = Array.from({ length: 9 }, (_, index) => `const single${index} = ;`).join(
      "\n",
    );
    expect(() => validateTypeScript(`async () => {\n${nineErrors}\n}`)).toThrow(
      "1 more diagnostic omitted",
    );
  });

  it("allows evolving empty arrays, implicit helper parameters, and void results", () => {
    expect(() =>
      validateTypeScript(`async ({ workspace }) => {
      const files = [];
      const capture = async (fn) => fn();
      files.push(await capture(() => workspace.read("package.json", { format: "raw" })));
    }`),
    ).not.toThrow();
  });

  it("contextually types capabilities without source annotations", () => {
    expect(() =>
      validateTypeScript(`async ({ workspace }) => {
      const file = await workspace.read("package.json", { format: "raw" });
      return file.content;
    }`),
    ).not.toThrow();
  });

  it("reports capability, await, argument, and result errors with source locations", () => {
    expect(() => validateTypeScript(`async ({ workpace }) => workpace.read("x")`)).toThrow(
      /1:.*Property 'workpace' does not exist/,
    );
    expect(() =>
      validateTypeScript(`async ({ workspace }) => {
      const file = workspace.read("x");
      return file.content;
    }`),
    ).toThrow(/3:.*Property 'content' does not exist on type 'Promise/);
    expect(() => validateTypeScript("async ({ workspace }) => workspace.read(42)")).toThrow(
      /number.*string/,
    );
    expect(() => validateTypeScript("() => ({ pending: Promise.resolve(1) })")).toThrow(
      /Promise<number>/,
    );
  });
});
