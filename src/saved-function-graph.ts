import { createHash } from "node:crypto";

import {
  type CompilerHost,
  type CompilerOptions,
  createCompilerHost,
  createProgram,
  createSourceFile,
  forEachChild,
  type Identifier,
  isIdentifier,
  isTypeNode,
  ModuleKind,
  type Node,
  ScriptTarget,
  type Symbol as TypeScriptSymbol,
  type VariableStatement,
} from "typescript";

const MAX_DEPENDENCY_GRAPH_CACHE_ENTRIES = 32;
const MAX_REFERENCE_CACHE_ENTRIES = 128;
const dependencyGraphCache = new Map<string, SavedFunctionDependencyGraph>();
let dependencyGraphCacheHits = 0;
let dependencyReferenceCacheHits = 0;

function cacheSet<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > limit) {
    cache.delete(cache.keys().next().value!);
  }
}

function fingerprint(parts: Iterable<string>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part)));
    hash.update(":");
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("base64url");
}

function registryFingerprint(registry: ReadonlyMap<string, string>): string {
  const parts: string[] = [];
  for (const [name, source] of [...registry.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    parts.push(name, source);
  }
  return fingerprint(parts);
}

function sourceFingerprint(source: string): string {
  return fingerprint([source]);
}

function referencedNames(source: string, candidates: ReadonlySet<string>): string[] {
  const contractFile = "/pit/reference-contract.d.ts";
  const sourceFile = "/pit/references.ts";
  const declarations = [...candidates]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `declare const ${name}: (...args: unknown[]) => unknown;`)
    .join("\n");
  const wrapped = `function __pit_reference_scope() {\n${source}\n}`;
  const options: CompilerOptions = {
    target: ScriptTarget.ES2022,
    module: ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    skipLibCheck: true,
  };
  const baseHost = createCompilerHost(options, true);
  const sources = new Map([
    [contractFile, declarations],
    [sourceFile, wrapped],
  ]);
  const host: CompilerHost = {
    ...baseHost,
    /* v8 ignore next -- TypeScript does not always probe virtual files through fileExists. */
    fileExists: (fileName) => sources.has(fileName),
    getSourceFile: (fileName, languageVersion) =>
      createSourceFile(fileName, sources.get(fileName)!, languageVersion, true),
  };
  const program = createProgram([contractFile, sourceFile], options, host);
  const checker = program.getTypeChecker();
  const contract = program.getSourceFile(contractFile)!;
  const submitted = program.getSourceFile(sourceFile)!;

  const namesBySymbol = new Map<TypeScriptSymbol, string>();
  for (const statement of contract.statements) {
    const declaration = (statement as VariableStatement).declarationList.declarations[0];
    const identifier = declaration!.name as Identifier;
    namesBySymbol.set(checker.getSymbolAtLocation(identifier)!, identifier.text);
  }

  const references = new Set<string>();
  const visit = (node: Node): void => {
    if (isIdentifier(node)) {
      let ancestor: Node | undefined = node;
      let typeOnly = false;
      while (ancestor && ancestor !== submitted) {
        if (isTypeNode(ancestor)) {
          typeOnly = true;
          break;
        }
        ancestor = ancestor.parent;
      }
      if (!typeOnly) {
        const symbol = checker.getSymbolAtLocation(node);
        const name = symbol ? namesBySymbol.get(symbol) : undefined;
        if (name) {
          references.add(name);
        }
      }
    }
    forEachChild(node, visit);
  };
  visit(submitted);
  return [...references].sort((a, b) => a.localeCompare(b));
}

export interface SavedFunctionReference {
  name: string;
  source: string;
  direct: boolean;
}

interface CachedReferences {
  source: string;
  names: readonly string[];
}

export class SavedFunctionDependencyGraph {
  readonly #sources: ReadonlyMap<string, string>;
  readonly #names: ReadonlySet<string>;
  readonly #referenceCache = new Map<string, CachedReferences>();

  constructor(registry: ReadonlyMap<string, string>) {
    this.#sources = new Map([...registry.entries()].sort(([a], [b]) => a.localeCompare(b)));
    this.#names = new Set(this.#sources.keys());
  }

  get referenceCacheEntries(): number {
    return this.#referenceCache.size;
  }

  directReferences(source: string): readonly string[] {
    if (this.#names.size === 0) {
      return [];
    }
    const key = sourceFingerprint(source);
    const cached = this.#referenceCache.get(key);
    if (cached?.source === source) {
      dependencyReferenceCacheHits++;
      cacheSet(this.#referenceCache, key, cached, MAX_REFERENCE_CACHE_ENTRIES);
      return cached.names;
    }
    const names = referencedNames(source, this.#names);
    cacheSet(this.#referenceCache, key, { source, names }, MAX_REFERENCE_CACHE_ENTRIES);
    return names;
  }

  directDependencies(name: string): readonly string[] {
    const source = this.#sources.get(name);
    if (source === undefined) {
      return [];
    }
    return this.directReferences(source).filter((dependency) => dependency !== name);
  }

  resolve(source: string): SavedFunctionReference[] {
    const direct = new Set(this.directReferences(source));
    const resolved = new Map<string, SavedFunctionReference>();
    const visiting = new Set<string>();
    const visit = (name: string, isDirect: boolean): void => {
      const savedSource = this.#sources.get(name);
      if (savedSource === undefined || visiting.has(name)) {
        return;
      }
      const existing = resolved.get(name);
      if (existing) {
        if (isDirect) {
          existing.direct = true;
        }
        return;
      }
      visiting.add(name);
      for (const dependency of this.directDependencies(name)) {
        visit(dependency, false);
      }
      visiting.delete(name);
      resolved.set(name, { name, source: savedSource, direct: isDirect });
    };
    for (const name of direct) {
      visit(name, true);
    }
    return [...resolved.values()];
  }

  dependents(name: string): { direct: string[]; transitive: string[] } {
    const reverse = new Map<string, Set<string>>();
    for (const candidate of this.#sources.keys()) {
      for (const dependency of this.directDependencies(candidate)) {
        const dependents = reverse.get(dependency) ?? new Set<string>();
        dependents.add(candidate);
        reverse.set(dependency, dependents);
      }
    }
    const direct = new Set(reverse.get(name) ?? []);
    const transitive = new Set<string>();
    const visiting = new Set<string>();
    const visit = (dependency: string): void => {
      if (visiting.has(dependency)) {
        return;
      }
      visiting.add(dependency);
      for (const dependent of reverse.get(dependency) ?? []) {
        if (!direct.has(dependent) && dependent !== name) {
          transitive.add(dependent);
        }
        visit(dependent);
      }
      visiting.delete(dependency);
    };
    for (const dependent of direct) {
      visit(dependent);
    }
    return {
      direct: [...direct].sort((a, b) => a.localeCompare(b)),
      transitive: [...transitive].sort((a, b) => a.localeCompare(b)),
    };
  }

  cycles(): string[][] {
    let nextIndex = 0;
    const indices = new Map<string, number>();
    const lowLinks = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const cycles: Array<[string, string, ...string[]]> = [];
    const visit = (name: string): void => {
      const index = nextIndex++;
      indices.set(name, index);
      lowLinks.set(name, index);
      stack.push(name);
      onStack.add(name);
      for (const dependency of this.directDependencies(name)) {
        if (!indices.has(dependency)) {
          visit(dependency);
          lowLinks.set(
            name,
            Math.min(lowLinks.get(name) as number, lowLinks.get(dependency) as number),
          );
        } else if (onStack.has(dependency)) {
          lowLinks.set(
            name,
            Math.min(lowLinks.get(name) as number, indices.get(dependency) as number),
          );
        }
      }
      if (lowLinks.get(name) !== indices.get(name)) {
        return;
      }
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        /* v8 ignore else -- Tarjan's stack always contains the current node. */
        if (member !== undefined) {
          onStack.delete(member);
          component.push(member);
        }
      } while (member !== name);
      if (component.length > 1) {
        cycles.push(component.sort((a, b) => a.localeCompare(b)) as [string, string, ...string[]]);
      }
    };
    for (const name of this.#sources.keys()) {
      if (!indices.has(name)) {
        visit(name);
      }
    }
    return cycles.sort((a, b) => a[0].localeCompare(b[0]));
  }
}

export function getSavedFunctionDependencyGraph(
  registry: ReadonlyMap<string, string>,
): SavedFunctionDependencyGraph {
  const key = registryFingerprint(registry);
  const cached = dependencyGraphCache.get(key);
  if (cached) {
    dependencyGraphCacheHits++;
    cacheSet(dependencyGraphCache, key, cached, MAX_DEPENDENCY_GRAPH_CACHE_ENTRIES);
    return cached;
  }
  const graph = new SavedFunctionDependencyGraph(registry);
  cacheSet(dependencyGraphCache, key, graph, MAX_DEPENDENCY_GRAPH_CACHE_ENTRIES);
  return graph;
}

export function resolveSavedFunctionReferences(
  source: string,
  savedFunctions: ReadonlyMap<string, string>,
): SavedFunctionReference[] {
  return getSavedFunctionDependencyGraph(savedFunctions).resolve(source);
}

export function clearSavedFunctionDependencyGraphCache(): void {
  dependencyGraphCache.clear();
  dependencyGraphCacheHits = 0;
  dependencyReferenceCacheHits = 0;
}

export function getSavedFunctionDependencyGraphCacheStats(): {
  dependencyGraphEntries: number;
  dependencyGraphHits: number;
  dependencyReferenceEntries: number;
  dependencyReferenceHits: number;
} {
  return {
    dependencyGraphEntries: dependencyGraphCache.size,
    dependencyGraphHits: dependencyGraphCacheHits,
    dependencyReferenceEntries: [...dependencyGraphCache.values()].reduce(
      (total, graph) => total + graph.referenceCacheEntries,
      0,
    ),
    dependencyReferenceHits: dependencyReferenceCacheHits,
  };
}
