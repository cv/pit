import { formatSize } from "@earendil-works/pi-coding-agent";

import { validateTypeScript } from "../sandbox/validation.js";
import { createLayeredFunctionRegistry } from "./definitions.js";
import { getFunctionDependencies } from "./dependencies.js";
import { validateFunctionId } from "./identifier.js";
import { getNamedFunctionName } from "./source.js";

const MAX_SAVED_FUNCTION_BYTES = 100_000;
const MAX_SAVED_FUNCTIONS = 64;
const MAX_SAVED_FUNCTION_TOTAL_BYTES = 1_000_000;
const SAVED_FUNCTION_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const RESERVED_FUNCTION_NAMES = new Set([
  "Array",
  "Boolean",
  "Date",
  "Error",
  "Infinity",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "Promise",
  "RegExp",
  "Set",
  "String",
  "console",
  "eval",
  "globalThis",
  "process",
  "undefined",
]);

export type FunctionRegistry = Map<string, string>;
export type FunctionScope = "global" | "user" | "project" | "session";

export function functionScopeRegistry(
  effective: ReadonlyMap<string, string>,
  user: ReadonlyMap<string, string>,
  project: ReadonlyMap<string, string>,
  session: ReadonlyMap<string, string>,
): Map<string, FunctionScope> {
  return new Map(
    [...effective.keys()].map((name) => {
      const scope: FunctionScope = session.has(name)
        ? "session"
        : project.has(name)
          ? "project"
          : user.has(name)
            ? "user"
            : "session";
      return [name, scope];
    }),
  );
}

export interface FunctionScopeRegistries {
  user: ReadonlyMap<string, string>;
  project: ReadonlyMap<string, string>;
  session: ReadonlyMap<string, string>;
}

export function functionRunScope(
  name: string,
  registries: FunctionScopeRegistries,
  attributedScope?: FunctionScope,
): FunctionScope {
  if (attributedScope) return attributedScope;
  if (registries.session.has(name)) return "session";
  if (registries.project.has(name)) return "project";
  return registries.user.has(name) ? "user" : "session";
}
export const FUNCTION_ENTRY_TYPE = "pit-function-definitions";
export type FunctionEntry =
  | { name: string; source: string; deleted?: never }
  | { name: string; deleted: true; source?: never };
export interface FunctionActivity {
  action: "set" | "run" | "remove";
  name: string;
  replaced?: boolean;
  scope?: FunctionScope;
}
export function validateSavedFunctionSource(source: string): void {
  if (Buffer.byteLength(source) > MAX_SAVED_FUNCTION_BYTES) {
    throw new Error(`saved function source exceeds ${formatSize(MAX_SAVED_FUNCTION_BYTES)}`);
  }
}

export function validateRegistryCapacity(
  registry: ReadonlyMap<string, string>,
  name: string,
  source: string,
): void {
  validateSavedFunctionSource(source);

  const sourceBytes = Buffer.byteLength(source);
  if (!registry.has(name) && registry.size >= MAX_SAVED_FUNCTIONS) {
    throw new Error(`saved function registry is limited to ${MAX_SAVED_FUNCTIONS} functions`);
  }
  const previousBytes = Buffer.byteLength(registry.get(name) ?? "");
  const currentBytes = [...registry.values()].reduce(
    (total, value) => total + Buffer.byteLength(value),
    0,
  );
  if (currentBytes - previousBytes + sourceBytes > MAX_SAVED_FUNCTION_TOTAL_BYTES) {
    throw new Error(
      `saved function registry exceeds ${formatSize(MAX_SAVED_FUNCTION_TOTAL_BYTES)} total source`,
    );
  }
}

export function validateEffectiveRegistryCapacity(registry: ReadonlyMap<string, string>): void {
  if (registry.size > MAX_SAVED_FUNCTIONS) {
    throw new Error(`saved function registry is limited to ${MAX_SAVED_FUNCTIONS} functions`);
  }
  const totalBytes = [...registry.values()].reduce(
    (total, source) => total + Buffer.byteLength(source),
    0,
  );
  if (totalBytes > MAX_SAVED_FUNCTION_TOTAL_BYTES) {
    throw new Error(
      `saved function registry exceeds ${formatSize(MAX_SAVED_FUNCTION_TOTAL_BYTES)} total source`,
    );
  }
}

export function validateSavedFunctionName(name: string): void {
  if (
    !SAVED_FUNCTION_NAME.test(name) ||
    name.startsWith("__pit") ||
    RESERVED_FUNCTION_NAMES.has(name)
  ) {
    throw new Error(
      "saved function name must be a non-reserved TypeScript identifier of at most 64 characters",
    );
  }
}

export function sessionFunctionId(source: string, functionId?: string): string | undefined {
  const declarationName = getNamedFunctionName(source);
  if (functionId !== undefined && !declarationName) {
    throw new Error("functionId requires a named top-level function");
  }
  if (!declarationName) return;
  validateSavedFunctionName(declarationName);
  getFunctionDependencies(source);
  const id = functionId ?? declarationName;
  validateFunctionId(id);
  if (id.split(".").at(-1) !== declarationName) {
    throw new Error(`functionId must end with the declaration name "${declarationName}"`);
  }
  return id;
}

export function validateFunctionRegistryIdentifiers(ids: Iterable<string>): void {
  const registry = createLayeredFunctionRegistry();
  for (const id of ids) {
    registry.set({ id, kind: "source", layer: "session", source: "" });
  }
}

export function reconstructFunctions(
  registry: FunctionRegistry,
  entries: readonly unknown[],
  baseFunctions: ReadonlyMap<string, string> = new Map(),

  capacityBaseFunctions: ReadonlyMap<string, string> = baseFunctions,
): void {
  registry.clear();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const entry = raw as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== FUNCTION_ENTRY_TYPE) {
      continue;
    }
    if (!entry.data || typeof entry.data !== "object") {
      continue;
    }
    const definition = entry.data as Partial<FunctionEntry>;
    if (typeof definition.name !== "string") {
      continue;
    }
    try {
      validateFunctionId(definition.name);
      if (definition.deleted === true) {
        registry.delete(definition.name);
        continue;
      }
      if (typeof definition.source !== "string") {
        continue;
      }
      sessionFunctionId(definition.source, definition.name);
      const capacityAvailable = new Map([...capacityBaseFunctions, ...registry]);
      validateRegistryCapacity(capacityAvailable, definition.name, definition.source);
      const available = new Map([...baseFunctions, ...registry]);
      available.set(definition.name, definition.source);
      validateFunctionRegistryIdentifiers(available.keys());
      validateTypeScript(definition.source, available);
      registry.set(definition.name, definition.source);
    } catch {
      // Ignore stale or malformed persisted definitions.
    }
  }
}

export interface SessionFunctionRemovalPlan {
  directDependents: string[];
  transitiveDependents: string[];
  removalClosure: string[];
}
