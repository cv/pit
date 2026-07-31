import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadProjectFunctionConfig,
  loadProjectFunctions,
  projectFunctionCatalog,
  reconcileProjectFunctionsForSession,
  removeProjectFunction,
  saveProjectFunction,
} from "../src/project-functions.js";
import { getProjectFunctionMetadata } from "../src/sandbox.js";

let cwd: string;
const registry = () => new Map<string, string>();
const metadata = () => new Map();
const ctx = (trusted = true) => ({ cwd, isProjectTrusted: () => trusted }) as any;

function sizedProjectFunction(name: string, bytes: number): string {
  const prefix = `/** ${name} helper. @pit project */ async function ${name}() { /*`;
  const suffix = "*/ return true; }";
  return prefix + "x".repeat(bytes - Buffer.byteLength(prefix + suffix)) + suffix;
}

function sizedInvalidProjectFunction(name: string, bytes: number): string {
  const prefix = `/** ${name} invalid helper. @pit project */ async function ${name}() { /*`;
  const suffix = "*/ return 1n; }";
  return prefix + "x".repeat(bytes - Buffer.byteLength(prefix + suffix)) + suffix;
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pit-project-functions-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("project function storage", () => {
  it("reads an explicit, strictly typed project opt-in", async () => {
    expect(await loadProjectFunctionConfig(ctx())).toEqual({ enabled: false });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi/pit.json"),
      JSON.stringify({ projectFunctions: { enabled: true }, futureSetting: true }),
    );
    expect(await loadProjectFunctionConfig(ctx())).toEqual({ enabled: true });
    expect(await loadProjectFunctionConfig(ctx(false))).toEqual({ enabled: false });

    await writeFile(join(cwd, ".pi/pit.json"), JSON.stringify({ futureSetting: true }));
    expect(await loadProjectFunctionConfig(ctx())).toEqual({ enabled: false });
    await writeFile(join(cwd, ".pi/pit.json"), JSON.stringify({ projectFunctions: {} }));
    expect(await loadProjectFunctionConfig(ctx())).toEqual({ enabled: false });

    for (const invalid of [
      "not json",
      "[]",
      JSON.stringify({ projectFunctions: true }),
      JSON.stringify({ projectFunctions: { enabled: "yes" } }),
    ]) {
      await writeFile(join(cwd, ".pi/pit.json"), invalid);
      expect(await loadProjectFunctionConfig(ctx())).toMatchObject({
        enabled: false,
        error: expect.stringContaining("Invalid .pi/pit.json"),
      });
    }

    await rm(join(cwd, ".pi/pit.json"));
    await mkdir(join(cwd, ".pi/pit.json"));
    await expect(loadProjectFunctionConfig(ctx())).rejects.toThrow();
  });

  it("saves, replaces, and removes files", async () => {
    const functions = registry();
    const source = "/** Summary. @pit project */ async function saved() { return true; }";
    expect(await saveProjectFunction(cwd, "saved", source, functions)).toBe(false);
    expect(await readFile(join(cwd, ".pi/pit/functions/saved.ts"), "utf8")).toBe(source + "\n");
    expect(await saveProjectFunction(cwd, "saved", source + "\n", functions)).toBe(true);
    expect(await removeProjectFunction(cwd, "saved")).toBe(true);
    expect(await removeProjectFunction(cwd, "saved")).toBe(false);
  });

  it("does not impose an aggregate quota on project storage alone", async () => {
    const functions = new Map(
      Array.from({ length: 10 }, (_, index) => {
        const name = `storedProject${index}`;
        return [name, sizedProjectFunction(name, 99_990)] as const;
      }),
    );
    const source = sizedProjectFunction("storedProjectExtra", 2_000);

    await expect(saveProjectFunction(cwd, "storedProjectExtra", source, functions)).resolves.toBe(
      false,
    );
    expect(
      [...functions.values()].reduce((total, value) => total + Buffer.byteLength(value), 0),
    ).toBe(1_001_900);
    await expect(
      readFile(join(cwd, ".pi/pit/functions/storedProjectExtra.ts"), "utf8"),
    ).resolves.toBe(source + "\n");
  });

  it("loads valid files and reports malformed files", async () => {
    const directory = join(cwd, ".pi/pit/functions");
    await mkdir(join(directory, "ignored-directory.ts"), { recursive: true });
    await Promise.all([
      writeFile(join(directory, "ignored.txt"), "ignored"),
      writeFile(
        join(directory, "alpha.ts"),
        "/** Alpha helper. @pit project */ async function alpha() { return true; }",
      ),
      writeFile(
        join(directory, "beta.ts"),
        "/** Beta helper. @pit project */ async function beta() { return alpha(); }",
      ),
      writeFile(
        join(directory, "gamma.ts"),
        "/** Gamma helper. @pit project */ async function gamma() { return (await alpha()).missing; }",
      ),
      writeFile(join(directory, "missing.ts"), "async function missing() { return null; }"),
      writeFile(
        join(directory, "wrong.ts"),
        "/** Wrong file. @pit project */ async function other() { return null; }",
      ),
      writeFile(
        join(directory, "invalid.ts"),
        "/** Invalid. @pit project */ async function invalid() { return 1n; }",
      ),
      writeFile(join(directory, "oversized.ts"), "x".repeat(100_001)),
    ]);
    const functions = registry();
    const docs = metadata();
    const errors = await loadProjectFunctions(ctx(), functions, docs);
    expect([...functions.keys()]).toEqual(["alpha", "beta"]);
    expect([...docs.keys()]).toEqual(["alpha", "beta"]);
    expect(errors.join("\n")).toMatch(
      /missing @pit project|filename must be|source exceeds|TypeScript validation failed/,
    );
    expect(await loadProjectFunctions(ctx(false), functions, docs)).toEqual([]);
    expect(functions.size).toBe(0);
  });

  it("does not let invalid load candidates consume final function capacity", async () => {
    const directory = join(cwd, ".pi/pit/functions");
    await mkdir(directory, { recursive: true });
    const invalidSources = Array.from({ length: 10 }, (_, index) => {
      const name = `invalidCandidate${String(index).padStart(2, "0")}`;
      return [name, sizedInvalidProjectFunction(name, 99_000)] as const;
    });
    const validSource = sizedProjectFunction("zzValidCandidate", 20_000);
    expect(
      invalidSources.reduce((total, [, source]) => total + Buffer.byteLength(source), 0) +
        Buffer.byteLength(validSource),
    ).toBe(1_010_000);
    await Promise.all([
      ...invalidSources.map(([name, source]) => writeFile(join(directory, `${name}.ts`), source)),
      writeFile(join(directory, "zzValidCandidate.ts"), validSource),
    ]);

    const functions = registry();
    const docs = metadata();
    const errors = await loadProjectFunctions(ctx(), functions, docs);
    expect([...functions.keys()]).toEqual(["zzValidCandidate"]);
    expect([...docs.keys()]).toEqual(["zzValidCandidate"]);
    expect(errors).toHaveLength(10);
    expect(errors.every((error) => error.includes("TypeScript validation failed"))).toBe(true);

    const active = registry();
    const activeDocs = metadata();
    expect(
      reconcileProjectFunctionsForSession(functions, docs, new Map(), active, activeDocs),
    ).toEqual([]);
    expect([...active.keys()]).toEqual(["zzValidCandidate"]);
  }, 10_000);

  it("surfaces storage errors and cleans failed temporary writes", async () => {
    await mkdir(join(cwd, ".pi/pit/functions/blocked.ts"), { recursive: true });
    const source = "/** Blocked. @pit project */ async function blocked() { return null; }";
    await expect(saveProjectFunction(cwd, "blocked", source, registry())).rejects.toThrow();
    await rm(join(cwd, ".pi"), { recursive: true });
    await mkdir(join(cwd, ".pi/pit"), { recursive: true });
    await writeFile(join(cwd, ".pi/pit/functions"), "not a directory");
    await expect(loadProjectFunctions(ctx(), registry(), metadata())).rejects.toThrow();
    await rm(join(cwd, ".pi"), { recursive: true });
    await mkdir(join(cwd, ".pi/pit/functions/directory.ts"), { recursive: true });
    await expect(removeProjectFunction(cwd, "directory")).rejects.toThrow();
  });

  it("derives no-input, required-input, and optional-input signatures", () => {
    const signatures = [
      "/** No input. @pit project */ async function noInput() {}",
      "/** Required input. @pit project */ async function required(_capabilities, input: { value: string }) {}",
      "/** Optional input. @pit project */ async function optional(_capabilities, input?: number) {}",
    ].map((source) => getProjectFunctionMetadata(source)?.signature);
    expect(signatures).toEqual([
      "noInput()",
      "required(input: { value: string })",
      "optional(input?: number)",
    ]);
  });

  it("formats empty, documented, and bounded catalogs", () => {
    expect(projectFunctionCatalog(new Map())).toBe("");
    const docs = new Map([
      [
        "alpha",
        {
          name: "alpha",
          signature: "alpha(input: { raw: string })",
          summary: " Alpha   helper ",
          parameters: [{ name: "input", description: " value  to use " }, { name: "input.raw" }],
        },
      ],
      ["huge", { name: "huge", signature: "huge()", summary: "x".repeat(13_000), parameters: [] }],
    ]);
    const catalog = projectFunctionCatalog(docs);
    expect(catalog).toContain("alpha(input: { raw: string }) — Alpha helper");
    expect(catalog).toContain("input: value to use");
    expect(catalog).toContain("input.raw");
    expect(catalog).toContain("1 more; use functions.list()");

    const unparsableOverride = projectFunctionCatalog(docs, new Map([["alpha", "not a function"]]));
    expect(unparsableOverride).toContain("- alpha — Session override of project function.");
    expect(unparsableOverride).not.toContain("alpha(");
    expect(unparsableOverride).not.toContain("Alpha helper");
    expect(unparsableOverride).not.toContain("input: value to use");
  });
});
