import * as ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  clearSandboxCaches,
  formatDiagnostic,
  getNamedFunctionName,
  getSandboxCacheStats,
  runInSandbox,
  validateTypeScript,
} from "../src/sandbox.js";

describe("validateTypeScript", () => {
  it("formats global and non-program diagnostics", () => {
    expect(formatDiagnostic({
      category: ts.DiagnosticCategory.Error,
      code: 1,
      messageText: "global error",
      file: undefined,
      start: undefined,
      length: undefined,
    })).toBe("global error");

    const file = ts.createSourceFile("/other.ts", "bad", ts.ScriptTarget.ES2022);
    expect(formatDiagnostic({
      category: ts.DiagnosticCategory.Error,
      code: 2,
      messageText: "file error",
      file,
      start: 0,
      length: 3,
    })).toBe("/other.ts:1:1 file error\n  bad\n  ^");
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

    const manyErrors = Array.from({ length: 10 }, (_, index) => `const broken${index} = ;`).join("\n");
    expect(() => validateTypeScript(`async () => {\n${manyErrors}\n}`))
      .toThrow(/more diagnostics? omitted/);
    const nineErrors = Array.from({ length: 9 }, (_, index) => `const single${index} = ;`).join("\n");
    expect(() => validateTypeScript(`async () => {\n${nineErrors}\n}`))
      .toThrow("1 more diagnostic omitted");
  });

  it("allows evolving empty arrays, implicit helper parameters, and void results", () => {
    expect(() => validateTypeScript(`async ({ workspace }) => {
      const files = [];
      const capture = async (fn) => fn();
      files.push(await capture(() => workspace.readText("package.json")));
    }`)).not.toThrow();
  });

  it("contextually types capabilities without source annotations", () => {
    expect(() => validateTypeScript(`async ({ workspace }) => {
      const file = await workspace.readText("package.json");
      return file.text;
    }`)).not.toThrow();
  });

  it("reports capability, await, argument, and result errors with source locations", () => {
    expect(() => validateTypeScript(`async ({ workpace }) => workpace.readText("x")`))
      .toThrow(/1:.*Property 'workpace' does not exist/);
    expect(() => validateTypeScript(`async ({ workspace }) => {
      const file = workspace.readText("x");
      return file.text;
    }`)).toThrow(/3:.*Property 'text' does not exist on type 'Promise/);
    expect(() => validateTypeScript(`async ({ workspace }) => workspace.readText(42)`))
      .toThrow(/number.*string/);
    expect(() => validateTypeScript(`() => ({ pending: Promise.resolve(1) })`))
      .toThrow(/Promise<number>/);
  });
});

describe("sandbox caches", () => {
  it("caches successful and failed validation plus compiled output", async () => {
    clearSandboxCaches();
    const source = `() => ({ answer: 42 })`;
    validateTypeScript(source);
    validateTypeScript(source);

    const invalid = `() => 1n`;
    expect(() => validateTypeScript(invalid)).toThrow();
    expect(() => validateTypeScript(invalid)).toThrow();

    await runInSandbox(source, async () => null);
    await runInSandbox(source, async () => null);
    expect(getSandboxCacheStats()).toEqual({
      validationEntries: 2,
      compilationEntries: 1,
      validationHits: 4,
      compilationHits: 1,
    });
    clearSandboxCaches();
    expect(getSandboxCacheStats()).toEqual({
      validationEntries: 0, compilationEntries: 0, validationHits: 0, compilationHits: 0,
    });
  });
});

describe("runInSandbox", () => {
  it("executes TypeScript and returns a copied value", async () => {
    const result = await runInSandbox(
      `async (): Promise<{ answer: number }> => ({ answer: 6 * 7 })`,
      async () => { throw new Error("unexpected capability call"); },
    );
    expect(result).toEqual({ answer: 42 });
  });

  it("provides destructured capabilities through RPC", async () => {
    const handler = vi.fn(async (): Promise<unknown> => ({
      stdout: "", stderr: "", code: 42, truncated: false,
    }));
    const result = await runInSandbox(
      `async ({ shell }) => ({ value: (await shell.exec("sum")).code })`,
      handler,
    );
    expect(result).toEqual({ value: 42 });
    expect(handler).toHaveBeenCalledWith("shell", "exec", ["sum"]);
  });

  it("injects saved functions as capability-bound expressions", async () => {
    const savedFunctions = new Map([
      ["answer", `async function answer(_capabilities, input) { return { answer: input.value }; }`],
    ]);
    const handler = vi.fn(async (capability: string, method: string) => {
      if (capability === "__pit" && method === "savedFunctionRun") return null;
      throw new Error("unexpected capability call");
    });
    const result = await runInSandbox(`answer({ value: 42 })`, handler, { savedFunctions });
    expect(result).toEqual({ answer: 42 });
    expect(handler).toHaveBeenCalledWith("__pit", "savedFunctionRun", ["answer"]);
  });

  it("preserves saved function input and return types", () => {
    const savedFunctions = new Map([[
      "runTests",
      `async function runTests(_capabilities, input: { coverage?: boolean } = {}) {
        return { code: input.coverage ? 1 : 0, output: "done" };
      }`,
    ]]);
    expect(() => validateTypeScript(`runTests({ coverage: true })`, savedFunctions)).not.toThrow();
    expect(() => validateTypeScript(`runTests({ coverage: "yes" })`, savedFunctions))
      .toThrow(/string.*boolean/);
    expect(() => validateTypeScript(`async () => (await runTests()).missing`, savedFunctions))
      .toThrow(/Property 'missing' does not exist/);
  });

  it("annotates saved function failures and limits cross-function recursion", async () => {
    const handler = async () => null;
    const failed = new Map([["broken", `async function broken() { throw new Error("boom"); }`]]);
    await expect(runInSandbox(`broken()`, handler, { savedFunctions: failed }))
      .rejects.toThrow('Saved function "broken" failed: boom');

    const recursive = new Map([
      ["first", `async function first() { return second(); }`],
      ["second", `async function second() { return first(); }`],
    ]);
    await expect(runInSandbox(`first()`, handler, { savedFunctions: recursive }))
      .rejects.toThrow("Saved function call depth exceeded 32");
  });

  it("detects named top-level function expressions", () => {
    expect(getNamedFunctionName(`async function runTests() { return null; }`)).toBe("runTests");
    expect(getNamedFunctionName(`((async function wrapped() { return null; }))`)).toBe("wrapped");
    expect(getNamedFunctionName(`async function () { return null; }`)).toBeUndefined();
    expect(getNamedFunctionName(`async () => null`)).toBeUndefined();
    expect(getNamedFunctionName(`missing()`)).toBeUndefined();
  });

  it("contextually types expressions using active saved functions", () => {
    const savedFunctions = new Map([["answer", `async function answer() { return 42; }`]]);
    expect(() => validateTypeScript(`answer()`, savedFunctions)).not.toThrow();
    expect(() => validateTypeScript(`missing()`, savedFunctions))
      .toThrow(/Cannot find name 'missing'[^]*Available saved functions: answer/);
  });

  it("propagates capability errors", async () => {
    await expect(runInSandbox(
      `async ({ context }) => context.get()`,
      async () => { throw new Error("host refused"); },
    )).rejects.toThrow("host refused");
  });

  it("cannot read arbitrary files directly", async () => {
    await expect(runInSandbox(
      `async () => process.getBuiltinModule("node:fs").readFileSync("/etc/passwd", "utf8")`,
      async () => null,
    )).rejects.toThrow(/permission|access|denied|ERR_ACCESS_DENIED/i);
  });

  it("isolates the environment and tolerates untrusted process output", async () => {
    const result = await runInSandbox(
      `async () => {
        console.log("diagnostic");
        process.stdout.write("not json\\n");
        process.stdout.write(JSON.stringify({ token: "wrong", type: "result", value: 1 }) + "\\n");
        await new Promise(resolve => setTimeout(resolve, 10));
        return { secret: process.env.HOME };
      }`,
      async () => null,
    );
    expect(result).toEqual({});
  });

  it("reports a child that exits without a result", async () => {
    await expect(runInSandbox(`() => process.exit(7)`, async () => null)).rejects.toThrow(/exit 7/);
  });

  it("reports a child terminated by a signal", async () => {
    await expect(runInSandbox(`() => process.kill(process.pid, "SIGTERM")`, async () => null))
      .rejects.toThrow(/SIGTERM/);
  });

  it("handles non-Error capability failures", async () => {
    await expect(runInSandbox(`async ({ context }) => context.get()`, async () => { throw "string failure"; }))
      .rejects.toThrow("string failure");
  });

  it("does not reply after execution has timed out", async () => {
    await expect(runInSandbox(`async ({ context }) => context.get()`, async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return 1;
    }, { timeoutMs: 10 })).rejects.toThrow("timed out");
    await new Promise(resolve => setTimeout(resolve, 60));
  });

  it("reports failure to start the sandbox process", async () => {
    const original = process.execPath;
    process.execPath = "/definitely/missing/node";
    try {
      await expect(runInSandbox(`() => 1`, async () => null)).rejects.toThrow(/ENOENT/);
    } finally {
      process.execPath = original;
    }
  });

  it("runs with an explicitly empty PATH and custom memory limit", async () => {
    const original = process.env.PATH;
    delete process.env.PATH;
    try {
      await expect(runInSandbox(`() => 42`, async () => null, { memoryLimitMb: 32 })).resolves.toBe(42);
    } finally {
      process.env.PATH = original;
    }
  });

  it("executes value expressions and rejects malformed source", async () => {
    await expect(runInSandbox(`42`, async () => null)).resolves.toBe(42);
    await expect(runInSandbox(`(() =>`, async () => null)).rejects.toThrow();
  });

  it("rejects values that cannot cross the JSON wire", async () => {
    await expect(runInSandbox(`() => 1n`, async () => null)).rejects.toThrow(/bigint/i);
  });

  it("terminates runaway code", async () => {
    await expect(runInSandbox(`() => { while (true) {} }`, async () => null, { timeoutMs: 100 }))
      .rejects.toThrow("timed out");
  });

  it("supports cancellation", async () => {
    const controller = new AbortController();
    const promise = runInSandbox(`async () => new Promise(() => {})`, async () => null, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toThrow("cancelled");

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(runInSandbox(`() => 1`, async () => null, { signal: alreadyAborted.signal }))
      .rejects.toThrow("cancelled");
  });

  it("validates resource limits", async () => {
    await expect(runInSandbox(`() => 1`, async () => null, { memoryLimitMb: 15 }))
      .rejects.toThrow("at least 16");
    await expect(runInSandbox(`() => 1`, async () => null, { memoryLimitMb: Number.NaN }))
      .rejects.toThrow("at least 16");
    await expect(runInSandbox(`() => 1`, async () => null, { timeoutMs: 0 }))
      .rejects.toThrow("positive");
    await expect(runInSandbox(`() => 1`, async () => null, { timeoutMs: Number.POSITIVE_INFINITY }))
      .rejects.toThrow("positive");
  });
});
