import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { PreparedSandboxProgram } from "../../src/sandbox/program.js";
import { runWithFunctionExecutor } from "../../src/sandbox/run.js";
import {
  configuredFunctionExecutor,
  WASMTIME_PREBUILT_TARGETS,
  type WasmtimeRuntimeConfig,
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

const program: PreparedSandboxProgram = { compiled: "async () => 42", effects: [] };
const options = { memoryLimitMb: 64, timeoutMs: 5_000 };

function availableOperations() {
  return {
    loadAddon: vi.fn(() => ({
      async executeQueuedJavascript(
        _component: Uint8Array,
        _source: string,
        callback: (request: string) => Promise<string>,
      ) {
        await callback(JSON.stringify({ type: "result", value: "loaded" }));
        return true;
      },
    })),
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

  it.each(supportedTargets)("loads the $name prebuild", async ({ platform, architecture }) => {
    const operations = availableOperations();
    const executor = configuredFunctionExecutor({ platform, architecture }, operations);
    const target = `${platform}-${architecture}`;

    await expect(executor.execute(program, async () => null, options)).resolves.toBe("loaded");
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
    configuredFunctionExecutor({}, operations);
    expect(operations.loadAddon).toHaveBeenCalledWith(
      expect.stringContaining(`${process.platform}-${process.arch}`),
    );
  });

  it.each<{
    name: string;
    config: WasmtimeRuntimeConfig;
    override?: (operations: ReturnType<typeof availableOperations>) => void;
    reason: string;
  }>([
    {
      name: "an unsupported target",
      config: { platform: "freebsd", architecture: "riscv64" },
      reason: "Pit has no Wasmtime prebuild for freebsd-riscv64",
    },
    {
      name: "a missing prebuild",
      config: { platform: "darwin", architecture: "arm64" },
      override: (operations) => operations.artifactExists.mockReturnValue(false),
      reason: "Pit's Wasmtime prebuild for darwin-arm64 is not installed",
    },
    {
      name: "an addon that fails to load",
      config: { platform: "linux", architecture: "x64" },
      override: (operations) =>
        operations.loadAddon.mockImplementation(() => {
          throw new Error("incompatible native ABI\nRequire stack:\n- /pit/src/sandbox/loader.ts");
        }),
      reason: "could not load the Wasmtime prebuild for linux-x64: incompatible native ABI",
    },
    {
      name: "a non-Error load failure",
      config: { platform: "linux", architecture: "x64" },
      override: (operations) =>
        operations.loadAddon.mockImplementation(() => {
          throw "native load refused";
        }),
      reason: "native load refused",
    },
    {
      name: "an unreadable configured component",
      config: { addonPath: "custom.node", componentPath: "custom.wasm" },
      override: (operations) =>
        operations.readComponent.mockImplementation(() => {
          throw new Error("component read failed");
        }),
      reason: "could not load the configured Wasmtime runtime: component read failed",
    },
    {
      name: "only one configured artifact path",
      config: { addonPath: "native/addon.node" },
      reason: "PIT_WASMTIME_ADDON and PIT_WASMTIME_COMPONENT must be set together",
    },
  ])(
    "stays loadable and explains $name on every execution",
    async ({ config, override, reason }) => {
      const operations = availableOperations();
      override?.(operations);
      const executor = configuredFunctionExecutor(config, operations);

      expect(operations.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(reason));
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(executor.execute(program, async () => null, options)).rejects.toThrow(
          new RegExp(`${reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*Reinstall or update Pit`),
        );
      }
      // Loader require stacks name Pit's own files, not the cause.
      const failure = await executor
        .execute(program, async () => null, options)
        .then(
          () => new Error("expected an unavailable runtime"),
          (error: unknown) => error as Error,
        );
      expect(failure.message).not.toContain("Require stack");
    },
  );

  it("loads resolved explicit artifacts into a Wasmtime executor", () => {
    const operations = availableOperations();
    configuredFunctionExecutor(
      { addonPath: "native/addon.node", componentPath: "native/guest.wasm" },
      operations,
    );

    expect(operations.loadAddon).toHaveBeenCalledWith(
      expect.stringMatching(/native\/addon\.node$/),
    );
    expect(operations.readComponent).toHaveBeenCalledWith(
      expect.stringMatching(/native\/guest\.wasm$/),
    );
    expect(operations.warn).not.toHaveBeenCalled();
  });

  it("executes with the environment-selected addon and component using default filesystem operations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pit-wasmtime-loader-"));
    try {
      const addon = join(directory, "addon.cjs");
      const component = join(directory, "guest.wasm");
      await Promise.all([
        writeFile(
          addon,
          `module.exports = {
            async executeQueuedJavascript(component, _source, callback) {
              await callback(JSON.stringify({
                type: "result",
                value: { addon: "environment-override", component: Array.from(component) },
              }));
              return true;
            },
          };`,
        ),
        writeFile(component, new Uint8Array([0, 97, 115, 109])),
      ]);
      vi.stubEnv("PIT_WASMTIME_ADDON", addon);
      vi.stubEnv("PIT_WASMTIME_COMPONENT", component);

      // The addon reports its identity and received bytes; it does not emulate a guest VM.
      await expect(
        runWithFunctionExecutor(
          'async ({}) => "guest-result"',
          async () => {
            throw new Error("unexpected capability call");
          },
          options,
          configuredFunctionExecutor(),
        ),
      ).resolves.toEqual({ addon: "environment-override", component: [0, 97, 115, 109] });
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("executes through the installed default prebuild", async () => {
    await expect(
      runWithFunctionExecutor(
        `async ({}) => {
          console.log("diagnostic"); console.warn("warning"); console.error("error");
          await new Promise<void>(resolve => setTimeout(resolve, 10));
          return { answer: 42, process: typeof (globalThis as any).process };
        }`,
        async () => {
          throw new Error("unexpected capability call");
        },
        options,
        configuredFunctionExecutor({}),
      ),
    ).resolves.toEqual({ answer: 42, process: "undefined" });
  });
});
