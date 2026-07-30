import * as ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { formatDiagnostic, runInSandbox, validateTypeScript } from "../src/sandbox.js";

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

  it("serializes, stores, and runs functions through the registry capability", async () => {
    const saved = new Map<string, string>();
    const handler = vi.fn(async (_capability: string, method: string, args: unknown[]) => {
      const name = String(args[0]);
      if (method === "set") {
        saved.set(name, String(args[1]));
        return { name, replaced: false };
      }
      if (method === "get") return saved.get(name);
      if (method === "has") return saved.has(name);
      if (method === "list") return [...saved.keys()];
      if (method === "delete") return saved.delete(name);
      throw new Error("unexpected method");
    });

    const result = await runInSandbox(`async ({ functions }) => {
      const saved = await functions.set("answer", async (_capabilities, input) => ({ answer: input.value }));
      const beforeDelete = {
        has: await functions.has("answer"),
        names: await functions.list(),
        value: await functions.run("answer", { value: 42 }),
      };
      const deleted = await functions.delete("answer");
      return { saved, beforeDelete, deleted, hasAfterDelete: await functions.has("answer") };
    }`, handler);

    expect(result).toEqual({
      saved: { name: "answer", replaced: false },
      beforeDelete: { has: true, names: ["answer"], value: { answer: 42 } },
      deleted: true,
      hasAfterDelete: false,
    });
    expect(saved.get("answer")).toBeUndefined();
    expect(handler).toHaveBeenCalledWith("functions", "set", ["answer", expect.stringContaining("async")]);
  });

  it("validates special function registry operations in the runner", async () => {
    await expect(runInSandbox(`async ({ functions }) => (functions as any).set("bad", 42)`, async () => null))
      .rejects.toThrow("expects a function");
    await expect(runInSandbox(`async ({ functions }) => (functions as any).unknown()`, async () => null))
      .rejects.toThrow("Unknown functions method");
    await expect(runInSandbox(`async ({ functions }) => functions.run("bad")`, async () => "42"))
      .rejects.toThrow("is not callable");
  });

  it("limits recursive saved function calls", async () => {
    let source = "";
    const handler = async (_capability: string, method: string, args: unknown[]) => {
      if (method === "set") { source = String(args[1]); return { name: "loop", replaced: false }; }
      if (method === "get") return source;
      return null;
    };
    await expect(runInSandbox(`async ({ functions }) => {
      await functions.set("loop", async ({ functions }) => functions.run("loop"));
      return functions.run("loop");
    }`, handler)).rejects.toThrow("call depth exceeded 32");
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

  it("rejects non-functions and malformed source", async () => {
    await expect(runInSandbox(`42`, async () => null)).rejects.toThrow("TypeScript validation failed");
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
