import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import type { FunctionExecutor } from "./executor.js";
import { createWasmtimeFunctionExecutor, type WasmtimeAddon } from "./wasmtime-executor.js";

export interface WasmtimeBackendConfig {
  backend?: string | undefined;
  addonPath?: string | undefined;
  componentPath?: string | undefined;
}

interface WasmtimeLoaderOperations {
  loadAddon(path: string): WasmtimeAddon;
  readComponent(path: string): Uint8Array;
}

const defaultOperations: WasmtimeLoaderOperations = {
  loadAddon: (path) => createRequire(import.meta.url)(path) as WasmtimeAddon,
  readComponent: (path) => new Uint8Array(readFileSync(path)),
};

export function configuredFunctionExecutor(
  config: WasmtimeBackendConfig = {
    backend: process.env.PIT_FUNCTION_EXECUTOR,
    addonPath: process.env.PIT_WASMTIME_ADDON,
    componentPath: process.env.PIT_WASMTIME_COMPONENT,
  },
  operations: WasmtimeLoaderOperations = defaultOperations,
): FunctionExecutor | undefined {
  if (!config.backend || config.backend === "node") return;
  if (config.backend !== "wasmtime") {
    throw new Error(`Unknown Pit function executor: ${config.backend}`);
  }
  if (!config.addonPath || !config.componentPath) {
    throw new Error("Wasmtime execution requires PIT_WASMTIME_ADDON and PIT_WASMTIME_COMPONENT");
  }
  const addonPath = resolve(config.addonPath);
  const componentPath = resolve(config.componentPath);
  return createWasmtimeFunctionExecutor({
    addon: operations.loadAddon(addonPath),
    component: operations.readComponent(componentPath),
  });
}
