import { join } from "node:path";

import type { FunctionScope } from "./core.js";
import type { FunctionDefinition } from "./definitions.js";
import { getFunctionDependencies, type FunctionDependencies } from "./dependencies.js";
import { functionRegistry } from "./environment.js";
import { functionRelativePath } from "./identifier.js";
import { FUNCTION_LAYERS } from "./layered-registry.js";
import { resolveFunctionGraph } from "./resolved-graph.js";
import { getPersistentFunctionMetadata, getSavedFunctionCallSignature } from "./source.js";
import { userFunctionDirectory } from "./storage/user.js";

export interface FunctionInspectionState {
  user?: ReadonlyMap<string, string>;
  project?: ReadonlyMap<string, string>;
  session?: ReadonlyMap<string, string>;
  invalidUser?: ReadonlyMap<string, string>;
  invalidProject?: ReadonlyMap<string, string>;
}

export interface FunctionListOptions {
  scope?: FunctionScope;
  allDefinitions?: boolean;
  offset?: number;
  limit?: number;
}

export interface FunctionReference {
  name: string;
  scope: FunctionScope;
  kind: "native" | "source" | "invalid";
  available: boolean;
}

export interface FunctionSummary extends FunctionReference {
  effective: boolean;
  effectiveScope: FunctionScope;
  readOnly: boolean;
  sealed: boolean;
  signature: string;
  summary: string;
  origin: string;
  lines: number;
  bytes: number;
  directDependencies: string[];
  directDependents: string[];
  overridesProject: boolean;
  overridesUser: boolean;
  overridesGlobal: boolean;
  error?: string;
}

export type FunctionInspection = FunctionSummary & {
  overrideChain: Array<FunctionReference & { origin: string; effective: boolean; sealed: boolean }>;
  resolvedDependencies: Array<{ name: string; scope?: FunctionScope; available: boolean }>;
  next?: FunctionReference;
  directEffects: string[];
  effects: string[];
  documentation: string;
} & ({ kind: "source"; source: string } | { kind: "native" | "invalid"; source?: never });

export interface FunctionListResult {
  functions: FunctionSummary[];
  total: number;
  offset: number;
  nextOffset?: number;
}

type InspectionEntry =
  | FunctionDefinition
  | { id: string; layer: "user" | "project"; kind: "invalid"; error: string; sealed?: false };

const rank = (scope: FunctionScope): number => FUNCTION_LAYERS.indexOf(scope);
const bounded = (text: string, limit: number): string =>
  text.length > limit ? text.slice(0, limit - 1) + "…" : text;

export class FunctionInspector {
  readonly #registry: ReturnType<typeof functionRegistry>;
  readonly #chains = new Map<string, InspectionEntry[]>();
  readonly #dependencies = new Map<string, FunctionDependencies>();
  readonly #analyses = new Map<string, { effects: string[]; error?: string }>();
  readonly #invalid: ReadonlyMap<string, string>;

  constructor(
    state: FunctionInspectionState,
    private readonly cwd: string,
  ) {
    this.#registry = functionRegistry({
      userFunctions: state.user ?? new Map(),
      projectFunctions: state.project ?? new Map(),
      sessionFunctions: state.session ?? new Map(),
    });
    for (const id of this.#registry.identifiers()) this.#chains.set(id, this.#registry.chain(id));
    for (const [layer, invalid] of [
      ["user", state.invalidUser],
      ["project", state.invalidProject],
    ] as const) {
      for (const [id, error] of invalid ?? []) {
        const chain = this.#chains.get(id) ?? [];
        this.#chains.set(
          id,
          [
            ...chain.filter((entry) => entry.layer !== layer),
            { id, layer, kind: "invalid" as const, error },
          ].sort((a, b) => rank(b.layer) - rank(a.layer)),
        );
      }
    }
    this.#invalid = new Map([...(state.invalidUser ?? []), ...(state.invalidProject ?? [])]);
  }

  #effective(id: string): InspectionEntry | undefined {
    const chain = this.#chains.get(id) ?? [];
    return chain.find((entry) => entry.layer === "global" && entry.sealed) ?? chain[0];
  }

  #declared(entry: InspectionEntry): FunctionDependencies {
    if (entry.kind !== "source") return { dependencies: [], usesNext: false };
    const key = `${entry.layer}:${entry.id}`;
    let dependencies = this.#dependencies.get(key);
    if (!dependencies) {
      dependencies = getFunctionDependencies(entry.source);
      this.#dependencies.set(key, dependencies);
    }
    return dependencies;
  }

  #next(entry: InspectionEntry): InspectionEntry | undefined {
    return (this.#chains.get(entry.id) ?? []).find(
      (lower) => rank(lower.layer) < rank(entry.layer),
    );
  }

  #reference(entry: InspectionEntry): FunctionReference {
    return {
      name: entry.id,
      scope: entry.layer,
      kind: entry.kind,
      available: entry.kind !== "invalid" && !this.#analysis(entry).error,
    };
  }

  #origin(entry: InspectionEntry): string {
    if (entry.layer === "global") return "<pit builtin>";
    if (entry.layer === "session") return "<active session branch>";
    try {
      return join(
        entry.layer === "user" ? userFunctionDirectory() : join(this.cwd, ".pi/functions"),
        functionRelativePath(entry.id),
      );
    } catch {
      return `<invalid ${entry.layer} definition>`;
    }
  }

  #dependents(target: InspectionEntry): string[] {
    const names = new Set<string>();
    for (const chain of this.#chains.values()) {
      for (const entry of chain) {
        if (entry.kind !== "source") continue;
        const declared = this.#declared(entry);
        if (
          declared.dependencies.some(
            (dependency) =>
              dependency.id === target.id && this.#effective(dependency.id)?.layer === target.layer,
          ) ||
          (declared.usesNext && entry.id === target.id && this.#next(entry)?.layer === target.layer)
        )
          names.add(entry.id);
      }
    }
    return [...names].sort();
  }

  #analysis(entry: InspectionEntry): { effects: string[]; error?: string } {
    const key = `${entry.layer}:${entry.id}`;
    const cached = this.#analyses.get(key);
    if (cached) return cached;
    let analysis: { effects: string[]; error?: string };
    if (entry.kind === "native") analysis = { effects: [entry.effect] };
    else if (entry.kind === "invalid")
      analysis = { effects: [], error: bounded(entry.error, 2000) };
    else {
      try {
        analysis = {
          effects: resolveFunctionGraph(entry.source, this.#registry, {
            definition: { id: entry.id, layer: entry.layer },
            invalidDefinitions: this.#invalid,
          }).effects,
        };
      } catch (failure) {
        analysis = {
          effects: [],
          error: bounded(failure instanceof Error ? failure.message : String(failure), 2000),
        };
      }
    }
    this.#analyses.set(key, analysis);
    return analysis;
  }

  #summary(entry: InspectionEntry): FunctionSummary {
    const effective = this.#effective(entry.id) as InspectionEntry;
    const analysis = this.#analysis(entry);
    const lower = (this.#chains.get(entry.id) ?? []).filter(
      (candidate) => rank(candidate.layer) < rank(entry.layer),
    );
    let summary = "";
    if (entry.kind === "native") summary = entry.summary;
    else if (entry.kind === "source") {
      try {
        summary = getPersistentFunctionMetadata(entry.source)?.summary ?? "";
      } catch {
        /* Session documentation is optional. */
      }
    }
    return {
      ...this.#reference(entry),
      available: entry.kind !== "invalid" && !analysis.error,
      effective: effective.layer === entry.layer,
      effectiveScope: effective.layer,
      readOnly: entry.layer === "global" || entry.kind === "invalid",
      sealed: entry.sealed === true,
      signature:
        entry.kind === "native"
          ? entry.signature
          : entry.kind === "source"
            ? (getSavedFunctionCallSignature(entry.source, entry.id) ?? `${entry.id}(…)`)
            : "<unavailable>",
      summary: bounded(summary, 256),
      origin: this.#origin(entry),
      lines: entry.kind === "source" ? entry.source.split("\n").length : 0,
      bytes: entry.kind === "source" ? Buffer.byteLength(entry.source) : 0,
      directDependencies: this.#declared(entry)
        .dependencies.map((dependency) => dependency.id)
        .sort(),
      directDependents: this.#dependents(entry),
      overridesProject: lower.some((candidate) => candidate.layer === "project"),
      overridesUser: lower.some((candidate) => candidate.layer === "user"),
      overridesGlobal: lower.some((candidate) => candidate.layer === "global"),
      ...(analysis.error ? { error: analysis.error } : {}),
    };
  }

  summaries(
    options: Pick<FunctionListOptions, "scope" | "allDefinitions"> = {},
  ): FunctionSummary[] {
    return [...this.#chains.keys()].sort().flatMap((id) => {
      const entries =
        options.scope || options.allDefinitions
          ? (this.#chains.get(id) as InspectionEntry[])
          : [this.#effective(id) as InspectionEntry];
      return entries
        .filter((entry) => !options.scope || entry.layer === options.scope)
        .map((entry) => this.#summary(entry));
    });
  }

  list(options: FunctionListOptions = {}): FunctionListResult {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new Error("function list offset must be non-negative and limit must be 1–200");
    const entries = this.summaries(options);
    const functions = entries.slice(offset, offset + limit);
    for (const entry of functions) entry.signature = bounded(entry.signature, 1000);
    const next = offset + functions.length;
    return {
      functions,
      total: entries.length,
      offset,
      ...(next < entries.length ? { nextOffset: next } : {}),
    };
  }

  inspect(name: string, scope?: FunctionScope): FunctionInspection {
    const chain = this.#chains.get(name) ?? [];
    const entry = scope
      ? chain.find((candidate) => candidate.layer === scope)
      : this.#effective(name);
    if (!entry)
      throw new Error(
        `${scope ? scope[0]?.toUpperCase() + scope.slice(1) + " " : ""}function "${name}" is unavailable`,
      );
    const summary = this.#summary(entry);
    const declared = this.#declared(entry);
    const next = declared.usesNext ? this.#next(entry) : undefined;
    const { effects, error } = this.#analysis(entry);
    const inspection = {
      ...summary,
      available: !error,
      overrideChain: chain.map((candidate) =>
        Object.assign(this.#reference(candidate), {
          origin: this.#origin(candidate),
          effective: this.#effective(name)?.layer === candidate.layer,
          sealed: candidate.sealed === true,
        }),
      ),
      resolvedDependencies: declared.dependencies.map((dependency) => {
        const target = this.#effective(dependency.id);
        const resolved: { name: string; scope?: FunctionScope; available: boolean } = {
          name: dependency.id,
          available: target !== undefined && this.#reference(target).available,
        };
        if (target) resolved.scope = target.layer;
        return resolved;
      }),
      ...(next ? { next: this.#reference(next) } : {}),
      directEffects: entry.kind === "native" ? [entry.effect] : [],
      effects,
      documentation: entry.kind === "native" ? entry.documentation : summary.summary,
      ...(error ? { error } : {}),
    };
    return entry.kind === "source"
      ? { ...inspection, kind: "source", source: entry.source }
      : { ...inspection, kind: entry.kind };
  }
}
