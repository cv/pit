import { describe, expect, it } from "vitest";

import { getSavedFunctionDependencyGraph } from "../../src/functions/graph.js";
import { clearSandboxCaches, getSandboxCacheStats } from "../../src/sandbox/program.js";
import { runInSandbox } from "../../src/sandbox/run.js";
import { validateTypeScript } from "../../src/sandbox/validation.js";

describe("sandbox caches", () => {
  it("reuses validation and compilation without changing successful or rejected outcomes", async () => {
    clearSandboxCaches();
    const source = "({}) => ({ answer: 42 })";
    validateTypeScript(source);
    const validated = getSandboxCacheStats();
    validateTypeScript(source);
    expect(getSandboxCacheStats().validationEntries).toBe(validated.validationEntries);
    expect(getSandboxCacheStats().validationHits).toBeGreaterThan(validated.validationHits);

    const invalid = "({}) => 1n";
    expect(() => validateTypeScript(invalid)).toThrow();
    const rejected = getSandboxCacheStats();
    expect(() => validateTypeScript(invalid)).toThrow();
    expect(getSandboxCacheStats().validationEntries).toBe(rejected.validationEntries);
    expect(getSandboxCacheStats().validationHits).toBeGreaterThan(rejected.validationHits);

    expect(await runInSandbox(source, async () => null)).toEqual({ answer: 42 });
    const compiled = getSandboxCacheStats();
    expect(await runInSandbox(source, async () => null)).toEqual({ answer: 42 });
    expect(getSandboxCacheStats().compilationEntries).toBe(compiled.compilationEntries);
    expect(getSandboxCacheStats().compilationHits).toBeGreaterThan(compiled.compilationHits);

    clearSandboxCaches();
    expect(Object.values(getSandboxCacheStats()).every((value) => value === 0)).toBe(true);
    expect(await runInSandbox(source, async () => null)).toEqual({ answer: 42 });
    expect(getSandboxCacheStats().compilationEntries).toBeGreaterThan(0);
    clearSandboxCaches();
  });

  it("reuses equivalent registries and resolves the current dependencies after changes", () => {
    clearSandboxCaches();
    const saved = new Map([
      ["base", "async function base({}) { return 1; }"],
      ["composed", "async function composed({ base }) { return base() + 1; }"],
    ]);
    const source = "async ({ composed }) => composed()";
    const resolve = (registry: ReadonlyMap<string, string>) =>
      getSavedFunctionDependencyGraph(registry)
        .resolve(source)
        .map(({ name }) => name);
    expect(resolve(saved)).toEqual(["base", "composed"]);
    const cached = getSandboxCacheStats();
    expect(resolve(new Map(saved))).toEqual(["base", "composed"]);
    expect(getSandboxCacheStats().dependencyGraphEntries).toBe(cached.dependencyGraphEntries);
    expect(getSandboxCacheStats().dependencyGraphHits).toBeGreaterThan(cached.dependencyGraphHits);

    saved.set("composed", "async function composed({}) { return 2; }");
    expect(resolve(saved)).toEqual(["composed"]);
    saved.delete("base");
    expect(resolve(saved)).toEqual(["composed"]);
    expect(getSavedFunctionDependencyGraph(saved).resolve("async ({ base }) => base()")).toEqual(
      [],
    );
    saved.set("replacement", "async function replacement({}) { return 3; }");
    saved.set("composed", "async function composed({ replacement }) { return replacement(); }");
    expect(resolve(saved)).toEqual(["replacement", "composed"]);
    clearSandboxCaches();
  });
});
