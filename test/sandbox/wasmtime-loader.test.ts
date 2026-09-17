import { describe, expect, it, vi } from "vitest";

import { configuredFunctionExecutor } from "../../src/sandbox/wasmtime-loader.js";

describe("configuredFunctionExecutor", () => {
  it("uses Node by default and rejects unknown backends", () => {
    expect(configuredFunctionExecutor({})).toBeUndefined();
    expect(configuredFunctionExecutor({ backend: "node" })).toBeUndefined();
    expect(() => configuredFunctionExecutor({ backend: "unknown" })).toThrow(
      "Unknown Pit function executor",
    );
  });

  it("requires both native artifact paths", () => {
    expect(() => configuredFunctionExecutor({ backend: "wasmtime" })).toThrow(
      "PIT_WASMTIME_ADDON and PIT_WASMTIME_COMPONENT",
    );
  });

  it("loads resolved artifacts into a Wasmtime executor", () => {
    const executeQueuedJavascript = vi.fn();
    const loadAddon = vi.fn(() => ({ executeQueuedJavascript }));
    const readComponent = vi.fn(() => new Uint8Array([1, 2, 3]));
    const executor = configuredFunctionExecutor(
      {
        backend: "wasmtime",
        addonPath: "native/addon.node",
        componentPath: "native/guest.wasm",
      },
      { loadAddon, readComponent },
    );

    expect(executor).toBeDefined();
    expect(loadAddon).toHaveBeenCalledWith(expect.stringMatching(/native\/addon\.node$/));
    expect(readComponent).toHaveBeenCalledWith(expect.stringMatching(/native\/guest\.wasm$/));
  });
});
