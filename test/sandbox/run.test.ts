import { describe, expect, it, vi } from "vitest";

import type { CapabilityTrace } from "../../src/execution/capability-trace.js";
import type { CapabilityRequest } from "../../src/sandbox/dispatcher.js";
import type { FunctionExecutor } from "../../src/sandbox/executor.js";
import { runWithFunctionExecutor } from "../../src/sandbox/run.js";
import { validateTypeScript } from "../../src/sandbox/validation.js";
import { runInSandbox, runRawProgram } from "../support/sandbox.js";

describe("runInSandbox", () => {
  it.each<{ name: string; source: string }>([
    { name: "process", source: "async ({}) => process.env.HOME" },
    { name: "require", source: 'async ({}) => require("node:fs")' },
    { name: "Buffer", source: 'async ({}) => Buffer.from("data")' },
  ])("rejects non-portable $name before invoking an executor", async ({ name, source }) => {
    const execute = vi.fn();
    const handler = vi.fn();
    await expect(runWithFunctionExecutor(source, handler, {}, { execute })).rejects.toThrow(
      `Cannot find name '${name}'`,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps supported console, timers, and undefined returns portable", async () => {
    await expect(
      runInSandbox(
        `async ({}) => {
      console.log("diagnostic"); console.warn("warning"); console.error("error");
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }`,
        async () => null,
      ),
    ).resolves.toBeUndefined();
  });

  it("executes TypeScript and returns a copied value", async () => {
    const result = await runInSandbox(
      "async ({}): Promise<{ answer: number }> => ({ answer: 6 * 7 })",
      async () => {
        throw new Error("unexpected capability call");
      },
    );
    expect(result).toEqual({ answer: 42 });
  });

  it("prepares and delegates programs through a backend-neutral executor", async () => {
    const execute = vi.fn(async () => ({ backend: "test" }));
    const executor: FunctionExecutor = { execute };
    const handler = async () => null;

    await expect(
      runWithFunctionExecutor(
        "async ({ context: { get } }, _input: { value: number }) => get()",
        handler,
        { input: { value: 1 }, memoryLimitMb: 64, timeoutMs: 250 },
        executor,
      ),
    ).resolves.toEqual({ backend: "test" });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ compiled: expect.any(String), effects: ["context.get"] }),
      handler,
      expect.objectContaining({
        input: { value: 1 },
        memoryLimitMb: 64,
        timeoutMs: 250,
      }),
    );
  });

  it("passes initial input as the function's second argument", async () => {
    const source = "async ({}, input: { value: number }) => ({ value: input.value * 2 })";
    await expect(runInSandbox(source, async () => null, { input: { value: 21 } })).resolves.toEqual(
      { value: 42 },
    );
    expect(() => validateTypeScript(source, new Map(), { value: "wrong" })).toThrow(
      /string.*number/,
    );
    await expect(runInSandbox("42", async () => null, { input: {} })).rejects.toThrow(
      "TypeScript programs must be function expressions",
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
      `async ({ shell: { exec } }) => ({ value: (await exec("sum")).code })`,
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
      `async ({ shell: { exec }, context: { get } }) => Promise.all([
        exec("secret command"),
        get(),
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
        "async ({ context: { get } }) => get()",
        async () => {
          throw new Error("host refused");
        },
        { onCapabilityTrace: (trace) => failed.push(trace) },
      ),
    ).rejects.toThrow("host refused");
    expect(failed.at(-1)).toMatchObject({ status: "failed", durationMs: expect.any(Number) });

    await expect(
      runInSandbox("async ({ context: { get } }) => get()", async () => ({ ok: true }), {
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
      runInSandbox("async ({ missingScoped }) => missingScoped()", async () => null, {}),
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
        sessionFunctions: failed,
      }),
    ).rejects.toThrow('Function "broken" failed: boom');

    const recursive = new Map([
      ["first", "async function first({ second }) { return second(); }"],
      ["second", "async function second({ first }) { return first(); }"],
    ]);
    await expect(
      runInSandbox("async ({ first }) => first()", handler, {
        sessionFunctions: recursive,
      }),
    ).rejects.toThrow("function dependency cycle: first -> second -> first");
  });

  it("reports guest errors by name and message without stack frames", async () => {
    const failure = await runInSandbox(
      `({}) => {
        const error = new TypeError("remote boom");
        error.stack = "TypeError: remote boom\\n    at frame (/private/path/0.js:1:1)";
        throw error;
      }`,
      async () => null,
    ).then(
      () => new Error("expected a guest failure"),
      (error: unknown) => error as Error,
    );

    expect(failure).toMatchObject({ name: "TypeError", message: "remote boom" });
    expect(`${failure.message} ${failure.stack}`).not.toMatch(/private\/path|<input>|pit-program/);
  });

  it("contextually types expressions using active saved functions", () => {
    const savedFunctions = new Map([["answer", "async function answer({}) { return 42; }"]]);
    expect(() =>
      validateTypeScript("async ({ answer }) => answer()", savedFunctions),
    ).not.toThrow();
    expect(() => validateTypeScript("async ({ missing }) => missing()", savedFunctions)).toThrow(
      /Property 'missing' does not exist[\s\S]*Available functions: answer/,
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
      'There is no "saved" namespace. Use async ({ functions: { listAll } }) => listAll()',
    );
  });

  it("still permits a saved function named saved", () => {
    const savedFunctions = new Map([["saved", "async function saved({}) { return true; }"]]);
    expect(() => validateTypeScript("async ({ saved }) => saved()", savedFunctions)).not.toThrow();
  });

  it("propagates capability errors", async () => {
    await expect(
      runInSandbox("async ({ context: { get } }) => get()", async () => {
        throw new Error("host refused");
      }),
    ).rejects.toThrow("host refused");
  });

  it("gives unvalidated guest code no host globals, modules, or ungranted capabilities", async () => {
    // Bypasses authoring validation: the runtime and the host's grants are the boundary.
    const result = await runRawProgram(`async () => ({
      globals: [typeof process, typeof require, typeof module, typeof fetch, typeof WebAssembly],
      module: await import("fs").then(() => "loaded", () => "unavailable"),
      direct: JSON.parse(await pitCall(JSON.stringify({
        type: "call", id: 1, capability: "shell", method: "exec", args: ["id"],
      }))),
    })`);

    expect(result).toEqual({
      globals: ["undefined", "undefined", "undefined", "undefined", "undefined"],
      module: "unavailable",
      direct: expect.objectContaining({ error: "Function grant does not allow shell.exec" }),
    });
  });

  it("bounds protocol frames in both directions", async () => {
    await expect(
      runInSandbox("async ({ context: { get } }) => get()", async () => "x".repeat(8_000_001)),
    ).rejects.toThrow(/Capability response exceeds RPC limit/);

    await expect(
      runInSandbox(
        `async ({ context: { get } }) => (get as any)("x".repeat(8_000_001))`,
        async () => null,
      ),
    ).rejects.toThrow(/request exceeds bounds/);
  });

  it("queues calls beyond the concurrency bound and rejects beyond the total bound", async () => {
    let active = 0;
    let maximum = 0;
    const completed = await runInSandbox(
      `async ({ context: { get } }) => (await Promise.all(Array.from({ length: 33 }, () => get()))).length`,
      async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 100));
        active--;
        return null;
      },
    );
    // The runtime runs up to 32 host calls at once and queues the rest instead of failing.
    expect(completed).toBe(33);
    expect(maximum).toBe(32);

    await expect(
      runInSandbox(
        `async ({ context: { get } }) => {
          for (let index = 0; index < 1025; index++) await get();
          return null;
        }`,
        async () => null,
      ),
    ).rejects.toThrow(/call limit exceeded/);
  });

  it("waits for floating capability calls before reporting success", async () => {
    let completed = false;
    const result = await runInSandbox(
      "async ({ context: { get } }) => { get(); return 42; }",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        completed = true;
        return null;
      },
    );
    expect(result).toBe(42);
    expect(completed).toBe(true);
  });

  // Budgets exceed runtime startup, which can take seconds on small CI runners (#136), so the
  // call is in flight when the deadline passes.
  it("enforces the deadline when a capability handler never settles", async () => {
    let invoked = false;
    const started = Date.now();
    await expect(
      runInSandbox(
        "async ({ context: { get } }) => get()",
        () => {
          invoked = true;
          return new Promise(() => {});
        },
        { timeoutMs: 10_000 },
      ),
    ).rejects.toThrow("timed out after 10000ms");
    expect(invoked).toBe(true);
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it("aborts cooperative capability handlers on timeout", async () => {
    let aborted = false;
    await expect(
      runInSandbox(
        "async ({ context: { get } }) => get()",
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
        { timeoutMs: 10_000 },
      ),
    ).rejects.toThrow("timed out");
    await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 5_000 });
  });

  it("handles non-Error capability failures", async () => {
    await expect(
      runInSandbox("async ({ context: { get } }) => get()", async () => {
        throw "string failure";
      }),
    ).rejects.toThrow("string failure");
  });

  it("does not reply after execution has timed out", async () => {
    await expect(
      runInSandbox(
        "async ({ context: { get } }) => get()",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return 1;
        },
        { timeoutMs: 10 },
      ),
    ).rejects.toThrow("timed out");
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  it("runs with an explicitly empty PATH and custom memory limit", async () => {
    const original = process.env.PATH;
    delete process.env.PATH;
    try {
      await expect(
        runInSandbox("({}) => 42", async () => null, { memoryLimitMb: 32 }),
      ).resolves.toBe(42);
    } finally {
      process.env.PATH = original;
    }
  });

  it("executes value expressions and rejects malformed source", async () => {
    await expect(runInSandbox("async ({}) => 42", async () => null)).resolves.toBe(42);
    await expect(runInSandbox("(() =>", async () => null)).rejects.toThrow();
  });

  it("rejects values that cannot cross the JSON wire", async () => {
    await expect(runInSandbox("({}) => 1n", async () => null)).rejects.toThrow(/bigint/i);
  });

  it("terminates runaway code", async () => {
    await expect(
      runInSandbox("({}) => { while (true) {} }", async () => null, { timeoutMs: 100 }),
    ).rejects.toThrow("timed out");
  });

  it("supports cancellation", async () => {
    const controller = new AbortController();
    const promise = runInSandbox("async ({}) => new Promise(() => {})", async () => null, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toThrow("cancelled");

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      runInSandbox("({}) => 1", async () => null, { signal: alreadyAborted.signal }),
    ).rejects.toThrow("cancelled");
  });

  it("validates resource limits", async () => {
    await expect(
      runInSandbox("({}) => 1", async () => null, { memoryLimitMb: 15 }),
    ).rejects.toThrow("at least 16");
    await expect(
      runInSandbox("({}) => 1", async () => null, { memoryLimitMb: Number.NaN }),
    ).rejects.toThrow("at least 16");
    await expect(runInSandbox("({}) => 1", async () => null, { timeoutMs: 0 })).rejects.toThrow(
      "positive",
    );
    await expect(
      runInSandbox("({}) => 1", async () => null, { timeoutMs: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow("positive");
  });
});
