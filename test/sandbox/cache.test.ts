import { describe, expect, it } from "vitest";

import { getSavedFunctionDependencyGraph } from "../../src/functions/graph.js";
import {
  clearSandboxCaches,
  getSandboxCacheStats,
  prepareSandboxProgram,
} from "../../src/sandbox/program.js";
import { validateTypeScript } from "../../src/sandbox/validation.js";
import { runInSandbox } from "../support/sandbox.js";

describe("sandbox caches", () => {
  it("reuses validated graphs without leaking mutations or stale grants", async () => {
    clearSandboxCaches();
    const source = "async ({ action }) => action()";
    const projectFunctions = new Map([
      [
        "action",
        "async function action({ workspace: { read } }) { await read('one.txt'); return 1; }",
      ],
    ]);
    const options = { projectFunctions };
    const first = await prepareSandboxProgram(source, options);
    expect(first.effects).toEqual(["workspace.read"]);
    first.effects.push("shell.exec");
    const cached = await prepareSandboxProgram(source, options);
    expect(cached.effects).toEqual(["workspace.read"]);
    expect(getSandboxCacheStats().validationHits).toBeGreaterThan(0);

    projectFunctions.set(
      "action",
      "async function action({ shell: { exec } }) { await exec('echo changed'); return 1; }",
    );
    expect((await prepareSandboxProgram(source, options)).effects).toEqual(["shell.exec"]);
    await expect(
      prepareSandboxProgram(source, {
        ...options,
        invalidDefinitions: new Map([["action", "disabled"]]),
      }),
    ).rejects.toThrow("unavailable");
    projectFunctions.delete("action");
    await expect(prepareSandboxProgram(source, options)).rejects.toThrow("action");
    clearSandboxCaches();
  });

  it("does not reuse validated top-level params for different input types", async () => {
    const source = "async ({}, input: { value: number }) => input.value";
    await prepareSandboxProgram(source, { input: { value: 1 } });
    await expect(prepareSandboxProgram(source, { input: { value: "wrong" } })).rejects.toThrow(
      /string.*number/,
    );
  });
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
