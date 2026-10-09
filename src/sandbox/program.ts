import type { ExecutionTimingRecorder } from "../execution/timings.js";
import {
  type FunctionEnvironment,
  type FunctionDefinitionReference,
} from "../functions/environment.js";
import {
  clearSavedFunctionDependencyGraphCache,
  getSavedFunctionDependencyGraphCacheStats,
} from "../functions/graph.js";
import { unifiedRuntimeProgram } from "../functions/unified-runtime.js";
import { transpileTypeScriptExpression } from "./transpile.js";
import {
  clearValidationCache,
  getValidationCacheStats,
  validateSandboxTypeScript,
} from "./validation.js";

const MAX_CACHE_ENTRIES = 128;
const compilationCache = new Map<string, string>();
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

function compileTypeScript(source: string): string {
  const cached = compilationCache.get(source);
  if (cached !== undefined) {
    compilationCacheHits++;
    return cached;
  }
  const compiled = transpileTypeScriptExpression(source);
  cacheSet(compilationCache, source, compiled);
  return compiled;
}

interface SandboxProgramOptions extends FunctionEnvironment {
  input?: unknown;
  definition?: FunctionDefinitionReference;
  timings?: ExecutionTimingRecorder;
}

export interface PreparedSandboxProgram {
  compiled: string;
  effects: string[];
}

export async function prepareSandboxProgram(
  source: string,
  options: SandboxProgramOptions,
): Promise<PreparedSandboxProgram> {
  options.timings?.enter("validation");
  const graph = validateSandboxTypeScript(source, options.input, {
    environment: options,
    ...(options.definition ? { definition: options.definition } : {}),
    checkAll: false,
  });
  options.timings?.enter("compilation");
  return {
    compiled: compileTypeScript(unifiedRuntimeProgram(source, graph)),
    effects: graph.effects,
  };
}
