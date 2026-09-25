import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FunctionExecutor } from "./executor.js";
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
const RECOVERY =
  "Reinstall or update Pit so its installer can download the prebuild, or set " +
  "PIT_WASMTIME_ADDON and PIT_WASMTIME_COMPONENT to a local build.";

export interface WasmtimeRuntimeConfig {
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
  warn: (message) => process.emitWarning(message, { code: "PIT_WASMTIME_UNAVAILABLE" }),
};

function defaultArtifactPaths(
  target: string,
): { addonPath: string; componentPath: string } | undefined {
  if (!supportedTargets.has(target)) return;
  const directory = fileURLToPath(new URL(`../../native/prebuilds/${target}/`, import.meta.url));
  return {
    addonPath: resolve(directory, ADDON_FILE),
    componentPath: resolve(directory, COMPONENT_FILE),
  };
}

function errorDetail(error: unknown): string {
  // Module loaders append a require stack of Pit's own files; the first line names the cause.
  const message = error instanceof Error ? error.message : String(error);
  return (message.split("\n", 1)[0] ?? "").slice(0, 300);
}

/**
 * An executor for a host without a usable runtime. The extension still loads and the tool still
 * registers; each execution explains the cause and the recovery instead of failing at startup.
 */
export function unavailableFunctionExecutor(reason: string): FunctionExecutor {
  return {
    execute: () => Promise.reject(new Error(`${reason}. ${RECOVERY}`)),
  };
}

/**
 * Selects Pit's Wasmtime executor: explicit artifact paths when both are configured, otherwise
 * the installed prebuild for this host. There is no alternative runtime.
 */
export function configuredFunctionExecutor(
  config: WasmtimeRuntimeConfig = {
    addonPath: process.env.PIT_WASMTIME_ADDON,
    componentPath: process.env.PIT_WASMTIME_COMPONENT,
  },
  operationOverrides: Partial<WasmtimeLoaderOperations> = {},
): FunctionExecutor {
  const operations = { ...defaultOperations, ...operationOverrides };
  const unavailable = (reason: string): FunctionExecutor => {
    operations.warn(reason);
    return unavailableFunctionExecutor(reason);
  };
  const load = (paths: { addonPath: string; componentPath: string }, source: string) => {
    try {
      return createWasmtimeFunctionExecutor({
        addon: operations.loadAddon(paths.addonPath),
        component: operations.readComponent(paths.componentPath),
      });
    } catch (error) {
      return unavailable(`Pit could not load ${source}: ${errorDetail(error)}`);
    }
  };

  const hasAddonPath = config.addonPath !== undefined;
  const hasComponentPath = config.componentPath !== undefined;
  if (hasAddonPath !== hasComponentPath) {
    return unavailable("PIT_WASMTIME_ADDON and PIT_WASMTIME_COMPONENT must be set together");
  }
  if (hasAddonPath && hasComponentPath) {
    return load(
      {
        addonPath: resolve(config.addonPath as string),
        componentPath: resolve(config.componentPath as string),
      },
      "the configured Wasmtime runtime",
    );
  }

  const target = `${config.platform ?? process.platform}-${config.architecture ?? process.arch}`;
  const paths = defaultArtifactPaths(target);
  if (!paths) return unavailable(`Pit has no Wasmtime prebuild for ${target}`);
  if (
    !operations.artifactExists(paths.addonPath) ||
    !operations.artifactExists(paths.componentPath)
  ) {
    return unavailable(`Pit's Wasmtime prebuild for ${target} is not installed`);
  }
  return load(paths, `the Wasmtime prebuild for ${target}`);
}
