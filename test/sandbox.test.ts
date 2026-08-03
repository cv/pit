import * as ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityTrace } from "../src/capability-trace.js";
import {
  type CapabilityRequest,
  clearSandboxCaches,
  formatDiagnostic,
  getNamedFunctionName,
  getProjectFunctionMetadata,
  getSandboxCacheStats,
  getSavedFunctionCallSignature,
  getSavedFunctionDependencyGraph,
  parseFunctionExecutionContext,
  resolveSavedFunctionReferences,
  runInSandbox,
  SandboxRemoteError,
  sandboxFatalError,
  validateTypeScript,
} from "../src/sandbox.js";

describe("function execution wire context", () => {
  it("accepts valid bounded invocation context", () => {
    expect(
      parseFunctionExecutionContext({
        invocationId: 2,
        parentInvocationId: 1,
        name: "nested",
        scope: "project",
        depth: 2,
      }),
    ).toEqual({
      invocationId: 2,
      parentInvocationId: 1,
      name: "nested",
      scope: "project",
      depth: 2,
    });
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { invocationId: 0, name: "x", scope: "project", depth: 1 },
    { invocationId: 1, name: "", scope: "project", depth: 1 },
    { invocationId: 1, name: "x", scope: "other", depth: 1 },
    { invocationId: 1, name: "x", scope: "session", depth: 33 },
    { invocationId: 1, parentInvocationId: 0, name: "x", scope: "session", depth: 1 },
  ])("rejects malformed context %#", (value) => {
    expect(parseFunctionExecutionContext(value)).toBeUndefined();
  });
});

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

describe("saved function references", () => {
  it("resolves direct and transitive references in dependency order", () => {
    const saved = new Map([
      ["base", "async function base() { return 1; }"],
      ["composed", "async function composed() { return base() + 1; }"],
      ["unrelated", "async function unrelated() { return 0; }"],
    ]);
    expect(resolveSavedFunctionReferences("composed()", saved)).toEqual([
      { name: "base", source: saved.get("base"), direct: false },
      { name: "composed", source: saved.get("composed"), direct: true },
    ]);
    expect(resolveSavedFunctionReferences("({ base: 1 }).base", saved)).toEqual([]);
    expect(
      resolveSavedFunctionReferences(
        `
      const base = 1;
      function local(base) { return 1; }
      const object = { base: 1, base() { return 1; } };
      const { base: renamed } = object;
      try { throw new Error(); } catch (base) { void base; }
      class base { value = renamed; }
      type Named = base;
      type Queried = typeof base;
    `,
        saved,
      ),
    ).toEqual([]);

    expect(resolveSavedFunctionReferences("composed() + base()", saved)).toEqual([
      { name: "base", source: saved.get("base"), direct: true },
      { name: "composed", source: saved.get("composed"), direct: true },
    ]);

    const directPromotion = new Map([
      ["aComposed", "async function aComposed() { return zBase(); }"],
      ["zBase", "async function zBase() { return 1; }"],
    ]);
    expect(resolveSavedFunctionReferences("aComposed() + zBase()", directPromotion)).toEqual([
      { name: "zBase", source: directPromotion.get("zBase"), direct: true },
      { name: "aComposed", source: directPromotion.get("aComposed"), direct: true },
    ]);
  });

  it("reports direct and transitive reverse dependencies", () => {
    const graph = getSavedFunctionDependencyGraph(
      new Map([
        ["base", "async function base() { return 1; }"],
        ["middle", "async function middle() { return base(); }"],
        ["sibling", "async function sibling() { return base(); }"],
        ["leafA", "async function leafA() { return middle(); }"],
        ["leafB", "async function leafB() { return middle(); }"],
      ]),
    );

    expect(graph.directDependencies("missing")).toEqual([]);
    expect(graph.dependents("base")).toEqual({
      direct: ["middle", "sibling"],
      transitive: ["leafA", "leafB"],
    });
    expect(graph.cycles()).toEqual([]);
  });

  it("handles and orders cyclic saved references without duplication", () => {
    const saved = new Map([
      ["first", "async function first() { return second(); }"],
      ["second", "async function second() { return first(); }"],
      ["alpha", "async function alpha() { return beta(); }"],
      ["beta", "async function beta() { return alpha(); }"],
    ]);
    const graph = getSavedFunctionDependencyGraph(saved);
    const references = graph.resolve("first()");
    expect(references.map((reference) => reference.name).sort()).toEqual(["first", "second"]);
    expect(graph.cycles()).toEqual([
      ["alpha", "beta"],
      ["first", "second"],
    ]);
    expect(graph.dependents("first")).toEqual({ direct: ["second"], transitive: [] });
  });
});

describe("sandbox caches", () => {
  it("caches successful and failed validation plus compiled output", async () => {
    clearSandboxCaches();
    const source = "() => ({ answer: 42 })";
    validateTypeScript(source);
    validateTypeScript(source);

    const invalid = "() => 1n";
    expect(() => validateTypeScript(invalid)).toThrow();
    expect(() => validateTypeScript(invalid)).toThrow();

    await runInSandbox(source, async () => null);
    await runInSandbox(source, async () => null);
    expect(getSandboxCacheStats()).toEqual({
      validationEntries: 2,
      compilationEntries: 1,
      validationHits: 4,
      compilationHits: 1,
      dependencyGraphEntries: 1,
      dependencyGraphHits: 1,
      dependencyReferenceEntries: 0,
      dependencyReferenceHits: 0,
    });
    clearSandboxCaches();
    expect(getSandboxCacheStats()).toEqual({
      validationEntries: 0,
      compilationEntries: 0,
      validationHits: 0,
      compilationHits: 0,
      dependencyGraphEntries: 0,
      dependencyGraphHits: 0,
      dependencyReferenceEntries: 0,
      dependencyReferenceHits: 0,
    });
  });

  it("reuses dependency graphs and invalidates changed registries", () => {
    clearSandboxCaches();
    const saved = new Map([
      ["base", "async function base() { return 1; }"],
      ["composed", "async function composed() { return base() + 1; }"],
    ]);
    const initial = getSavedFunctionDependencyGraph(saved);
    expect(initial.resolve("composed()").map(({ name }) => name)).toEqual(["base", "composed"]);

    const reloaded = getSavedFunctionDependencyGraph(new Map(saved));
    expect(reloaded).toBe(initial);
    expect(reloaded.resolve("composed()").map(({ name }) => name)).toEqual(["base", "composed"]);

    saved.set("composed", "async function composed() { return 2; }");
    const replaced = getSavedFunctionDependencyGraph(saved);
    expect(replaced).not.toBe(initial);
    expect(replaced.resolve("composed()").map(({ name }) => name)).toEqual(["composed"]);

    saved.delete("base");
    expect(getSavedFunctionDependencyGraph(saved)).not.toBe(replaced);
    expect(getSandboxCacheStats()).toMatchObject({
      dependencyGraphEntries: 3,
      dependencyGraphHits: 1,
      dependencyReferenceHits: expect.any(Number),
    });
    expect(getSandboxCacheStats().dependencyReferenceHits).toBeGreaterThan(0);
  });
});

describe("runInSandbox", () => {
  it("executes TypeScript and returns a copied value", async () => {
    const result = await runInSandbox(
      "async (): Promise<{ answer: number }> => ({ answer: 6 * 7 })",
      async () => {
        throw new Error("unexpected capability call");
      },
    );
    expect(result).toEqual({ answer: 42 });
  });

  it("passes initial input as the function's second argument", async () => {
    const source =
      "async (_capabilities, input: { value: number }) => ({ value: input.value * 2 })";
    await expect(runInSandbox(source, async () => null, { input: { value: 21 } })).resolves.toEqual(
      { value: 42 },
    );
    expect(() => validateTypeScript(source, new Map(), { value: "wrong" })).toThrow(
      /string.*number/,
    );
    await expect(runInSandbox("42", async () => null, { input: {} })).rejects.toThrow(
      "Top-level params can only be passed to a function expression",
    );
  });

  it("provides destructured capabilities through RPC", async () => {
    const handler = vi.fn(
      async (): Promise<unknown> => ({
        stdout: "",
        stderr: "",
        code: 42,
        truncated: false,
      }),
    );
    const result = await runInSandbox(
      `async ({ shell }) => ({ value: (await shell.exec("sum")).code })`,
      handler,
    );
    expect(result).toEqual({ value: 42 });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "shell",
        method: "exec",
        args: ["sum"],
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("emits bounded runtime traces for concurrent success and failure", async () => {
    const updates: CapabilityTrace[] = [];
    const result = await runInSandbox(
      `async ({ shell, context }) => Promise.all([
        shell.exec("secret command"),
        context.get(),
      ])`,
      async ({ capability }) => {
        if (capability === "shell") {
          return { stdout: "ok", stderr: "", code: 0, truncated: false };
        }
        return { cwd: "/tmp" };
      },
      { onCapabilityTrace: (trace) => updates.push(trace) },
    );

    expect(result).toHaveLength(2);
    const completed = updates.filter((trace) => trace.status !== "running");
    expect(completed).toEqual([
      expect.objectContaining({
        sequence: 1,
        capability: "shell",
        method: "exec",
        status: "succeeded",
      }),
      expect.objectContaining({
        sequence: 2,
        capability: "context",
        method: "get",
        status: "succeeded",
      }),
    ]);
    expect(completed[0]?.arguments).toEqual([{ type: "string", size: 14 }]);
    expect(JSON.stringify(updates)).not.toContain("secret command");

    const failed: CapabilityTrace[] = [];
    await expect(
      runInSandbox(
        "async ({ context }) => context.get()",
        async () => {
          throw new Error("host refused");
        },
        { onCapabilityTrace: (trace) => failed.push(trace) },
      ),
    ).rejects.toThrow("host refused");
    expect(failed.at(-1)).toMatchObject({ status: "failed", durationMs: expect.any(Number) });

    await expect(
      runInSandbox("async ({ context }) => context.get()", async () => ({ ok: true }), {
        onCapabilityTrace: () => {
          throw new Error("observer failed");
        },
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("injects saved functions as capability-bound expressions", async () => {
    const savedFunctions = new Map([
      ["answer", "async function answer(_capabilities, input) { return { answer: input.value }; }"],
      ["unrelated", "42"],
    ]);
    const handler = vi.fn(async ({ capability, method }: CapabilityRequest) => {
      if (capability === "__pit" && method === "savedFunctionRun") {
        return null;
      }
      throw new Error("unexpected capability call");
    });
    const result = await runInSandbox("answer({ value: 42 })", handler, { savedFunctions });
    expect(result).toEqual({ answer: 42 });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "__pit",
        method: "savedFunctionRun",
        args: ["answer"],
        signal: expect.any(AbortSignal),
        functionContext: expect.objectContaining({
          invocationId: 1,
          name: "answer",
          scope: "session",
          depth: 1,
        }),
      }),
    );
    await expect(runInSandbox("unrelated()", handler, { savedFunctions })).rejects.toThrow(
      /number.*PitProgram/,
    );
  });

  it("attributes nested and concurrent saved-function capability calls", async () => {
    const savedFunctions = new Map([
      ["outer", "async function outer(_capabilities, input) { return inner(input); }"],
      ["inner", "async function inner({ context }, input) { await context.get(); return input; }"],
    ]);
    const savedFunctionScopes = new Map<string, "project" | "session">([
      ["outer", "project"],
      ["inner", "session"],
    ]);
    const traces: CapabilityTrace[] = [];
    await runInSandbox(
      'async () => Promise.all([outer("nested"), inner("direct")])',
      async ({ capability, method }) => {
        if (capability === "__pit" && method === "savedFunctionRun") {
          return null;
        }
        if (capability === "context" && method === "get") {
          return { cwd: "/tmp" };
        }
        throw new Error("unexpected capability call");
      },
      { savedFunctions, savedFunctionScopes, onCapabilityTrace: (trace) => traces.push(trace) },
    );

    const completed = traces.filter((trace) => trace.status === "succeeded");
    const outer = completed.find(
      (trace) => trace.capability === "__pit" && trace.function?.name === "outer",
    )?.function;
    const innerCalls = completed
      .filter((trace) => trace.capability === "context")
      .map((trace) => trace.function);
    expect(outer).toMatchObject({ scope: "project", depth: 1 });
    expect(innerCalls).toHaveLength(2);
    expect(innerCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "session", depth: 1 }),
        expect.objectContaining({
          scope: "session",
          depth: 2,
          parentInvocationId: outer?.invocationId,
        }),
      ]),
    );
    expect(new Set(innerCalls.map((context) => context?.invocationId)).size).toBe(2);
  });

  it("preserves saved function input and return types", () => {
    const savedFunctions = new Map([
      [
        "runTests",
        `async function runTests(_capabilities, input: { coverage?: boolean } = {}) {
        return { code: input.coverage ? 1 : 0, output: "done" };
      }`,
      ],
    ]);
    expect(() => validateTypeScript("runTests({ coverage: true })", savedFunctions)).not.toThrow();
    expect(() => validateTypeScript(`runTests({ coverage: "yes" })`, savedFunctions)).toThrow(
      /string.*boolean/,
    );
    expect(() =>
      validateTypeScript("async () => (await runTests()).missing", savedFunctions),
    ).toThrow(/Property 'missing' does not exist/);
  });

  it("annotates saved function failures and limits cross-function recursion", async () => {
    const handler = async () => null;
    const failed = new Map([["broken", `async function broken() { throw new Error("boom"); }`]]);
    await expect(runInSandbox("broken()", handler, { savedFunctions: failed })).rejects.toThrow(
      'Saved function "broken" failed: boom',
    );

    const recursive = new Map([
      ["first", "async function first() { return second(); }"],
      ["second", "async function second() { return first(); }"],
    ]);
    await expect(runInSandbox("first()", handler, { savedFunctions: recursive })).rejects.toThrow(
      "Saved function call depth exceeded 32",
    );
  });

  it("returns bounded structured remote diagnostics without enumerable stack frames", async () => {
    let failure: unknown;
    try {
      await runInSandbox(
        `() => {
          const error = new Error("remote boom");
          error.stack = "Error: remote boom\\n" + Array.from(
            { length: 40 },
            (_, index) => "    at frame" + index + " (/private/path/" + index + ".js:1:1)",
          ).join("\\n");
          throw error;
        }`,
        async () => null,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SandboxRemoteError);
    const remote = failure as SandboxRemoteError;
    expect(remote.message).toBe("remote boom");
    expect(remote.remoteName).toBe("Error");
    expect(remote.remoteFrames).toHaveLength(20);
    expect(remote.remoteTruncated).toBe(true);
    expect(JSON.stringify(remote)).not.toContain("private/path");

    try {
      await runInSandbox(`() => { throw new Error("x".repeat(20_000)); }`, async () => null);
    } catch (error) {
      const bounded = error as SandboxRemoteError;
      expect(Buffer.byteLength(bounded.message)).toBeLessThanOrEqual(8_000);
      expect(bounded.remoteTruncated).toBe(true);
    }
  });

  it("accepts legacy and defensive sandbox fatal error shapes", () => {
    expect(sandboxFatalError("legacy failure").message).toBe("legacy failure");
    expect(sandboxFatalError(undefined).message).toBe("TypeScript sandbox failed");
    expect(sandboxFatalError({ name: "Error" }).message).toBe("TypeScript sandbox failed");

    const minimal = sandboxFatalError({ message: "minimal" }) as SandboxRemoteError;
    expect(minimal.remoteName).toBe("Error");
    expect(minimal.remoteFrames).toEqual([]);
    expect(minimal.remoteTruncated).toBe(false);

    const structured = sandboxFatalError({
      name: "TypeError",
      message: "structured",
      frames: ["    at one", 42, "    at two"],
      truncated: true,
    }) as SandboxRemoteError;
    expect(structured.remoteName).toBe("TypeError");
    expect(structured.remoteFrames).toEqual(["    at one", "    at two"]);
    expect(structured.remoteTruncated).toBe(true);
  });

  it("detects named top-level function expressions", () => {
    expect(getNamedFunctionName("async function runTests() { return null; }")).toBe("runTests");
    expect(getNamedFunctionName("((async function wrapped() { return null; }))")).toBe("wrapped");
    expect(getNamedFunctionName("async function () { return null; }")).toBeUndefined();
    expect(getNamedFunctionName("async () => null")).toBeUndefined();
    expect(getNamedFunctionName("missing()")).toBeUndefined();

    expect(getSavedFunctionCallSignature("async function runTests() { return null; }")).toBe(
      "runTests()",
    );
    expect(
      getSavedFunctionCallSignature(
        "async function inspect(_capabilities, input: { file: string } = { file: 'README.md' }) { return input; }",
      ),
    ).toBe("inspect(input?: { file: string })");
    expect(
      getSavedFunctionCallSignature(
        "async function required(_capabilities, input: string) { return input; }",
      ),
    ).toBe("required(input: string)");
    expect(getSavedFunctionCallSignature("async () => null")).toBeUndefined();
  });

  it("extracts project function documentation", () => {
    expect(getProjectFunctionMetadata("")).toBeUndefined();
    expect(
      getProjectFunctionMetadata("async function first() {} async function second() {}"),
    ).toBeUndefined();
    expect(
      getProjectFunctionMetadata(`/**
 * Documented helper.
 *
 * Details.
 * @pit project
 * @param input.raw
 */
async function documented(_capabilities, input) { return input; }`),
    ).toEqual({
      name: "documented",
      signature: "documented(input: unknown)",
      summary: "Documented helper.",
      parameters: [{ name: "input.raw" }],
    });
    expect(
      getProjectFunctionMetadata(`/**
 * Uses {@link documented} metadata.
 * @pit project
 * @param input.raw - See {@link documented}.
 */
async function linked(_capabilities, input) { return input; }`),
    ).toEqual({
      name: "linked",
      signature: "linked(input: unknown)",
      summary: "Uses {@link documented} metadata.",
      parameters: [{ name: "input.raw", description: "See {@link documented}." }],
    });
  });

  it("contextually types expressions using active saved functions", () => {
    const savedFunctions = new Map([["answer", "async function answer() { return 42; }"]]);
    expect(() => validateTypeScript("answer()", savedFunctions)).not.toThrow();
    expect(() => validateTypeScript("missing()", savedFunctions)).toThrow(
      /Cannot find name 'missing'[\s\S]*Available saved functions: answer/,
    );
  });

  it("propagates capability errors", async () => {
    await expect(
      runInSandbox("async ({ context }) => context.get()", async () => {
        throw new Error("host refused");
      }),
    ).rejects.toThrow("host refused");
  });

  it("cannot read arbitrary files directly", async () => {
    await expect(
      runInSandbox(
        `async () => process.getBuiltinModule("node:fs").readFileSync("/etc/passwd", "utf8")`,
        async () => null,
      ),
    ).rejects.toThrow(/permission|access|denied|ERR_ACCESS_DENIED/i);
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

  it("bounds protocol frames in both directions", async () => {
    await expect(
      runInSandbox(
        `async () => { process.stdout.write("x".repeat(8_000_001)); return null; }`,
        async () => null,
      ),
    ).rejects.toThrow(/RPC frame exceeds/);

    await expect(
      runInSandbox("async ({ context }) => context.get()", async () => "x".repeat(8_000_001)),
    ).rejects.toThrow(/Capability response exceeds RPC limit/);

    await expect(
      runInSandbox(
        `async ({ context }) => (context as any).get("x".repeat(8_000_001))`,
        async () => null,
      ),
    ).rejects.toThrow(/RPC frame exceeds/);
  });

  it("bounds concurrent and total capability calls", async () => {
    const rejected: CapabilityTrace[] = [];
    await expect(
      runInSandbox(
        `async ({ context }) => Promise.all(
          Array.from({ length: 33 }, () => context.get())
        )`,
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return null;
        },
        { onCapabilityTrace: (trace) => rejected.push(trace) },
      ),
    ).rejects.toThrow(/Concurrent RPC call limit exceeded/);
    expect(rejected.some((trace) => trace.status === "rejected")).toBe(true);

    await expect(
      runInSandbox(
        `async ({ context }) => {
          for (let index = 0; index < 1025; index++) await context.get();
          return null;
        }`,
        async () => null,
      ),
    ).rejects.toThrow(/RPC call limit exceeded/);
  });

  it("waits for floating capability calls before reporting success", async () => {
    let completed = false;
    const result = await runInSandbox(
      "async ({ context }) => { context.get(); return 42; }",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        completed = true;
        return null;
      },
    );
    expect(result).toBe(42);
    expect(completed).toBe(true);
  });

  it("aborts cooperative capability handlers on timeout", async () => {
    let aborted = false;
    await expect(
      runInSandbox(
        "async ({ context }) => context.get()",
        async ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
        { timeoutMs: 100 },
      ),
    ).rejects.toThrow("timed out");
    await vi.waitFor(() => expect(aborted).toBe(true));
  });

  it("reports a child that exits without a result", async () => {
    await expect(runInSandbox("() => process.exit(7)", async () => null)).rejects.toThrow(/exit 7/);
  });

  it("reports a child terminated by a signal", async () => {
    await expect(
      runInSandbox(`() => process.kill(process.pid, "SIGTERM")`, async () => null),
    ).rejects.toThrow(/SIGTERM/);
  });

  it("handles non-Error capability failures", async () => {
    await expect(
      runInSandbox("async ({ context }) => context.get()", async () => {
        throw "string failure";
      }),
    ).rejects.toThrow("string failure");
  });

  it("does not reply after execution has timed out", async () => {
    await expect(
      runInSandbox(
        "async ({ context }) => context.get()",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return 1;
        },
        { timeoutMs: 10 },
      ),
    ).rejects.toThrow("timed out");
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  it("reports failure to start the sandbox process", async () => {
    const original = process.execPath;
    process.execPath = "/definitely/missing/node";
    try {
      await expect(runInSandbox("() => 1", async () => null)).rejects.toThrow(/ENOENT/);
    } finally {
      process.execPath = original;
    }
  });

  it("runs with an explicitly empty PATH and custom memory limit", async () => {
    const original = process.env.PATH;
    delete process.env.PATH;
    try {
      await expect(runInSandbox("() => 42", async () => null, { memoryLimitMb: 32 })).resolves.toBe(
        42,
      );
    } finally {
      process.env.PATH = original;
    }
  });

  it("executes value expressions and rejects malformed source", async () => {
    await expect(runInSandbox("42", async () => null)).resolves.toBe(42);
    await expect(runInSandbox("(() =>", async () => null)).rejects.toThrow();
  });

  it("rejects values that cannot cross the JSON wire", async () => {
    await expect(runInSandbox("() => 1n", async () => null)).rejects.toThrow(/bigint/i);
  });

  it("terminates runaway code", async () => {
    await expect(
      runInSandbox("() => { while (true) {} }", async () => null, { timeoutMs: 100 }),
    ).rejects.toThrow("timed out");
  });

  it("supports cancellation", async () => {
    const controller = new AbortController();
    const promise = runInSandbox("async () => new Promise(() => {})", async () => null, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toThrow("cancelled");

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      runInSandbox("() => 1", async () => null, { signal: alreadyAborted.signal }),
    ).rejects.toThrow("cancelled");
  });

  it("validates resource limits", async () => {
    await expect(runInSandbox("() => 1", async () => null, { memoryLimitMb: 15 })).rejects.toThrow(
      "at least 16",
    );
    await expect(
      runInSandbox("() => 1", async () => null, { memoryLimitMb: Number.NaN }),
    ).rejects.toThrow("at least 16");
    await expect(runInSandbox("() => 1", async () => null, { timeoutMs: 0 })).rejects.toThrow(
      "positive",
    );
    await expect(
      runInSandbox("() => 1", async () => null, { timeoutMs: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow("positive");
  });
});
