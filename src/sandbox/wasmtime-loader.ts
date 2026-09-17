import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FunctionExecutor } from "./executor.js";
import { nodeFunctionExecutor } from "./node-executor.js";
import { createWasmtimeFunctionExecutor, type WasmtimeAddon } from "./wasmtime-executor.js";

const PREBUILT_TARGET = "linux-arm64";
const ADDON_FILE = "pit_wasmtime_executor.node";
const COMPONENT_FILE = "pit_queued_quickjs_guest.wasm";

export interface WasmtimeBackendConfig {
  backend?: string | undefined;
  addonPath?: string | undefined;
  componentPath?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  architecture?: string | undefined;
}

interface WasmtimeLoaderOperations {
  loadAddon(path: string): WasmtimeAddon;
  readComponent(path: string): Uint8Array;
}

const defaultOperations: WasmtimeLoaderOperations = {
  loadAddon: (path) => createRequire(import.meta.url)(path) as WasmtimeAddon,
  readComponent: (path) => new Uint8Array(readFileSync(path)),
};

function defaultArtifactPaths(platform: NodeJS.Platform, architecture: string) {
  const target = `${platform}-${architecture}`;
  if (target !== PREBUILT_TARGET) {
    throw new Error(
      `Pit Wasmtime execution does not support ${target}; set PIT_FUNCTION_EXECUTOR=node to use the deprecated Node executor`,
    );
  }
  const directory = fileURLToPath(
    new URL(`../../native/prebuilds/${PREBUILT_TARGET}/`, import.meta.url),
  );
  return {
    addonPath: resolve(directory, ADDON_FILE),
    componentPath: resolve(directory, COMPONENT_FILE),
  };
}

/**
 * Selects Pit's function executor. Wasmtime is the default; `node` is a
 * deprecated fallback for unsupported platforms and diagnostics.
 */
export function configuredFunctionExecutor(
  config: WasmtimeBackendConfig = {
    backend: process.env.PIT_FUNCTION_EXECUTOR,
    addonPath: process.env.PIT_WASMTIME_ADDON,
    componentPath: process.env.PIT_WASMTIME_COMPONENT,
  },
  operations: WasmtimeLoaderOperations = defaultOperations,
): FunctionExecutor {
  const backend = config.backend ?? "wasmtime";
  if (backend === "node") return nodeFunctionExecutor;
  if (backend !== "wasmtime") {
    throw new Error(`Unknown Pit function executor: ${backend}`);
  }

  const hasAddonPath = config.addonPath !== undefined;
  const hasComponentPath = config.componentPath !== undefined;
  if (hasAddonPath !== hasComponentPath) {
    throw new Error("PIT_WASMTIME_ADDON and PIT_WASMTIME_COMPONENT must be set together");
  }
  const paths =
    hasAddonPath && hasComponentPath
      ? {
          addonPath: resolve(config.addonPath as string),
          componentPath: resolve(config.componentPath as string),
        }
      : defaultArtifactPaths(
          config.platform ?? process.platform,
          config.architecture ?? process.arch,
        );
  return createWasmtimeFunctionExecutor({
    addon: operations.loadAddon(paths.addonPath),
    component: operations.readComponent(paths.componentPath),
  });
}
