import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FunctionExecutor } from "./executor.js";
import { nodeFunctionExecutor } from "./node-executor.js";
import { createWasmtimeFunctionExecutor, type WasmtimeAddon } from "./wasmtime-executor.js";

export const WASMTIME_PREBUILT_TARGETS = [
  "linux-arm64",
  "linux-x64",
  "darwin-arm64",
  "darwin-x64",
  "win32-arm64",
  "win32-x64",
] as const;

const supportedTargets = new Set<string>(WASMTIME_PREBUILT_TARGETS);
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
  artifactExists(path: string): boolean;
  warn(message: string): void;
}

const defaultOperations: WasmtimeLoaderOperations = {
  loadAddon: (path) => createRequire(import.meta.url)(path) as WasmtimeAddon,
  readComponent: (path) => new Uint8Array(readFileSync(path)),
  artifactExists: existsSync,
  warn: (message) => process.emitWarning(message, { code: "PIT_NODE_EXECUTOR_FALLBACK" }),
};

function defaultArtifactPaths(
  platform: NodeJS.Platform,
  architecture: string,
): { target: string; addonPath: string; componentPath: string } | undefined {
  const target = `${platform}-${architecture}`;
  if (!supportedTargets.has(target)) return;
  const directory = fileURLToPath(new URL(`../../native/prebuilds/${target}/`, import.meta.url));
  return {
    target,
    addonPath: resolve(directory, ADDON_FILE),
    componentPath: resolve(directory, COMPONENT_FILE),
  };
}

function fallbackToNode(message: string, operations: WasmtimeLoaderOperations): FunctionExecutor {
  operations.warn(`${message}; using the deprecated Node executor`);
  return nodeFunctionExecutor;
}

/**
 * Selects Pit's function executor. Wasmtime is the default. Unsupported or
 * unavailable implicit prebuilds fall back to Node; explicit Wasmtime
 * configuration fails instead of silently changing the requested backend.
 */
export function configuredFunctionExecutor(
  config: WasmtimeBackendConfig = {
    backend: process.env.PIT_FUNCTION_EXECUTOR,
    addonPath: process.env.PIT_WASMTIME_ADDON,
    componentPath: process.env.PIT_WASMTIME_COMPONENT,
  },
  operationOverrides: Partial<WasmtimeLoaderOperations> = {},
): FunctionExecutor {
  const operations = { ...defaultOperations, ...operationOverrides };
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
  if (hasAddonPath && hasComponentPath) {
    return createWasmtimeFunctionExecutor({
      addon: operations.loadAddon(resolve(config.addonPath as string)),
      component: operations.readComponent(resolve(config.componentPath as string)),
    });
  }

  const target = `${config.platform ?? process.platform}-${config.architecture ?? process.arch}`;
  const paths = defaultArtifactPaths(
    config.platform ?? process.platform,
    config.architecture ?? process.arch,
  );
  if (!paths) {
    const message = `Pit Wasmtime execution does not support ${target}`;
    if (config.backend === "wasmtime") throw new Error(message);
    return fallbackToNode(message, operations);
  }
  if (
    !operations.artifactExists(paths.addonPath) ||
    !operations.artifactExists(paths.componentPath)
  ) {
    const message = `Pit Wasmtime prebuild for ${paths.target} is unavailable`;
    if (config.backend === "wasmtime") throw new Error(message);
    return fallbackToNode(message, operations);
  }
  return createWasmtimeFunctionExecutor({
    addon: operations.loadAddon(paths.addonPath),
    component: operations.readComponent(paths.componentPath),
  });
}
