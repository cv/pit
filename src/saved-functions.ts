import { formatSize } from "@earendil-works/pi-coding-agent";
import { validateTypeScript } from "./sandbox.js";

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

export function functionScopeRegistry(
  effective: ReadonlyMap<string, string>,
  session: ReadonlyMap<string, string>,
): Map<string, "project" | "session"> {
  return new Map(
    [...effective.keys()].map((name) => [name, session.has(name) ? "session" : "project"] as const),
  );
}

export function functionRunScope(
  name: string,
  project: ReadonlyMap<string, string>,
  session: ReadonlyMap<string, string>,
  attributedScope?: "project" | "session",
): "project" | "session" {
  if (attributedScope) {
    return attributedScope;
  }
  return project.has(name) && !session.has(name) ? "project" : "session";
}
export const FUNCTION_ENTRY_TYPE = "pit-functions";
export type FunctionEntry =
  | { name: string; source: string; deleted?: never }
  | { name: string; deleted: true; source?: never };
export interface FunctionActivity {
  action: "set" | "run" | "remove";
  name: string;
  replaced?: boolean;
  scope?: "project" | "session";
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
      validateSavedFunctionName(definition.name);
      if (definition.deleted === true) {
        registry.delete(definition.name);
        continue;
      }
      if (typeof definition.source !== "string") {
        continue;
      }
      const capacityAvailable = new Map([...capacityBaseFunctions, ...registry]);
      validateRegistryCapacity(capacityAvailable, definition.name, definition.source);
      const available = new Map([...baseFunctions, ...registry]);
      available.set(definition.name, definition.source);
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
