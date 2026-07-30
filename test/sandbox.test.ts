import { describe, expect, it, vi } from "vitest";
import { runInSandbox } from "../src/sandbox.js";

describe("runInSandbox", () => {
  it("executes TypeScript and returns a copied value", async () => {
    const result = await runInSandbox(
      `async (): Promise<{ answer: number }> => ({ answer: 6 * 7 })`,
      async () => { throw new Error("unexpected capability call"); },
    );
    expect(result).toEqual({ answer: 42 });
  });

  it("provides destructured capabilities through RPC", async () => {
    const handler = vi.fn(async (_capability: string, _method: string, args: unknown[]) =>
      Number(args[0]) + Number(args[1]),
    );
    const result = await runInSandbox(
      `async ({ maths }) => ({ value: await maths.add(20, 22) })`,
      handler,
    );
    expect(result).toEqual({ value: 42 });
    expect(handler).toHaveBeenCalledWith("maths", "add", [20, 22]);
  });

  it("propagates capability errors", async () => {
    await expect(runInSandbox(
      `async ({ nope }) => nope.fail()`,
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
    await expect(runInSandbox(`async ({ broken }) => broken.call()`, async () => { throw "string failure"; }))
      .rejects.toThrow("string failure");
  });

  it("does not reply after execution has timed out", async () => {
    await expect(runInSandbox(`async ({ slow }) => slow.call()`, async () => {
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
    await expect(runInSandbox(`42`, async () => null)).rejects.toThrow("must evaluate to a function");
    await expect(runInSandbox(`(() =>`, async () => null)).rejects.toThrow();
  });

  it("rejects values that cannot cross the JSON wire", async () => {
    await expect(runInSandbox(`() => 1n`, async () => null)).rejects.toThrow(/BigInt/);
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
