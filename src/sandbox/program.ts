import { transform } from "esbuild";

import type { FunctionScope } from "../functions/core.js";
import {
  createLayeredFunctionRegistry,
  type FunctionDefinition,
} from "../functions/definitions.js";
import {
  clearSavedFunctionDependencyGraphCache,
  getSavedFunctionDependencyGraphCacheStats,
  resolveSavedFunctionReferences,
} from "../functions/graph.js";
import { resolveFunctionGraph, sourceFunctionDefinition } from "../functions/resolved-graph.js";
import {
  scopedRuntimeProgram,
  type ScopedFunctionRegistries,
} from "../functions/scoped-runtime.js";
import { isProgramExpression } from "../functions/source.js";
import { unifiedRuntimeProgram } from "../functions/unified-runtime.js";
import { clearValidationCache, getValidationCacheStats, validateTypeScript } from "./validation.js";

const MAX_CACHE_ENTRIES = 128;
const compilationCache = new Map<string, Promise<string>>();
let compilationCacheHits = 0;

function cacheSet<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
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
    compilationCache.delete(source);
    throw error;
  }
}

export interface SandboxProgramOptions {
  savedFunctions?: ReadonlyMap<string, string>;
  savedFunctionScopes?: ReadonlyMap<string, FunctionScope>;
  globalFunctions?: ReadonlyMap<string, string>;
  userFunctions?: ReadonlyMap<string, string>;
  projectFunctions?: ReadonlyMap<string, string>;
  sessionFunctions?: ReadonlyMap<string, string>;
  input?: unknown;
}

export async function compileSandboxSource(
  source: string,
  options: SandboxProgramOptions,
): Promise<string> {
  const savedFunctions = options.savedFunctions ?? new Map<string, string>();
  const scopes = options.savedFunctionScopes ?? new Map<string, FunctionScope>();
  const referenced = resolveSavedFunctionReferences(source, savedFunctions);
  const injectedFunctions = new Map(
    referenced.map((reference) => [reference.name, reference.source]),
  );
  validateTypeScript(source, injectedFunctions, options.input, savedFunctions.keys());
  const explicitRegistries =
    options.globalFunctions || options.projectFunctions || options.sessionFunctions;
  const registries: ScopedFunctionRegistries = explicitRegistries
    ? {
        global: options.globalFunctions ?? new Map(),
        project: options.projectFunctions ?? new Map(),
        session: options.sessionFunctions ?? new Map(),
      }
    : {
        global: new Map([...savedFunctions].filter(([name]) => scopes.get(name) === "global")),
        project: new Map([...savedFunctions].filter(([name]) => scopes.get(name) === "project")),
        session: new Map(
          [...savedFunctions].filter(
            ([name]) => scopes.get(name) !== "global" && scopes.get(name) !== "project",
          ),
        ),
      };
  return await compileTypeScript(
    scopedRuntimeProgram({
      source,
      programExpression: isProgramExpression(source),
      effective: savedFunctions,
      scopes,
      registries,
    }),
  );
}

function unifiedSourceDefinitions(options: SandboxProgramOptions): FunctionDefinition[] {
  const definitions: FunctionDefinition[] = [];
  const add = (
    functions: ReadonlyMap<string, string>,
    layer: "user" | "project" | "session",
  ): void => {
    for (const [id, source] of functions) {
      definitions.push(sourceFunctionDefinition(id, layer, source));
    }
  };
  const explicit =
    options.userFunctions ||
    options.globalFunctions ||
    options.projectFunctions ||
    options.sessionFunctions;
  if (explicit) {
    add(options.userFunctions ?? options.globalFunctions ?? new Map(), "user");
    add(options.projectFunctions ?? new Map(), "project");
    add(options.sessionFunctions ?? new Map(), "session");
    return definitions;
  }

  const saved = options.savedFunctions ?? new Map<string, string>();
  const scopes = options.savedFunctionScopes ?? new Map<string, FunctionScope>();
  for (const [id, source] of saved) {
    const oldScope = scopes.get(id);
    const layer = oldScope === "project" ? "project" : oldScope === "session" ? "session" : "user";
    definitions.push(sourceFunctionDefinition(id, layer, source));
  }
  return definitions;
}

export interface PreparedUnifiedSandboxProgram {
  compiled: string;
  effects: string[];
}

export async function prepareUnifiedSandboxProgram(
  source: string,
  options: SandboxProgramOptions,
): Promise<PreparedUnifiedSandboxProgram> {
  if (!isProgramExpression(source)) {
    throw new Error("unified function programs must be function expressions");
  }
  const definitions = unifiedSourceDefinitions(options);
  const registry = createLayeredFunctionRegistry(definitions);
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

export async function compileUnifiedSandboxSource(
  source: string,
  options: SandboxProgramOptions,
): Promise<string> {
  return (await prepareUnifiedSandboxProgram(source, options)).compiled;
}
