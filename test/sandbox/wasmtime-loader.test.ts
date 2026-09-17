import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { nodeFunctionExecutor } from "../../src/sandbox/run.js";
import { configuredFunctionExecutor } from "../../src/sandbox/wasmtime-loader.js";

describe("configuredFunctionExecutor", () => {
  it("selects the current host target when none is injected", () => {
    const operations = {
      loadAddon: vi.fn(() => ({ executeQueuedJavascript: vi.fn() })),
      readComponent: vi.fn(() => new Uint8Array([1, 2, 3])),
    };
    let outcome = "loaded";
    try {
      configuredFunctionExecutor({}, operations);
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error);
    }
    const target = `${process.platform}-${process.arch}`;
    expect(outcome).toBe(
      target === "linux-arm64"
        ? "loaded"
        : `Pit Wasmtime execution does not support ${target}; set PIT_FUNCTION_EXECUTOR=node to use the deprecated Node executor`,
    );
  });

  it("loads the Linux ARM64 Wasmtime prebuild by default", () => {
    const loadAddon = vi.fn(() => ({ executeQueuedJavascript: vi.fn() }));
    const readComponent = vi.fn(() => new Uint8Array([1, 2, 3]));

    expect(
      configuredFunctionExecutor(
        { platform: "linux", architecture: "arm64" },
        { loadAddon, readComponent },
      ),
    ).not.toBe(nodeFunctionExecutor);
    expect(loadAddon).toHaveBeenCalledWith(
      expect.stringMatching(/native\/prebuilds\/linux-arm64\/pit_wasmtime_executor\.node$/),
    );
    expect(readComponent).toHaveBeenCalledWith(
      expect.stringMatching(/native\/prebuilds\/linux-arm64\/pit_queued_quickjs_guest\.wasm$/),
    );
  });

  it("retains Node as an explicit deprecated fallback and rejects unknown backends", () => {
    expect(configuredFunctionExecutor({ backend: "node" })).toBe(nodeFunctionExecutor);
    expect(() => configuredFunctionExecutor({ backend: "unknown" })).toThrow(
      "Unknown Pit function executor",
    );
  });

  it("rejects unsupported default targets", () => {
    expect(() => configuredFunctionExecutor({ platform: "darwin", architecture: "arm64" })).toThrow(
      "does not support darwin-arm64",
    );
  });

  it("requires explicit native artifact paths together", () => {
    expect(() =>
      configuredFunctionExecutor({ backend: "wasmtime", addonPath: "native/addon.node" }),
    ).toThrow("must be set together");
    expect(() =>
      configuredFunctionExecutor({ backend: "wasmtime", componentPath: "native/guest.wasm" }),
    ).toThrow("must be set together");
  });

  it("loads resolved explicit artifacts into a Wasmtime executor", () => {
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

  it("loads environment artifact overrides with default filesystem operations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pit-wasmtime-loader-"));
    try {
      const addon = join(directory, "addon.cjs");
      const component = join(directory, "guest.wasm");
      await Promise.all([
        writeFile(addon, "module.exports = { executeQueuedJavascript() {} };"),
        writeFile(component, new Uint8Array([0, 97, 115, 109])),
      ]);
      vi.stubEnv("PIT_FUNCTION_EXECUTOR", "wasmtime");
      vi.stubEnv("PIT_WASMTIME_ADDON", addon);
      vi.stubEnv("PIT_WASMTIME_COMPONENT", component);

      expect(configuredFunctionExecutor()).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux" && process.arch === "arm64")(
    "executes through the packaged default prebuild",
    async () => {
      const executor = configuredFunctionExecutor({});
      await expect(
        executor.execute(
          {
            compiled:
              "async () => await new Promise((resolve) => setTimeout(() => resolve(42), 10))",
            effects: [],
          },
          async () => {
            throw new Error("unexpected capability call");
          },
          { memoryLimitMb: 64, timeoutMs: 5_000 },
        ),
      ).resolves.toBe(42);
    },
  );
});
