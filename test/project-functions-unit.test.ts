import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadProjectFunctionConfig,
  loadProjectFunctions,
  projectFunctionCatalog,
  removeProjectFunction,
  saveProjectFunction,
} from "../src/project-functions.js";

let cwd: string;
const registry = () => new Map<string, string>();
const metadata = () => new Map();
const ctx = (trusted = true) => ({ cwd, isProjectTrusted: () => trusted }) as any;

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

  it("formats empty, documented, and bounded catalogs", () => {
    expect(projectFunctionCatalog(new Map())).toBe("");
    const docs = new Map([
      [
        "alpha",
        {
          name: "alpha",
          summary: " Alpha   helper ",
          parameters: [{ name: "input", description: " value  to use " }, { name: "input.raw" }],
        },
      ],
      ["huge", { name: "huge", summary: "x".repeat(13_000), parameters: [] }],
    ]);
    const catalog = projectFunctionCatalog(docs);
    expect(catalog).toContain("alpha(input?) — Alpha helper");
    expect(catalog).toContain("input: value to use");
    expect(catalog).toContain("input.raw");
    expect(catalog).toContain("1 more; use functions.list()");
  });
});
