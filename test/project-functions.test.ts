import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beforeAgentStart,
  branchEntries,
  cleanupHarness,
  context,
  cwd,
  execMock,
  functionsCommand,
  run,
  sessionStart,
  sessionTree,
  setBranchEntries,
  setupHarness,
  tool,
  value,
} from "./extension-fixture.js";

const projectFunctionTestHooks = vi.hoisted(() => ({
  beforeRemove: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("../src/project-functions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/project-functions.js")>();
  return {
    ...actual,
    async removeProjectFunction(cwd: string, name: string): Promise<boolean> {
      await projectFunctionTestHooks.beforeRemove?.();
      return actual.removeProjectFunction(cwd, name);
    },
  };
});

beforeEach(async () => {
  projectFunctionTestHooks.beforeRemove = undefined;
  await setupHarness();
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi/pit.json"),
    JSON.stringify({ projectFunctions: { enabled: true } }),
  );
  await sessionStart({}, context());
});
afterEach(cleanupHarness);

function sizedFunction(name: string, bytes: number): string {
  const prefix = `async function ${name}() { /*`;
  const suffix = "*/ return true; }";
  return prefix + "x".repeat(bytes - Buffer.byteLength(prefix + suffix)) + suffix;
}

function sizedProjectFunction(name: string, bytes: number): string {
  const prefix = `/** ${name} helper. @pit project */ async function ${name}() { /*`;
  const suffix = "*/ return true; }";
  return prefix + "x".repeat(bytes - Buffer.byteLength(prefix + suffix)) + suffix;
}

function sizedProjectDependent(name: string, dependency: string, bytes: number): string {
  const prefix = `/** ${name} helper. @pit project */ async function ${name}() { /*`;
  const suffix = `*/ return ${dependency}(); }`;
  return prefix + "x".repeat(bytes - Buffer.byteLength(prefix + suffix)) + suffix;
}

describe("project functions", () => {
  it("persists documented functions across sessions and advertises them", async () => {
    const source = `/**
 * Greets someone using the project convention.
 *
 * @pit project
 * @param input.name - Name to greet.
 */
async function projectGreeting(_capabilities, input: { name?: string } = {}) {
  return { greeting: "Hello, " + (input.name ?? "project") };
}`;
    const defined = await run(source);
    expect(defined.details.functions).toEqual([
      { action: "set", name: "projectGreeting", scope: "project", replaced: false },
    ]);
    expect(defined.content[0].text).toContain("Saved project function");
    expect(await readFile(join(cwd, ".pi/pit/functions/projectGreeting.ts"), "utf8")).toContain(
      "@pit project",
    );

    const catalog = beforeAgentStart({ systemPrompt: "base" }, context());
    expect(catalog.systemPrompt).toContain(
      "projectGreeting(input?: { name?: string }) — Greets someone using the project convention.",
    );
    expect(catalog.systemPrompt).toContain("input.name: Name to greet.");

    await value(`async function projectGreeting() { return { greeting: "session" }; }`);
    expect(await value("projectGreeting()")).toEqual({ greeting: "session" });

    const differentlyShapedCatalog = beforeAgentStart({ systemPrompt: "base" }, context());
    expect(differentlyShapedCatalog.systemPrompt).toContain(
      "projectGreeting() — Session override of project function.",
    );
    expect(differentlyShapedCatalog.systemPrompt).not.toContain(
      "Greets someone using the project convention.",
    );
    expect(differentlyShapedCatalog.systemPrompt).not.toContain("input.name: Name to greet.");

    await value(`async function projectGreeting(
      _capabilities,
      input: { name?: string } = {},
    ) { return { greeting: "session " + (input.name ?? "override") }; }`);
    expect(await value(`projectGreeting({ name: "Pi" })`)).toEqual({ greeting: "session Pi" });

    const sameShapedCatalog = beforeAgentStart({ systemPrompt: "base" }, context());
    expect(sameShapedCatalog.systemPrompt).toContain(
      "projectGreeting(input?: { name?: string }) — Session override of project function.",
    );
    expect(sameShapedCatalog.systemPrompt).not.toContain(
      "Greets someone using the project convention.",
    );
    expect(sameShapedCatalog.systemPrompt).not.toContain("input.name: Name to greet.");

    setBranchEntries([]);
    await sessionStart({}, context());
    expect(await value(`projectGreeting({ name: "Pi" })`)).toEqual({ greeting: "Hello, Pi" });
    expect(await value("async ({ context }) => context.get()")).toMatchObject({
      savedFunctions: ["projectGreeting"],
      projectFunctions: ["projectGreeting"],
      sessionFunctions: [],
    });

    const listed = await value("async ({ functions }) => functions.list()");
    expect(listed).toEqual([
      {
        name: "projectGreeting",
        signature: "projectGreeting(input?: { name?: string })",
        summary: "Greets someone using the project convention.",
        parameters: [{ name: "input.name", description: "Name to greet." }],
      },
    ]);
    expect(
      (await value(`async ({ functions }) => functions.get("projectGreeting")`)).source,
    ).toContain("@pit project");

    const removed = await run(`async ({ functions }) => functions.remove("projectGreeting")`);
    expect(removed.details.value).toEqual({ name: "projectGreeting", removed: true });
    expect(removed.details.functions).toEqual([
      { action: "remove", name: "projectGreeting", scope: "project" },
    ]);
    await expect(run("projectGreeting()")).rejects.toThrow("Cannot find name 'projectGreeting'");
  });

  it("supports save-only project updates and clears session overrides", async () => {
    await run(
      "/** Project version one. @pit project */ async function versionedProject() { return 1; }",
    );
    await run("async function versionedProject() { return 99; }");
    expect(await value("versionedProject()")).toBe(99);
    await run("async function sessionHelper() { return 42; }");

    const source =
      "/** Project version two. @pit project */ async function versionedProject() { return 2; }";
    const saved = await tool.execute(
      "call-id",
      { code: source, saveOnly: true },
      undefined,
      undefined,
      context(),
    );
    expect(saved.details.value).toEqual({ savedFunction: "versionedProject", executed: false });
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        customType: "pit-functions",
        data: { name: "versionedProject", deleted: true },
      }),
    );
    expect(await value("versionedProject()")).toBe(2);
    expect(await value("sessionHelper()")).toBe(42);
  });

  it("preserves a concurrent session save when a slow project definition commits later", async () => {
    let signalProjectStarted!: () => void;
    const projectStarted = new Promise<void>((resolve) => {
      signalProjectStarted = resolve;
    });
    let releaseProject!: () => void;
    const projectGate = new Promise<void>((resolve) => {
      releaseProject = resolve;
    });
    execMock.mockImplementationOnce(async () => {
      signalProjectStarted();
      await projectGate;
      return { stdout: "", stderr: "", code: 0 };
    });

    const projectSave = run(`/** Slow marked project definition. @pit project */
async function slowProject({ shell }) {
  await shell.execFile("slow-project-definition", []);
  return "project";
}`);
    await projectStarted;
    const sessionSave = run(`async function concurrentSession() { return "session"; }`);
    await sessionSave;
    releaseProject();
    await Promise.all([projectSave, sessionSave]);

    expect(await value("async ({ context }) => context.get()")).toMatchObject({
      projectFunctions: ["slowProject"],
      sessionFunctions: ["concurrentSession"],
      savedFunctions: ["concurrentSession", "slowProject"],
    });
    expect(await value("concurrentSession()")).toBe("session");
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        customType: "pit-functions",
        data: expect.objectContaining({ name: "concurrentSession" }),
      }),
    );
  });

  it("serializes parallel capacity validation against the live effective registry", async () => {
    setBranchEntries(
      Array.from({ length: 9 }, (_, index) => ({
        type: "custom",
        customType: "pit-functions",
        data: {
          name: `capacityBase${index}`,
          source: sizedFunction(`capacityBase${index}`, 99_000),
        },
      })),
    );
    await sessionStart({}, context());

    const results = await Promise.allSettled(
      ["capacityParallelA", "capacityParallelB"].map((name) =>
        tool.execute(
          "call-id",
          { code: sizedFunction(name, 60_000), saveOnly: true },
          undefined,
          undefined,
          context(),
        ),
      ),
    );

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({
      reason: expect.objectContaining({ message: expect.stringContaining("total source") }),
    });
    const sessionFunctions = (await value("async ({ context }) => context.get()"))
      .sessionFunctions as string[];
    expect(sessionFunctions).toHaveLength(10);
    expect(
      sessionFunctions.filter((name) => ["capacityParallelA", "capacityParallelB"].includes(name)),
    ).toHaveLength(1);
    expect(branchEntries).toHaveLength(10);
  }, 15_000);

  it("reconciles the effective byte quota when a session override is deleted", async () => {
    const directory = join(cwd, ".pi/pit/functions");
    await mkdir(directory, { recursive: true });
    const projectSources = Array.from({ length: 11 }, (_, index) => {
      const name = `quotaProject${String(index).padStart(2, "0")}`;
      return [name, sizedProjectFunction(name, index === 10 ? 20_000 : 99_000)] as const;
    });
    await Promise.all(
      projectSources.map(([name, source]) => writeFile(join(directory, `${name}.ts`), source)),
    );
    const overrideSource = `async function quotaProject00() { return "session override"; }`;
    setBranchEntries([
      {
        type: "custom",
        customType: "pit-functions",
        data: { name: "quotaProject00", source: overrideSource },
      },
    ]);

    const projectBytes = projectSources.reduce(
      (total, [, source]) => total + Buffer.byteLength(source),
      0,
    );
    expect(projectBytes).toBe(1_010_000);
    expect(projectBytes - 99_000 + Buffer.byteLength(overrideSource)).toBeLessThanOrEqual(
      1_000_000,
    );

    await sessionStart({}, context());
    const state = await value("async ({ context }) => context.get()");
    expect(state.projectFunctions).toHaveLength(11);
    expect(state.sessionFunctions).toEqual(["quotaProject00"]);
    expect(state.savedFunctions).toHaveLength(11);
    expect(await value("quotaProject00()")).toBe("session override");
    expect(await value("quotaProject10()")).toBe(true);

    await functionsCommand.handler("delete quotaProject00", context());
    const reconciled = await value("async ({ context }) => context.get()");
    expect(reconciled.sessionFunctions).toEqual([]);
    expect(reconciled.projectFunctions).toEqual(
      Array.from({ length: 10 }, (_, index) => `quotaProject${String(index).padStart(2, "0")}`),
    );
    expect(reconciled.savedFunctions).toEqual(reconciled.projectFunctions);
    const effectiveBytes = projectSources
      .filter(([name]) => reconciled.savedFunctions.includes(name))
      .reduce((total, [, source]) => total + Buffer.byteLength(source), 0);
    expect(effectiveBytes).toBeLessThanOrEqual(1_000_000);
    expect(beforeAgentStart({ systemPrompt: "base" }, context()).systemPrompt).not.toContain(
      "quotaProject10",
    );
    expect(await value("quotaProject00()")).toBe(true);
    await expect(run("quotaProject10()")).rejects.toThrow("Cannot find name 'quotaProject10'");
  }, 15_000);

  it("does not advertise a project dependent whose required project exceeds quota", async () => {
    const directory = join(cwd, ".pi/pit/functions");
    await mkdir(directory, { recursive: true });
    const sources = [
      ...Array.from({ length: 9 }, (_, index) => {
        const name = `aQuotaFill${String(index).padStart(2, "0")}`;
        return [name, sizedProjectFunction(name, 99_000)] as const;
      }),
      [
        "bQuotaDependent",
        sizedProjectDependent("bQuotaDependent", "zQuotaDependency", 60_000),
      ] as const,
      ["zQuotaDependency", sizedProjectFunction("zQuotaDependency", 60_000)] as const,
    ];
    await Promise.all(
      sources.map(([name, source]) => writeFile(join(directory, `${name}.ts`), source)),
    );

    const ctx = context();
    await sessionStart({}, ctx);
    const state = await value("async ({ context }) => context.get()");
    expect(state.projectFunctions).toContain("zQuotaDependency");
    expect(state.projectFunctions).not.toContain("bQuotaDependent");
    expect(state.savedFunctions).not.toContain("bQuotaDependent");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/bQuotaDependent.*total source/),
      "warning",
    );
    await expect(run("bQuotaDependent()")).rejects.toThrow("Cannot find name 'bQuotaDependent'");
  }, 15_000);

  it("rejects a session dependent when its required project cannot fit", async () => {
    const directory = join(cwd, ".pi/pit/functions");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "zSessionDependency.ts"),
      sizedProjectFunction("zSessionDependency", 20_000),
    );
    setBranchEntries([
      ...Array.from({ length: 10 }, (_, index) => {
        const name = `sessionQuotaFill${String(index).padStart(2, "0")}`;
        return {
          type: "custom",
          customType: "pit-functions",
          data: { name, source: sizedFunction(name, 99_000) },
        };
      }),
      {
        type: "custom",
        customType: "pit-functions",
        data: {
          name: "sessionQuotaDependent",
          source: "async function sessionQuotaDependent() { return zSessionDependency(); }",
        },
      },
    ]);

    const ctx = context();
    await sessionStart({}, ctx);
    const state = await value("async ({ context }) => context.get()");
    expect(state.sessionFunctions).toHaveLength(10);
    expect(state.sessionFunctions).not.toContain("sessionQuotaDependent");
    expect(state.projectFunctions).not.toContain("zSessionDependency");
    expect(state.savedFunctions).not.toContain("sessionQuotaDependent");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/session function sessionQuotaDependent.*total source/),
      "warning",
    );

    setBranchEntries([]);
    sessionTree({}, context());
    expect(await value("async ({ context }) => context.get()")).toMatchObject({
      projectFunctions: ["zSessionDependency"],
      sessionFunctions: [],
      savedFunctions: ["zSessionDependency"],
    });
  }, 15_000);

  it("rejects removal with project, transitive, and session dependents", async () => {
    await run("/** Base. @pit project */ async function dependencyBase() { return 1; }");
    for (const code of [
      "/** Direct project dependent. @pit project */ async function directProject() { return dependencyBase(); }",
      "/** Transitive project dependent. @pit project */ async function transitiveProject() { return directProject(); }",
      "/** Another transitive dependent. @pit project */ async function anotherTransitive(): Promise<number> { return directProject(); }",
      "/** Cycle A. @pit project */ async function cycleA(): Promise<number> { return 0; }",
      "/** Cycle B. @pit project */ async function cycleB(): Promise<number> { return cycleA(); }",
      "/** Cycle A replacement. @pit project */ async function cycleA(): Promise<number> { return cycleB(); }",
      "async function directProject() { return 2; }",
    ]) {
      await tool.execute("call-id", { code, saveOnly: true }, undefined, undefined, context());
    }
    await run("async function sessionDependent() { return dependencyBase(); }");

    await expect(
      run('async ({ functions }) => functions.remove("dependencyBase")'),
    ).rejects.toThrow(
      "direct: directProject, sessionDependent; transitive: anotherTransitive, transitiveProject",
    );
    await expect(
      readFile(join(cwd, ".pi/pit/functions/dependencyBase.ts"), "utf8"),
    ).resolves.toContain("dependencyBase");
  });

  it("serializes project removal with a concurrent dependent save", async () => {
    await run(
      "/** Removal race base. @pit project */ async function removalRaceBase() { return 1; }",
    );
    const functionPath = join(cwd, ".pi/pit/functions/removalRaceBase.ts");
    let signalRemovalBlocked!: () => void;
    const removalBlocked = new Promise<void>((resolve) => {
      signalRemovalBlocked = resolve;
    });
    let releaseRemoval!: () => void;
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    projectFunctionTestHooks.beforeRemove = async () => {
      signalRemovalBlocked();
      await removalGate;
    };

    try {
      const removal = run(`async ({ functions }) => functions.remove("removalRaceBase")`);
      await removalBlocked;
      const dependentSave = tool.execute(
        "call-id",
        {
          code: "async function removalRaceDependent() { return removalRaceBase(); }",
          saveOnly: true,
        },
        undefined,
        undefined,
        context(),
      );
      releaseRemoval();

      const [removalResult, saveResult] = await Promise.allSettled([removal, dependentSave]);
      expect(removalResult).toMatchObject({
        status: "fulfilled",
        value: { details: { value: { name: "removalRaceBase", removed: true } } },
      });
      expect(saveResult).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining("removalRaceBase"),
        }),
      });
      expect(await value("async ({ context }) => context.get()")).toMatchObject({
        projectFunctions: [],
        sessionFunctions: [],
        savedFunctions: [],
      });
      await expect(readFile(functionPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseRemoval();
      projectFunctionTestHooks.beforeRemove = undefined;
    }
  });

  it("allows project removal when session overrides satisfy session dependents", async () => {
    await run("/** Project base. @pit project */ async function overriddenBase() { return 1; }");
    await run("async function overriddenBase() { return 2; }");
    await run("async function overrideConsumer() { return overriddenBase(); }");

    await expect(
      value('async ({ functions }) => functions.remove("overriddenBase")'),
    ).resolves.toEqual({ name: "overriddenBase", removed: true });
    await expect(value("overrideConsumer()")).resolves.toBe(2);
  });

  it("commits project definitions only after successful execution", async () => {
    await expect(
      run(`/** Fails intentionally. @pit project */
async function brokenProject() { throw new Error("project failure"); }`),
    ).rejects.toThrow("project failure");
    await expect(
      readFile(join(cwd, ".pi/pit/functions/brokenProject.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(run("brokenProject()")).rejects.toThrow("Cannot find name 'brokenProject'");
  });

  it("supports sorted inspection, idempotent removal, and invalid operations", async () => {
    await run("/** Beta. @pit project */ async function betaProject() { return true; }");
    await run("/** Alpha. @pit project */ async function alphaProject() { return true; }");
    expect(
      (await value("async ({ functions }) => functions.list()")).map(
        (item: { name: string }) => item.name,
      ),
    ).toEqual(["alphaProject", "betaProject"]);
    await expect(run(`async ({ functions }) => functions.get("missing")`)).rejects.toThrow(
      "is unavailable",
    );
    expect(await value(`async ({ functions }) => functions.remove("alphaProject")`)).toEqual({
      name: "alphaProject",
      removed: true,
    });
    expect(await value(`async ({ functions }) => functions.remove("alphaProject")`)).toEqual({
      name: "alphaProject",
      removed: false,
    });
    await expect(
      run(`async ({ functions }) => (functions as any).unknown("value")`),
    ).rejects.toThrow("Unknown capability or method: functions.unknown");
  });

  it("warns about malformed project files at session start", async () => {
    const directory = join(cwd, ".pi/pit/functions");
    await mkdir(directory, { recursive: true });
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        writeFile(join(directory, "bad" + index + ".ts"), "async function bad" + index + "() {}"),
      ),
    );
    const ctx = context();
    await sessionStart({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("1 more"), "warning");

    await Promise.all([1, 2, 3].map((index) => rm(join(directory, `bad${index}.ts`))));
    const oneError = context();
    await sessionStart({}, oneError);
    expect(oneError.ui.notify).toHaveBeenCalledWith(expect.not.stringContaining("more"), "warning");
  });

  it("is disabled unless the project explicitly opts in", async () => {
    await run(
      "/** Kept while disabled. @pit project */ async function keptProject() { return true; }",
    );
    await rm(join(cwd, ".pi/pit.json"));
    await sessionStart({}, context());

    await expect(
      run("/** Disabled helper. @pit project */ async function disabledProject() { return true; }"),
    ).rejects.toThrow("Project functions are disabled");
    await expect(run("async ({ functions }) => functions.list()")).rejects.toThrow(
      "Project functions are disabled",
    );
    await expect(
      readFile(join(cwd, ".pi/pit/functions/disabledProject.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(cwd, ".pi/pit/functions/keptProject.ts"), "utf8"),
    ).resolves.toContain("Kept while disabled");
    await expect(run("keptProject()")).rejects.toThrow("Cannot find name 'keptProject'");
    expect(await value("async ({ context }) => context.get()")).toMatchObject({
      projectFunctionsEnabled: false,
      projectFunctions: [],
    });
  });

  it("warns and stays disabled when project configuration is invalid", async () => {
    await writeFile(join(cwd, ".pi/pit.json"), "not json");
    const ctx = context();
    await sessionStart({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid .pi/pit.json"),
      "warning",
    );
    expect(await value("async ({ context }) => context.get()", ctx)).toMatchObject({
      projectFunctionsEnabled: false,
    });
  });

  it("requires descriptive JSDoc and project trust", async () => {
    expect(beforeAgentStart({ systemPrompt: "base" }, context())).toBeUndefined();
    await expect(
      run("/** @pit project */ async function undocumented() { return null; }"),
    ).rejects.toThrow("require a JSDoc summary");
    await expect(
      run("/** Summary. @pit global */ async function wrongScope() { return null; }"),
    ).rejects.toThrow('value "project"');
    const untrusted = context({ isProjectTrusted: () => false });
    await expect(
      run("/** Summary. @pit project */ async function unsafe() { return null; }", untrusted),
    ).rejects.toThrow("trusted project");
    await expect(run("async ({ functions }) => functions.list()", untrusted)).rejects.toThrow(
      "trusted project",
    );
  });
});
