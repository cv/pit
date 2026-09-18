import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { functionRunScope, functionScopeRegistry } from "../../src/functions/core.js";
import {
  userFunctionCatalog,
  projectFunctionCatalog,
  reconcileProjectFunctionsForSession as reconcileProjectFunctionState,
  savedFunctionDependents,
} from "../../src/functions/persistent-functions.js";
import { getPersistentFunctionMetadata } from "../../src/functions/source.js";
import {
  loadProjectFunctionConfig,
  loadProjectFunctions,
  removeProjectFunction,
  saveProjectFunction,
} from "../../src/functions/storage/project.js";

let cwd: string;
const registry = () => new Map<string, string>();
const metadata = () => new Map();
const ctx = (trusted = true) => ({ cwd, isProjectTrusted: () => trusted }) as any;

function reconcileProjectFunctionsForSession(
  candidates: ReadonlyMap<string, string>,
  candidateMetadata: Parameters<typeof reconcileProjectFunctionState>[0]["candidateMetadata"],
  session: Map<string, string>,
  active: Map<string, string>,
  activeMetadata: Parameters<typeof reconcileProjectFunctionState>[0]["metadata"],
) {
  return reconcileProjectFunctionState({
    user: new Map(),
    candidates,
    candidateMetadata,
    session,
    registry: active,
    metadata: activeMetadata,
  });
}

it("maps effective function scopes with override precedence", () => {
  const scopes = functionScopeRegistry(
    new Map([
      ["userOnly", "source"],
      ["projectOnly", "source"],
      ["overridden", "session source"],
      ["unattributed", "source"],
    ]),
    new Map([["userOnly", "source"]]),
    new Map([["projectOnly", "source"]]),
    new Map([["overridden", "session source"]]),
  );
  expect([...scopes]).toEqual([
    ["userOnly", "user"],
    ["projectOnly", "project"],
    ["overridden", "session"],
    ["unattributed", "session"],
  ]);
});

it("prefers attributed function scope and resolves registry fallbacks", () => {
  const user = new Map([["userOnly", "source"]]);
  const project = new Map([["projectOnly", "source"]]);
  const session = new Map([["sessionOnly", "source"]]);
  const registries = { user, project, session };
  expect(functionRunScope("userOnly", registries)).toBe("user");
  expect(functionRunScope("projectOnly", registries)).toBe("project");
  expect(functionRunScope("sessionOnly", registries)).toBe("session");
  expect(functionRunScope("missing", registries)).toBe("session");
  expect(functionRunScope("projectOnly", registries, "session")).toBe("session");
});

it("orders multiple transitive project dependents", () => {
  const project = new Map([
    ["base", "async function base({}) { return 1; }"],
    ["direct", "async function direct({ base }) { return base(); }"],
    ["transitiveB", "async function transitiveB({ direct }) { return direct(); }"],
    ["transitiveA", "async function transitiveA({ direct }) { return direct(); }"],
  ]);
  expect(savedFunctionDependents(project, new Map(), project, "base")).toEqual({
    direct: ["direct"],
    transitive: ["transitiveA", "transitiveB"],
  });
});

function sizedProjectFunction(name: string, bytes: number): string {
  const prefix = `/** ${name} helper. */ async function ${name}({}) { /*`;
  const suffix = "*/ return true; }";
  return prefix + "x".repeat(bytes - Buffer.byteLength(prefix + suffix)) + suffix;
}

function sizedProjectDependent(name: string, dependency: string, bytes: number): string {
  const prefix = `/** ${name} helper. */ async function ${name}({ ${dependency} }) { /*`;
  const suffix = `*/ return ${dependency}(); }`;
  return prefix + "x".repeat(bytes - Buffer.byteLength(prefix + suffix)) + suffix;
}

function sizedInvalidProjectFunction(name: string, bytes: number): string {
  const prefix = `/** ${name} invalid helper. */ async function ${name}({}) { /*`;
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
    const source = "/** Summary. */ async function saved({}) { return true; }";
    expect(await saveProjectFunction(cwd, "saved", source, functions)).toBe(false);
    expect(await readFile(join(cwd, ".pi/functions/saved.ts"), "utf8")).toBe(source + "\n");
    expect(await saveProjectFunction(cwd, "saved", source + "\n", functions)).toBe(true);
    expect(await removeProjectFunction(cwd, "saved")).toBe(true);
    expect(await removeProjectFunction(cwd, "saved")).toBe(false);
  });

  it("ignores legacy project files and leaves them untouched on mutation", async () => {
    const legacyDirectory = join(cwd, ".pi/pit/functions");
    await mkdir(legacyDirectory, { recursive: true });
    const legacySource = "/** Legacy helper. */ async function shared({}) { return 'legacy'; }";
    await writeFile(join(legacyDirectory, "shared.ts"), legacySource);
    await writeFile(join(legacyDirectory, "malformed.ts"), "invalid source");
    const functions = registry();
    expect(await loadProjectFunctions(ctx(), functions, metadata())).toEqual([]);
    expect(functions.size).toBe(0);
    const source = "/** Canonical helper. */ async function shared({}) { return 'current'; }";
    await saveProjectFunction(cwd, "shared", source, functions);
    expect(await loadProjectFunctions(ctx(), functions, metadata())).toEqual([]);
    expect(functions.get("shared")).toBe(source + "\n");
    expect(await removeProjectFunction(cwd, "shared")).toBe(true);
    expect(await readFile(join(legacyDirectory, "shared.ts"), "utf8")).toBe(legacySource);
  });

  it("does not impose an aggregate quota on project storage alone", async () => {
    const functions = new Map(
      Array.from({ length: 10 }, (_, index) => {
        const name = `storedProject${index}`;
        return [name, sizedProjectFunction(name, 99_990)] as const;
      }),
    );
    const source = sizedProjectFunction("storedProjectExtra", 2000);

    await expect(saveProjectFunction(cwd, "storedProjectExtra", source, functions)).resolves.toBe(
      false,
    );
    expect(
      [...functions.values()].reduce((total, value) => total + Buffer.byteLength(value), 0),
    ).toBe(1_001_900);
    await expect(readFile(join(cwd, ".pi/functions/storedProjectExtra.ts"), "utf8")).resolves.toBe(
      source + "\n",
    );
  });

  it("loads valid files and reports malformed files", async () => {
    const directory = join(cwd, ".pi/functions");
    await mkdir(join(directory, "ignored-directory.ts"), { recursive: true });
    await Promise.all([
      writeFile(join(directory, "ignored.txt"), "ignored"),
      writeFile(
        join(directory, "alpha.ts"),
        "/** Alpha helper. */ async function alpha({}) { return true; }",
      ),
      writeFile(
        join(directory, "beta.ts"),
        "/** Beta helper. */ async function beta({ alpha }) { return alpha(); }",
      ),
      writeFile(
        join(directory, "gamma.ts"),
        "/** Gamma helper. */ async function gamma({ alpha }) { return (await alpha()).missing; }",
      ),
      writeFile(join(directory, "missing.ts"), "async function missing({}) { return null; }"),
      writeFile(
        join(directory, "wrong.ts"),
        "/** Wrong file. */ async function other({}) { return null; }",
      ),
      writeFile(
        join(directory, "invalid.ts"),
        "/** Invalid. */ async function invalid({}) { return 1n; }",
      ),
      writeFile(join(directory, "oversized.ts"), "x".repeat(100_001)),
    ]);
    const functions = registry();
    const docs = metadata();
    const errors = await loadProjectFunctions(ctx(), functions, docs);
    expect([...functions.keys()]).toEqual(["alpha", "beta"]);
    expect([...docs.keys()]).toEqual(["alpha", "beta"]);
    expect(errors.join("\n")).toMatch(
      /persistent functions require a JSDoc summary|filename must be|source exceeds|TypeScript validation failed/,
    );
    expect(await loadProjectFunctions(ctx(false), functions, docs)).toEqual([]);
    expect(functions.size).toBe(0);
  });

  it("does not let invalid load candidates consume final function capacity", async () => {
    const directory = join(cwd, ".pi/functions");
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

  it("reconciles byte capacity when a same-name session override is removed", () => {
    const candidates = new Map(
      Array.from({ length: 11 }, (_, index) => {
        const name = `quotaProject${String(index).padStart(2, "0")}`;
        return [name, sizedProjectFunction(name, index === 10 ? 20_000 : 99_000)] as const;
      }),
    );
    const overrideSource = `async function quotaProject00({}) { return "session override"; }`;
    const session = new Map([["quotaProject00", overrideSource]]);
    const active = registry();
    const activeDocs = metadata();

    expect(
      reconcileProjectFunctionsForSession(candidates, new Map(), session, active, activeDocs),
    ).toEqual([]);
    expect(active).toHaveLength(11);
    expect(session).toEqual(new Map([["quotaProject00", overrideSource]]));

    session.clear();
    const errors = reconcileProjectFunctionsForSession(
      candidates,
      new Map(),
      session,
      active,
      activeDocs,
    );
    expect([...active.keys()]).toEqual(
      Array.from({ length: 10 }, (_, index) => `quotaProject${String(index).padStart(2, "0")}`),
    );
    expect(
      [...active.values()].reduce((total, source) => total + Buffer.byteLength(source), 0),
    ).toBe(990_000);
    expect(errors).toEqual([expect.stringMatching(/quotaProject10.*total source/)]);
  });

  it("admits a dependency but not its project dependent when the closure exceeds quota", () => {
    const candidates = new Map([
      ...Array.from({ length: 9 }, (_, index) => {
        const name = `aQuotaFill${String(index).padStart(2, "0")}`;
        return [name, sizedProjectFunction(name, 99_000)] as const;
      }),
      [
        "bQuotaDependent",
        sizedProjectDependent("bQuotaDependent", "zQuotaDependency", 60_000),
      ] as const,
      ["zQuotaDependency", sizedProjectFunction("zQuotaDependency", 60_000)] as const,
    ]);
    const active = registry();

    const errors = reconcileProjectFunctionsForSession(
      candidates,
      new Map(),
      new Map(),
      active,
      metadata(),
    );
    expect(active.has("zQuotaDependency")).toBe(true);
    expect(active.has("bQuotaDependent")).toBe(false);
    expect(errors).toEqual([expect.stringMatching(/bQuotaDependent.*total source/)]);
    expect(savedFunctionDependents(active, new Map(), active, "zQuotaDependency")).toEqual({
      direct: [],
      transitive: [],
    });
    expect(savedFunctionDependents(candidates, new Map(), active, "zQuotaDependency")).toEqual({
      direct: ["bQuotaDependent"],
      transitive: [],
    });

    const candidatesAfterDeletion = new Map(candidates);
    candidatesAfterDeletion.delete("zQuotaDependency");
    const activeAfterDeletion = registry();
    expect(
      reconcileProjectFunctionsForSession(
        candidatesAfterDeletion,
        new Map(),
        new Map(),
        activeAfterDeletion,
        metadata(),
      ),
    ).toEqual([]);
    expect(activeAfterDeletion.has("bQuotaDependent")).toBe(true);
  });

  it("rejects a session dependent when its required project closure cannot fit", () => {
    const dependencyName = (index: number) => `sessionDependency${String(index).padStart(2, "0")}`;
    const dependencyNames = Array.from({ length: 10 }, (_, index) => dependencyName(index));
    const dependencyChain = dependencyNames.map(
      (name, index) =>
        [
          name,
          index === 0
            ? sizedProjectFunction(name, 99_000)
            : sizedProjectDependent(name, dependencyName(index - 1), 99_000),
        ] as const,
    );
    const candidates = new Map([
      ...dependencyChain,
      [
        "zSessionDependency",
        sizedProjectDependent("zSessionDependency", dependencyName(9), 20_000),
      ] as const,
    ]);
    const session = new Map([
      [
        "sessionQuotaDependent",
        "async function sessionQuotaDependent({ zSessionDependency }) { return zSessionDependency(); }",
      ],
    ]);
    expect(
      [...candidates.values(), ...session.values()].every(
        (source) => Buffer.byteLength(source) <= 100_000,
      ),
    ).toBe(true);
    const active = registry();

    const errors = reconcileProjectFunctionsForSession(
      candidates,
      new Map(),
      session,
      active,
      metadata(),
    );
    expect(session).toHaveLength(0);
    expect([...active.keys()]).toEqual(dependencyNames);
    expect(active.has("zSessionDependency")).toBe(false);
    expect(errors).toEqual([
      expect.stringMatching(/session function sessionQuotaDependent.*total source/),
      expect.stringMatching(/zSessionDependency.*total source/),
    ]);
  });

  it("enforces the effective function-count boundary without compiling each candidate", () => {
    const candidates = new Map(
      Array.from({ length: 65 }, (_, index) => {
        const name = `countBoundary${String(index).padStart(2, "0")}`;
        return [name, `async function ${name}({}) { return true; }`] as const;
      }),
    );
    const active = registry();

    const errors = reconcileProjectFunctionsForSession(
      candidates,
      new Map(),
      new Map(),
      active,
      metadata(),
    );
    expect(active).toHaveLength(64);
    expect(errors).toEqual([expect.stringMatching(/countBoundary64.*limited to 64 functions/)]);
  });

  it("admits cyclic project dependencies as one closure", () => {
    const candidates = new Map([
      ["cycleA", "async function cycleA({ cycleB, cycleLeaf }) { return cycleB() + cycleLeaf(); }"],
      ["cycleB", "async function cycleB({ cycleA }) { return cycleA(); }"],
      ["cycleLeaf", "async function cycleLeaf({}) { return 1; }"],
    ]);
    const active = registry();

    expect(
      reconcileProjectFunctionsForSession(candidates, new Map(), new Map(), active, metadata()),
    ).toEqual([]);
    expect(new Set(active.keys())).toEqual(new Set(["cycleA", "cycleB", "cycleLeaf"]));
  });

  it("uses a session override while sorting multiple required project roots", () => {
    const candidates = new Map([
      ["zShared", "async function zShared({}) { return 1; }"],
      ["aWrapper", "async function aWrapper({ zShared }) { return zShared(); }"],
      ["betaRoot", "async function betaRoot({}) { return 2; }"],
    ]);
    const override = "async function zShared({}) { return 10; }";
    const consumer =
      "async function sessionConsumer({ aWrapper, betaRoot, zShared }) { return (await aWrapper()) + (await betaRoot()) + (await zShared()); }";
    const session = new Map([
      ["zShared", override],
      ["sessionConsumer", consumer],
    ]);
    const active = registry();

    expect(
      reconcileProjectFunctionsForSession(candidates, new Map(), session, active, metadata()),
    ).toEqual([]);
    expect(session).toEqual(
      new Map([
        ["zShared", override],
        ["sessionConsumer", consumer],
      ]),
    );
    expect(new Set(active.keys())).toEqual(new Set(["aWrapper", "betaRoot", "zShared"]));
  });

  it("rejects a closure whose dependency becomes unavailable", () => {
    class ExpiringDependencyMap extends Map<string, string> {
      private dependencyReads = 0;

      override get(name: string): string | undefined {
        if (name === "missingDependency" && ++this.dependencyReads > 1) {
          return undefined;
        }
        return super.get(name);
      }
    }
    const candidates = new ExpiringDependencyMap([
      [
        "dependent",
        "async function dependent({ missingDependency }) { return missingDependency(); }",
      ],
      ["missingDependency", "async function missingDependency({}) { return true; }"],
    ]);
    const active = registry();

    const errors = reconcileProjectFunctionsForSession(
      candidates,
      new Map(),
      new Map(),
      active,
      metadata(),
    );
    expect(active).toHaveLength(0);
    expect(errors).toEqual([
      expect.stringMatching(
        /dependent.*required project function "missingDependency" is unavailable/,
      ),
      expect.stringMatching(
        /missingDependency.*required project function "missingDependency" is unavailable/,
      ),
    ]);
  });

  it("surfaces storage errors and cleans failed temporary writes", async () => {
    await mkdir(join(cwd, ".pi/functions/blocked.ts"), { recursive: true });
    const source = "/** Blocked. */ async function blocked({}) { return null; }";
    await expect(saveProjectFunction(cwd, "blocked", source, registry())).rejects.toThrow();
    await rm(join(cwd, ".pi"), { recursive: true });
    await mkdir(join(cwd, ".pi/pit"), { recursive: true });
    await writeFile(join(cwd, ".pi/functions"), "not a directory");
    await expect(loadProjectFunctions(ctx(), registry(), metadata())).rejects.toThrow();
    await rm(join(cwd, ".pi"), { recursive: true });
    await mkdir(join(cwd, ".pi/functions/directory.ts"), { recursive: true });
    await expect(removeProjectFunction(cwd, "directory")).rejects.toThrow();
  });

  it("derives no-input, required-input, and optional-input signatures", () => {
    const signatures = [
      "/** No input. */ async function noInput({}) {}",
      "/** Required input. */ async function required({}, input: { value: string }) {}",
      "/** Optional input. */ async function optional({}, input?: number) {}",
    ].map((source) => getPersistentFunctionMetadata(source)?.signature);
    expect(signatures).toEqual([
      "noInput()",
      "required(input: { value: string })",
      "optional(input?: number)",
    ]);
  });

  it("extracts documented metadata and advertises effective override signatures", () => {
    const source = `/**
 * Greets someone using the project convention.
 *
 *
 * @param input.name - Name to greet.
 */
async function projectGreeting({}, input: { name?: string } = {}) {
  return { greeting: "Hello, " + (input.name ?? "project") };
}`;
    const parsed = getPersistentFunctionMetadata(source);
    expect(parsed).toEqual({
      name: "projectGreeting",
      signature: "projectGreeting(input?: { name?: string })",
      summary: "Greets someone using the project convention.",
      parameters: [{ name: "input.name", description: "Name to greet." }],
    });
    const docs = new Map([["projectGreeting", parsed as NonNullable<typeof parsed>]]);

    const catalog = projectFunctionCatalog(docs);
    expect(catalog).toContain(
      "projectGreeting(input?: { name?: string }) — Greets someone using the project convention.",
    );
    expect(catalog).toContain("input.name: Name to greet.");

    const differentlyShaped = projectFunctionCatalog(
      docs,
      new Map([["projectGreeting", 'async function projectGreeting({}) { return "session"; }']]),
    );
    expect(differentlyShaped).toContain(
      "projectGreeting() — Session override of project function.",
    );
    expect(differentlyShaped).not.toContain("Greets someone using the project convention.");
    expect(differentlyShaped).not.toContain("input.name: Name to greet.");

    const sameShaped = projectFunctionCatalog(
      docs,
      new Map([
        [
          "projectGreeting",
          "async function projectGreeting({}, input: { name?: string } = {}) { return input.name; }",
        ],
      ]),
    );
    expect(sameShaped).toContain(
      "projectGreeting(input?: { name?: string }) — Session override of project function.",
    );
    expect(sameShaped).not.toContain("Greets someone using the project convention.");
    expect(sameShaped).not.toContain("input.name: Name to greet.");
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

    const missingOverrideSource = new Map([["alpha", "placeholder"]]);
    missingOverrideSource.get = () => undefined;
    const missingOverrideCatalog = projectFunctionCatalog(docs, missingOverrideSource);
    expect(missingOverrideCatalog).toContain("- alpha — Session override of project function.");
    expect(missingOverrideCatalog).not.toContain("alpha(");

    const userCatalog = userFunctionCatalog(docs, new Map(), new Map());
    expect(userCatalog).toContain("## User functions");
    expect(userCatalog).toContain("1 more; use functions.listUser()");
    expect(userFunctionCatalog(docs, new Map([["alpha", "project"]]), new Map())).not.toContain(
      "alpha(input",
    );
  });
});
