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

async function writeProjectFunction(name: string, source: string): Promise<void> {
  const directory = join(cwd, ".pi/pit/functions");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.ts`), source);
}

function sessionFunctionEntry(name: string, source: string) {
  return {
    type: "custom",
    customType: "pit-functions",
    data: { name, source },
  };
}

describe("project functions", () => {
  it("persists project functions and reloads them across sessions", async () => {
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

    expect(beforeAgentStart({ systemPrompt: "base" }, context()).systemPrompt).toContain(
      "projectGreeting(input?: { name?: string })",
    );

    setBranchEntries([]);
    await sessionStart({}, context());
    expect(await value(`projectGreeting({ name: "Pi" })`)).toEqual({ greeting: "Hello, Pi" });
  });

  it("saves a selected session function to the project", async () => {
    await run("async function menuProject() { return 'project menu'; }");
    const ctx = context({ mode: "tui" });
    ctx.ui.input = vi.fn(async () => "Runs the project menu workflow.");
    ctx.ui.select = vi
      .fn()
      .mockImplementationOnce(async (_title: string, options: string[]) =>
        options.find((option) => option.startsWith("menuProject")),
      )
      .mockImplementationOnce(async (_title: string, options: string[]) => {
        expect(options).toContain("Save to project");
        return "Save to project";
      });

    await functionsCommand.handler("", ctx);

    expect(ctx.ui.input).toHaveBeenCalledWith(
      "Save menuProject to project",
      "Short project-function summary",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith("Saved function to project: menuProject", "info");
    expect(await readFile(join(cwd, ".pi/pit/functions/menuProject.ts"), "utf8")).toContain(
      "Runs the project menu workflow.",
    );
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        customType: "pit-functions",
        data: { name: "menuProject", deleted: true },
      }),
    );
    expect(await value("menuProject()")).toBe("project menu");
    expect((await value("async ({ context }) => context.get()")).sessionFunctions).toEqual([]);
    expect((await value("async ({ context }) => context.get()")).projectFunctions).toEqual([
      "menuProject",
    ]);
  });

  it("handles cancelled and invalid project saves from the function manager", async () => {
    await run("async function cancelledProject() { return true; }");
    const cancelled = context({ mode: "tui" });
    cancelled.ui.input.mockResolvedValueOnce(undefined as never);
    cancelled.ui.select = vi
      .fn()
      .mockImplementationOnce(async (_title: string, options: string[]) =>
        options.find((option) => option.startsWith("cancelledProject")),
      )
      .mockResolvedValueOnce("Save to project")
      .mockResolvedValueOnce(undefined);

    await functionsCommand.handler("", cancelled);
    expect((await value("async ({ context }) => context.get()")).sessionFunctions).toEqual([
      "cancelledProject",
    ]);

    await run("((async function wrappedProject() { return true; }))");
    const invalid = context({ mode: "tui" });
    invalid.ui.input = vi.fn(async () => "Wrapped project helper.");
    invalid.ui.select = vi
      .fn()
      .mockImplementationOnce(async (_title: string, options: string[]) =>
        options.find((option) => option.startsWith("wrappedProject")),
      )
      .mockResolvedValueOnce("Save to project")
      .mockResolvedValueOnce(undefined);

    await functionsCommand.handler("", invalid);
    expect(invalid.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("must be a top-level function declaration"),
      "error",
    );
    expect((await value("async ({ context }) => context.get()")).sessionFunctions).toEqual([
      "cancelledProject",
      "wrappedProject",
    ]);
  });

  it("reloads project functions that invoke the typed npm capability", async () => {
    const source = `/** Runs project tests. @pit project */
async function projectTests({ npm }) {
  return npm.test({ raise: true });
}`;
    await run(source);
    execMock.mockClear();

    await sessionStart({}, context());
    const invoked = await run("projectTests()");

    expect(execMock).toHaveBeenCalledWith(
      "npm",
      ["run", "test"],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(invoked.details.traces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: "npm", method: "test", status: "succeeded" }),
      ]),
    );
  });

  it("prefers session overrides until the session branch reloads", async () => {
    await writeProjectFunction(
      "projectGreeting",
      '/** Project greeting. @pit project */ async function projectGreeting() { return "project"; }',
    );
    await sessionStart({}, context());
    await tool.execute(
      "call-id",
      { code: 'async function projectGreeting() { return "session"; }', saveOnly: true },
      undefined,
      undefined,
      context(),
    );
    expect(await value("projectGreeting()")).toBe("session");

    setBranchEntries([]);
    await sessionStart({}, context());
    expect(await value("projectGreeting()")).toBe("project");
  });

  it("wires idempotent project removal through the functions capability", async () => {
    await writeProjectFunction(
      "removableProject",
      "/** Removable project. @pit project */ async function removableProject() { return true; }",
    );
    await sessionStart({}, context());

    const removed = await run(`async ({ functions }) => ({
      first: await functions.remove("removableProject"),
      second: await functions.remove("removableProject"),
    })`);
    expect(removed.details.value).toEqual({
      first: { name: "removableProject", removed: true },
      second: { name: "removableProject", removed: false },
    });
    expect(removed.details.functions).toEqual([
      { action: "remove", name: "removableProject", scope: "project" },
    ]);
    await expect(
      readFile(join(cwd, ".pi/pit/functions/removableProject.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports save-only project updates and clears session overrides", async () => {
    await writeProjectFunction(
      "versionedProject",
      "/** Project version one. @pit project */ async function versionedProject() { return 1; }",
    );
    setBranchEntries([
      sessionFunctionEntry(
        "versionedProject",
        'async function versionedProject() { return "session override"; }',
      ),
      sessionFunctionEntry("sessionHelper", "async function sessionHelper() { return 42; }"),
    ]);
    await sessionStart({}, context());

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
    expect(await value("Promise.all([versionedProject(), sessionHelper()])")).toEqual([2, 42]);
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

  it("reconciles the project function when a session override is deleted", async () => {
    await writeProjectFunction(
      "quotaProject",
      "/** Quota project. @pit project */ async function quotaProject() { return true; }",
    );
    setBranchEntries([
      sessionFunctionEntry(
        "quotaProject",
        'async function quotaProject() { return "session override"; }',
      ),
    ]);
    await sessionStart({}, context());
    expect(await value("quotaProject()")).toBe("session override");

    await functionsCommand.handler("delete quotaProject", context());
    expect(await value("quotaProject()")).toBe(true);
  });

  it("rejects removal with project, transitive, and session dependents", async () => {
    await Promise.all([
      writeProjectFunction(
        "dependencyBase",
        "/** Base. @pit project */ async function dependencyBase() { return 1; }",
      ),
      writeProjectFunction(
        "directProject",
        "/** Direct project dependent. @pit project */ async function directProject() { return dependencyBase(); }",
      ),
      writeProjectFunction(
        "transitiveProject",
        "/** Transitive project dependent. @pit project */ async function transitiveProject() { return directProject(); }",
      ),
    ]);
    setBranchEntries([
      sessionFunctionEntry("directProject", "async function directProject() { return 2; }"),
      sessionFunctionEntry(
        "sessionDependent",
        "async function sessionDependent() { return dependencyBase(); }",
      ),
    ]);
    await sessionStart({}, context());

    await expect(
      run('async ({ functions }) => functions.remove("dependencyBase")'),
    ).rejects.toThrow("direct: directProject, sessionDependent; transitive: transitiveProject");
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
    await writeProjectFunction(
      "overriddenBase",
      "/** Project base. @pit project */ async function overriddenBase() { return 1; }",
    );
    setBranchEntries([
      sessionFunctionEntry("overriddenBase", "async function overriddenBase() { return 2; }"),
      sessionFunctionEntry(
        "overrideConsumer",
        "async function overrideConsumer() { return overriddenBase(); }",
      ),
    ]);
    await sessionStart({}, context());

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

  it("lists and gets sorted project definitions", async () => {
    await Promise.all([
      writeProjectFunction(
        "betaProject",
        "/** Beta. @pit project */ async function betaProject() { return true; }",
      ),
      writeProjectFunction(
        "alphaProject",
        "/** Alpha. @pit project */ async function alphaProject() { return true; }",
      ),
    ]);
    await sessionStart({}, context());

    expect(
      await value(`async ({ functions }) => {
        const listed = await functions.list();
        const found = await functions.get("alphaProject");
        return { names: listed.map((item) => item.name), source: found.source };
      }`),
    ).toEqual({
      names: ["alphaProject", "betaProject"],
      source: "/** Alpha. @pit project */ async function alphaProject() { return true; }",
    });
  });

  it("rejects unavailable and unknown project capability operations", async () => {
    await expect(run(`async ({ functions }) => functions.get("missing")`)).rejects.toThrow(
      "is unavailable",
    );
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
