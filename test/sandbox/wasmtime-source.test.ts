import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { prepareSandboxProgram } from "../../src/sandbox/program.js";
import { createWasmtimeGuestSource } from "../../src/sandbox/wasmtime-source.js";

async function runGuest(
  source: string,
  input: unknown,
  pitCall: (message: string) => Promise<string>,
  globals: object = {},
) {
  const program = await prepareSandboxProgram(source, { input });
  // The VM exercises our generated JavaScript; actual Wasm isolation is tested separately.
  return runInNewContext(`(async () => { ${createWasmtimeGuestSource(program, input)} })()`, {
    ...globals,
    pitCall,
  });
}

describe("generated Wasmtime guest behavior", () => {
  it("discards console output without entering WASI or adding host requests", async () => {
    const inheritedConsole = vi.fn(() => {
      throw new Error("WASI console must not run");
    });
    const pitCall = vi.fn(async (_message: string) => "{}");
    await runGuest(
      'async ({}) => { console.log("log"); console.warn("warning"); console.error("error"); return 42; }',
      undefined,
      pitCall,
      { console: { log: inheritedConsole, warn: inheritedConsole, error: inheritedConsole } },
    );
    expect(inheritedConsole).not.toHaveBeenCalled();
    expect(pitCall.mock.calls.map(([message]) => JSON.parse(message))).toEqual([
      { type: "result", value: 42 },
    ]);
  });

  it("delivers host replies and the supplied input to the result channel without Node globals", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const pitCall = async (message: string) => {
      const frame = JSON.parse(message) as Record<string, unknown>;
      requests.push(frame);
      return frame.type === "call" ? JSON.stringify({ value: { cwd: "/virtual-project" } }) : "{}";
    };
    await runGuest(
      "async ({ context: { get } }, input: { value: number }) => ({ cwd: (await get()).cwd, input })",
      { value: 42 },
      pitCall,
    );
    expect(requests).toEqual([
      { type: "call", id: expect.any(Number), capability: "context", method: "get", args: [] },
      { type: "result", value: { cwd: "/virtual-project", input: { value: 42 } } },
    ]);
  });

  it.each<{ name: string; input: unknown; expected: object }>([
    {
      name: "undefined",
      input: undefined,
      expected: { isUndefined: true, isNull: false, type: "undefined" },
    },
    { name: "null", input: null, expected: { isUndefined: false, isNull: true, type: "object" } },
    {
      name: "literal undefined string",
      input: "undefined",
      expected: { isUndefined: false, isNull: false, type: "string" },
    },
  ])("preserves $name input semantics", async ({ input, expected }) => {
    const pitCall = vi.fn(async (_message: string) => "{}");
    await runGuest(
      "async ({}, input: unknown) => ({ isUndefined: input === undefined, isNull: input === null, type: typeof input })",
      input,
      pitCall,
    );
    expect(pitCall.mock.calls.map(([message]) => JSON.parse(message))).toEqual([
      { type: "result", value: expected },
    ]);
  });

  it("propagates a rejected host reply instead of sending a successful result", async () => {
    const pitCall = vi.fn(async (_message: string) =>
      JSON.stringify({ error: "permission denied" }),
    );
    await expect(
      runGuest('async ({ workspace: { read } }) => read("restricted.txt")', undefined, pitCall),
    ).rejects.toThrow("permission denied");
    expect(pitCall.mock.calls.map(([message]) => JSON.parse(message))).toEqual([
      {
        type: "call",
        id: expect.any(Number),
        capability: "workspace",
        method: "read",
        args: ["restricted.txt"],
      },
    ]);
  });
});
