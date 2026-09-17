import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("loads native artifacts with the default filesystem operations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pit-wasmtime-loader-"));
    try {
      const addon = join(directory, "addon.cjs");
      const component = join(directory, "guest.wasm");
      await Promise.all([
        writeFile(addon, "module.exports = { executeQueuedJavascript() {} };"),
        writeFile(component, new Uint8Array([0, 97, 115, 109])),
      ]);

      expect(
        configuredFunctionExecutor({
          backend: "wasmtime",
          addonPath: addon,
          componentPath: component,
        }),
      ).toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
