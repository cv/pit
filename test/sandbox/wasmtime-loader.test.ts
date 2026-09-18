import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { nodeFunctionExecutor } from "../../src/sandbox/run.js";
import {
  configuredFunctionExecutor,
  WASMTIME_PREBUILT_TARGETS,
} from "../../src/sandbox/wasmtime-loader.js";

const supportedTargets: Array<{
  name: string;
  platform: NodeJS.Platform;
  architecture: string;
}> = [
  { name: "Linux ARM64", platform: "linux", architecture: "arm64" },
  { name: "Linux x64", platform: "linux", architecture: "x64" },
  { name: "macOS ARM64", platform: "darwin", architecture: "arm64" },
  { name: "macOS x64", platform: "darwin", architecture: "x64" },
  { name: "Windows ARM64", platform: "win32", architecture: "arm64" },
  { name: "Windows x64", platform: "win32", architecture: "x64" },
];

function availableOperations() {
  return {
    loadAddon: vi.fn(() => ({ executeQueuedJavascript: vi.fn() })),
    readComponent: vi.fn(() => new Uint8Array([1, 2, 3])),
    artifactExists: vi.fn(() => true),
    warn: vi.fn(),
  };
}

describe("configuredFunctionExecutor", () => {
  it("declares every tested prebuild target", () => {
    expect(WASMTIME_PREBUILT_TARGETS).toEqual(
      supportedTargets.map(({ platform, architecture }) => `${platform}-${architecture}`),
    );
  });

  it.each(supportedTargets)("loads the $name prebuild", ({ platform, architecture }) => {
    const operations = availableOperations();
    const executor = configuredFunctionExecutor({ platform, architecture }, operations);
    const target = `${platform}-${architecture}`;

    expect(executor).not.toBe(nodeFunctionExecutor);
    expect(operations.loadAddon).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`native/prebuilds/${target}/pit_wasmtime_executor\\.node$`)),
    );
    expect(operations.readComponent).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`native/prebuilds/${target}/pit_queued_quickjs_guest\\.wasm$`),
      ),
    );
    expect(operations.warn).not.toHaveBeenCalled();
  });

  it("selects the current host target when none is injected", () => {
    const operations = availableOperations();
    expect(configuredFunctionExecutor({}, operations)).not.toBe(nodeFunctionExecutor);
    expect(operations.loadAddon).toHaveBeenCalled();
  });

  it("falls back to Node when an implicit target is unsupported", () => {
    const operations = availableOperations();
    const executor = configuredFunctionExecutor(
      { platform: "freebsd", architecture: "riscv64" },
      operations,
    );

    expect(executor).toBe(nodeFunctionExecutor);
    expect(operations.warn).toHaveBeenCalledWith(
      expect.stringContaining("does not support freebsd-riscv64"),
    );
  });

  it("falls back to Node when an implicit prebuild is unavailable", () => {
    const operations = { ...availableOperations(), artifactExists: vi.fn(() => false) };
    const executor = configuredFunctionExecutor(
      { platform: "darwin", architecture: "arm64" },
      operations,
    );

    expect(executor).toBe(nodeFunctionExecutor);
    expect(operations.warn).toHaveBeenCalledWith(
      expect.stringContaining("prebuild for darwin-arm64 is unavailable"),
    );
    expect(operations.loadAddon).not.toHaveBeenCalled();
  });

  it("keeps explicit Wasmtime target failures strict", () => {
    const unsupported = availableOperations();
    expect(() =>
      configuredFunctionExecutor(
        { backend: "wasmtime", platform: "freebsd", architecture: "x64" },
        unsupported,
      ),
    ).toThrow("does not support freebsd-x64");

    const unavailable = { ...availableOperations(), artifactExists: vi.fn(() => false) };
    expect(() =>
      configuredFunctionExecutor(
        { backend: "wasmtime", platform: "linux", architecture: "x64" },
        unavailable,
      ),
    ).toThrow("prebuild for linux-x64 is unavailable");
  });

  it("retains Node as an explicit deprecated fallback and rejects unknown backends", () => {
    expect(configuredFunctionExecutor({ backend: "node" })).toBe(nodeFunctionExecutor);
    expect(() => configuredFunctionExecutor({ backend: "unknown" })).toThrow(
      "Unknown Pit function executor",
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
    const operations = availableOperations();
    const executor = configuredFunctionExecutor(
      {
        backend: "wasmtime",
        addonPath: "native/addon.node",
        componentPath: "native/guest.wasm",
      },
      operations,
    );

    expect(executor).toBeDefined();
    expect(operations.loadAddon).toHaveBeenCalledWith(
      expect.stringMatching(/native\/addon\.node$/),
    );
    expect(operations.readComponent).toHaveBeenCalledWith(
      expect.stringMatching(/native\/guest\.wasm$/),
    );
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

  it.each<{ name: string; failure: unknown }>([
    { name: "ABI error", failure: new Error("incompatible native ABI") },
    { name: "non-Error failure", failure: "native load refused" },
  ])("falls back for an implicit prebuild $name", ({ failure }) => {
    const operations = availableOperations();
    operations.loadAddon.mockImplementation(() => {
      throw failure;
    });
    expect(configuredFunctionExecutor({ platform: "linux", architecture: "x64" }, operations)).toBe(
      nodeFunctionExecutor,
    );
    expect(operations.warn).toHaveBeenCalledWith(expect.stringContaining("could not be loaded"));
  });

  it("does not hide load failures when Wasmtime was explicitly requested", () => {
    const operations = availableOperations();
    operations.readComponent.mockImplementation(() => {
      throw new Error("component read failed");
    });
    expect(() =>
      configuredFunctionExecutor(
        { backend: "wasmtime", platform: "linux", architecture: "x64" },
        operations,
      ),
    ).toThrow("component read failed");
    expect(() =>
      configuredFunctionExecutor(
        { addonPath: "custom.node", componentPath: "custom.wasm" },
        operations,
      ),
    ).toThrow("component read failed");
    expect(operations.warn).not.toHaveBeenCalled();
  });
});
