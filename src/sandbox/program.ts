import { transform } from "esbuild";

import {
  createLayeredFunctionRegistry,
  type FunctionDefinition,
} from "../functions/definitions.js";
import {
  clearSavedFunctionDependencyGraphCache,
  getSavedFunctionDependencyGraphCacheStats,
} from "../functions/graph.js";
import { resolveFunctionGraph, sourceFunctionDefinition } from "../functions/resolved-graph.js";
import { isProgramExpression } from "../functions/source.js";
import { unifiedRuntimeProgram } from "../functions/unified-runtime.js";
import { clearValidationCache, getValidationCacheStats, validateTypeScript } from "./validation.js";

const MAX_CACHE_ENTRIES = 128;
const compilationCache = new Map<string, Promise<string>>();
let compilationCacheHits = 0;

function cacheSet<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  /* v8 ignore next -- defensive cache capacity bound. */
  if (cache.size > MAX_CACHE_ENTRIES) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    cache.delete(cache.keys().next().value!);
  }
}

export function clearSandboxCaches(): void {
  clearValidationCache();
  compilationCache.clear();
  clearSavedFunctionDependencyGraphCache();
  compilationCacheHits = 0;
}

export function getSandboxCacheStats() {
  return {
    ...getValidationCacheStats(),
    compilationEntries: compilationCache.size,
    compilationHits: compilationCacheHits,
    ...getSavedFunctionDependencyGraphCacheStats(),
  };
}

async function compileTypeScript(source: string): Promise<string> {
  const cached = compilationCache.get(source);
  if (cached) {
    compilationCacheHits++;
    return cached;
  }
  const compilation = transform(`(${source})`, {
    loader: "ts",
    target: "es2022",
    sourcemap: "inline",
  }).then((result) => result.code);
  cacheSet(compilationCache, source, compilation);
  try {
    return await compilation;
  } catch (error) {
    /* v8 ignore next -- malformed submissions fail semantic validation before compilation. */
    compilationCache.delete(source);
    throw error;
  }
}

export interface SandboxProgramOptions {
  userFunctions?: ReadonlyMap<string, string>;
  projectFunctions?: ReadonlyMap<string, string>;
  sessionFunctions?: ReadonlyMap<string, string>;
  input?: unknown;
}

function sourceDefinitions(options: SandboxProgramOptions): FunctionDefinition[] {
  const definitions: FunctionDefinition[] = [];
  const add = (
    functions: ReadonlyMap<string, string>,
    layer: "user" | "project" | "session",
  ): void => {
    for (const [id, source] of functions) {
      definitions.push(sourceFunctionDefinition(id, layer, source));
    }
  };
  add(options.userFunctions ?? new Map(), "user");
  add(options.projectFunctions ?? new Map(), "project");
  add(options.sessionFunctions ?? new Map(), "session");
  return definitions;
}

export interface PreparedSandboxProgram {
  compiled: string;
  effects: string[];
}

export async function prepareSandboxProgram(
  source: string,
  options: SandboxProgramOptions,
): Promise<PreparedSandboxProgram> {
  if (!isProgramExpression(source)) {
    throw new Error("TypeScript programs must be function expressions");
  }
  const registry = createLayeredFunctionRegistry(sourceDefinitions(options));
  const effectiveSources = new Map<string, string>();
  for (const [id, definition] of registry.effective()) {
    if (definition.kind === "source") effectiveSources.set(id, definition.source);
  }
  validateTypeScript(source, effectiveSources, options.input, registry.identifiers());
  const graph = resolveFunctionGraph(source, registry);
  return {
    compiled: await compileTypeScript(unifiedRuntimeProgram(source, graph)),
    effects: graph.effects,
  };
}

export async function compileSandboxSource(
  source: string,
  options: SandboxProgramOptions,
): Promise<string> {
  return (await prepareSandboxProgram(source, options)).compiled;
}
