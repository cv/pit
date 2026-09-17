import { describe, expect, it } from "vitest";

import { getSavedFunctionDependencyGraph } from "../../src/functions/graph.js";
import { clearSandboxCaches, getSandboxCacheStats } from "../../src/sandbox/program.js";
import { runInSandbox } from "../../src/sandbox/run.js";
import { validateTypeScript } from "../../src/sandbox/validation.js";

describe("sandbox caches", () => {
  it("caches successful and failed validation plus compiled output", async () => {
    clearSandboxCaches();
    const source = "({}) => ({ answer: 42 })";
    validateTypeScript(source);
    validateTypeScript(source);

    const invalid = "({}) => 1n";
    expect(() => validateTypeScript(invalid)).toThrow();
    expect(() => validateTypeScript(invalid)).toThrow();

    await runInSandbox(source, async () => null);
    await runInSandbox(source, async () => null);
    expect(getSandboxCacheStats()).toEqual({
      validationEntries: 3,
      compilationEntries: 1,
      validationHits: 3,
      compilationHits: 1,
      dependencyGraphEntries: 0,
      dependencyGraphHits: 0,
      dependencyReferenceHits: 0,
    });
    clearSandboxCaches();
    expect(getSandboxCacheStats()).toEqual({
      validationEntries: 0,
      compilationEntries: 0,
      validationHits: 0,
      compilationHits: 0,
      dependencyGraphEntries: 0,
      dependencyGraphHits: 0,
      dependencyReferenceHits: 0,
    });
  });

  it("reuses dependency graphs and invalidates changed registries", () => {
    clearSandboxCaches();
    const saved = new Map([
      ["base", "async function base({}) { return 1; }"],
      ["composed", "async function composed({ base }) { return base() + 1; }"],
    ]);
    const initial = getSavedFunctionDependencyGraph(saved);
    expect(initial.resolve("async ({ composed }) => composed()").map(({ name }) => name)).toEqual([
      "base",
      "composed",
    ]);

    const reloaded = getSavedFunctionDependencyGraph(new Map(saved));
    expect(reloaded).toBe(initial);
    expect(reloaded.resolve("async ({ composed }) => composed()").map(({ name }) => name)).toEqual([
      "base",
      "composed",
    ]);

    saved.set("composed", "async function composed({}) { return 2; }");
    const replaced = getSavedFunctionDependencyGraph(saved);
    expect(replaced).not.toBe(initial);
    expect(replaced.resolve("async ({ composed }) => composed()").map(({ name }) => name)).toEqual([
      "composed",
    ]);

    saved.delete("base");
    expect(getSavedFunctionDependencyGraph(saved)).not.toBe(replaced);
    expect(getSandboxCacheStats()).toMatchObject({
      dependencyGraphEntries: 3,
      dependencyGraphHits: 1,
      dependencyReferenceHits: expect.any(Number),
    });
    expect(getSandboxCacheStats().dependencyReferenceHits).toBeGreaterThan(0);
  });
});
