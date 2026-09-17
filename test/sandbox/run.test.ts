import { describe, expect, it, vi } from "vitest";

import type { CapabilityTrace } from "../../src/execution/capability-trace.js";
import type { CapabilityRequest } from "../../src/sandbox/dispatcher.js";
import { runInSandbox, SandboxRemoteError, sandboxFatalError } from "../../src/sandbox/run.js";
import { validateTypeScript } from "../../src/sandbox/validation.js";

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
    const handler = vi.fn(async (): Promise<unknown> => ({
      stdout: "",
      stderr: "",
      code: 42,
      truncated: false,
    }));
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

  it("runs explicitly injected custom and native functions through RPC", async () => {
    const handler = vi.fn(async ({ capability, method, args }: CapabilityRequest) => {
      if (capability === "__pit" && method === "savedFunctionRun") return null;
      if (capability === "workspace" && method === "read") {
        return { content: `read:${String(args[0])}` };
      }
      throw new Error(`unexpected function call: ${capability}.${method}`);
    });
    const result = await runInSandbox(
      "async ({ inspect }, input: { file: string }) => inspect(input)",
      handler,
      {
        unifiedFunctions: true,
        input: { file: "README.md" },
        projectFunctions: new Map([
          [
            "inspect",
            "async function inspect({ workspace: { read } }, input: { file: string }) { return read(input.file); }",
          ],
        ]),
      },
    );

    expect(result).toEqual({ content: "read:README.md" });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "workspace", method: "read", args: ["README.md"] }),
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
      ["answer", "async function answer({}, input) { return { answer: input.value }; }"],
    ]);
    const handler = vi.fn(async ({ capability, method }: CapabilityRequest) => {
      if (capability === "__pit" && method === "savedFunctionRun") {
        return null;
      }
      throw new Error("unexpected capability call");
    });
    const result = await runInSandbox("async ({ answer }) => answer({ value: 42 })", handler, {
      unifiedFunctions: true,
      sessionFunctions: savedFunctions,
    });
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
  });

  it.each([
    { name: "user", scope: "user" as const },
    { name: "project", scope: "project" as const },
    { name: "session", scope: "session" as const },
  ])("supports an explicit $name registry without the other scopes", async ({ name, scope }) => {
    const functionName = `${name}Only`;
    const source = `async function ${functionName}({}) { return "${name}"; }`;
    const savedFunctions = new Map([[functionName, source]]);
    const options = {
      unifiedFunctions: true,
      ...(scope === "user" ? { userFunctions: savedFunctions } : {}),
      ...(scope === "project" ? { projectFunctions: savedFunctions } : {}),
      ...(scope === "session" ? { sessionFunctions: savedFunctions } : {}),
    };
    await expect(
      runInSandbox(`async ({ ${functionName} }) => ${functionName}()`, async () => null, options),
    ).resolves.toBe(name);
  });

  it("rejects an effective root missing from its declared scope", async () => {
    await expect(
      runInSandbox("async ({ missingScoped }) => missingScoped()", async () => null, {
        unifiedFunctions: true,
      }),
    ).rejects.toThrow("Property 'missingScoped' does not exist");
  });

  it("attributes nested and concurrent saved-function capability calls", async () => {
    const savedFunctions = new Map([
      ["outer", "async function outer({ inner }, input) { return inner(input); }"],
      ["inner", "async function inner({ context: { get } }, input) { await get(); return input; }"],
    ]);
    const traces: CapabilityTrace[] = [];
    await runInSandbox(
      'async ({ outer, inner }) => Promise.all([outer("nested"), inner("direct")])',
      async ({ capability, method }) => {
        if (capability === "__pit" && method === "savedFunctionRun") {
          return null;
        }
        if (capability === "context" && method === "get") {
          return { cwd: "/tmp" };
        }
        throw new Error("unexpected capability call");
      },
      {
        unifiedFunctions: true,
        projectFunctions: new Map([["outer", savedFunctions.get("outer") as string]]),
        sessionFunctions: new Map([["inner", savedFunctions.get("inner") as string]]),
        onCapabilityTrace: (trace) => traces.push(trace),
      },
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
        `async function runTests({}, input: { coverage?: boolean } = {}) {
        return { code: input.coverage ? 1 : 0, output: "done" };
      }`,
      ],
    ]);
    expect(() =>
      validateTypeScript("async ({ runTests }) => runTests({ coverage: true })", savedFunctions),
    ).not.toThrow();
    expect(() =>
      validateTypeScript(`async ({ runTests }) => runTests({ coverage: "yes" })`, savedFunctions),
    ).toThrow(/string.*boolean/);
    expect(() =>
      validateTypeScript("async ({ runTests }) => (await runTests()).missing", savedFunctions),
    ).toThrow(/Property 'missing' does not exist/);
  });

  it("annotates function failures and rejects multi-function cycles", async () => {
    const handler = async () => null;
    const failed = new Map([["broken", `async function broken({}) { throw new Error("boom"); }`]]);
    await expect(
      runInSandbox("async ({ broken }) => broken()", handler, {
        unifiedFunctions: true,
        sessionFunctions: failed,
      }),
    ).rejects.toThrow('Function "broken" failed: boom');

    const recursive = new Map([
      ["first", "async function first({ second }) { return second(); }"],
      ["second", "async function second({ first }) { return first(); }"],
    ]);
    await expect(
      runInSandbox("async ({ first }) => first()", handler, {
        unifiedFunctions: true,
        sessionFunctions: recursive,
      }),
    ).rejects.toThrow("function dependency cycle: first -> second -> first");
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

    const bounded = await runInSandbox(
      `() => { throw new Error("x".repeat(20_000)); }`,
      async () => null,
    ).then(
      () => {
        throw new Error("expected sandbox failure");
      },
      (error: unknown) => error as SandboxRemoteError,
    );
    expect(Buffer.byteLength(bounded.message)).toBeLessThanOrEqual(8_000);
    expect(bounded.remoteTruncated).toBe(true);
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

  it("contextually types expressions using active saved functions", () => {
    const savedFunctions = new Map([["answer", "async function answer() { return 42; }"]]);
    expect(() => validateTypeScript("answer()", savedFunctions)).not.toThrow();
    expect(() => validateTypeScript("missing()", savedFunctions)).toThrow(
      /Cannot find name 'missing'[\s\S]*Available saved functions: answer/,
    );
  });

  it.each<{ name: string; source: string }>([
    { name: "bare namespace", source: "saved.list()" },
    { name: "destructured capability", source: "async ({ saved }) => saved.list()" },
    {
      name: "capability property",
      source: "async (capabilities) => capabilities.saved.list()",
    },
  ])("suggests the functions capability for $name", ({ source }) => {
    expect(() => validateTypeScript(source)).toThrow(
      'There is no "saved" capability. Use async ({ functions }) => functions.listAll()',
    );
  });

  it("still permits a saved function named saved", () => {
    const savedFunctions = new Map([["saved", "async function saved() { return true; }"]]);
    expect(() => validateTypeScript("saved()", savedFunctions)).not.toThrow();
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
    await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 5_000 });
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
