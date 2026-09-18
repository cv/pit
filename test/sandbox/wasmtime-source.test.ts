import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { prepareSandboxProgram } from "../../src/sandbox/program.js";
import { createWasmtimeGuestSource } from "../../src/sandbox/wasmtime-source.js";

describe("createWasmtimeGuestSource", () => {
  it("discards console output without entering WASI or adding host requests", async () => {
    const program = await prepareSandboxProgram(
      `async ({}) => {
      console.log("log"); console.warn("warning"); console.error("error");
      return 42;
    }`,
      {},
    );
    const inheritedConsole = vi.fn(() => {
      throw new Error("WASI console must not run");
    });
    const pitCall = vi.fn(async (_message: string) => "{}");
    await runInNewContext(`(async () => { ${createWasmtimeGuestSource(program, undefined)} })()`, {
      console: { log: inheritedConsole, warn: inheritedConsole, error: inheritedConsole },
      pitCall,
    });
    expect(inheritedConsole).not.toHaveBeenCalled();
    expect(pitCall).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: "result", value: 42 }));
  });

  it("wraps compiled programs with bounded host RPC and result delivery", async () => {
    const program = await prepareSandboxProgram(
      "async ({ context: { get } }, input: { value: number }) => ({ context: await get(), input })",
      { input: { value: 42 } },
    );
    const source = createWasmtimeGuestSource(program, { value: 42 });

    expect(source).toContain("pitCall(JSON.stringify");
    expect(source).not.toContain('method: "savedFunctionRun"');
    expect(source).toContain('type: "result"');
    expect(source).toContain('{"value":42}');
    expect(source).toContain(JSON.stringify(program.compiled));
    expect(source).not.toContain("process.");
  });

  it("embeds undefined input without serializing it as text", async () => {
    const program = await prepareSandboxProgram("async ({}) => 42", {});
    const source = createWasmtimeGuestSource(program, undefined);
    expect(source).toContain("\n  undefined,\n");
  });
});
