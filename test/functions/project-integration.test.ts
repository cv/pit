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
} from "../support/extension-fixture.js";

const projectFunctionTestHooks = vi.hoisted(() => ({
  beforeRemove: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("../../src/functions/storage/project.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/functions/storage/project.js")>();
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
  const prefix = `async function ${name}({}) { /*`;
  const suffix = "*/ return true; }";
  return prefix + "x".repeat(bytes - Buffer.byteLength(prefix + suffix)) + suffix;
}

async function writeProjectFunction(name: string, source: string): Promise<void> {
  const directory = join(cwd, ".pi/functions");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.ts`), source);
}

function sessionFunctionEntry(name: string, source: string) {
  return {
    type: "custom",
    customType: "pit-function-definitions",
    data: { name, source },
  };
}

describe("project functions", () => {
  it("persists explicitly promoted project functions across sessions", async () => {
    const source = `/**
 * Greets someone using the project convention.
 *
 * @param input.name - Name to greet.
 */
async function projectGreeting({}, input: { name?: string } = {}) {
  return { greeting: "Hello, " + (input.name ?? "project") };
}`;
    const defined = await run(source);
    expect(defined.details.functions).toEqual([
      { action: "set", name: "projectGreeting", replaced: false },
    ]);
    expect(defined.content[0].text).toContain("Saved function");
    expect(defined.content[0].text).toContain("[Session functions: projectGreeting");

    await value(
      'async ({ functions: { list: functionList, promote, remove: removeProject } }) => promote("projectGreeting", "Greets someone using the project convention.")',
    );
    const stored = await readFile(join(cwd, ".pi/functions/projectGreeting.ts"), "utf8");
    expect(stored).not.toContain("@pit");
    expect(stored).toContain("Greets someone using the project convention.");

    const promptWithResources = beforeAgentStart(
      {
        systemPrompt: "base",
        systemPromptOptions: {
          skills: [
            {
              name: "delivery",
              description: "Deliver changes",
              filePath: "/skills/delivery/SKILL.md",
            },
          ],
        },
      },
      context(),
    ).systemPrompt;
    expect(promptWithResources).toContain("projectGreeting(input?: { name?: string })");
    expect(promptWithResources).toContain("<name>delivery</name>");
    expect(promptWithResources.indexOf("<available_skills>")).toBeLessThan(
      promptWithResources.indexOf("Project functions"),
    );

    setBranchEntries([]);
    await sessionStart({}, context());
    const invoked = await run(`async ({ projectGreeting }) => projectGreeting({ name: "Pi" })`);
    expect(invoked.details.value).toEqual({ greeting: "Hello, Pi" });
    expect(invoked.content[0].text).not.toContain("[Session functions:");
  });

  it("saves a selected session function to the project", async () => {
    await run("async function menuProject({}) { return 'project menu'; }");
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
    expect(await readFile(join(cwd, ".pi/functions/menuProject.ts"), "utf8")).toContain(
      "Runs the project menu workflow.",
    );
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        customType: "pit-function-definitions",
        data: { name: "menuProject", deleted: true },
      }),
    );
    expect(await value("async ({ menuProject }) => menuProject()")).toBe("project menu");
    expect((await value("async ({ context: { get } }) => get()")).sessionFunctions).toEqual([]);
    expect((await value("async ({ context: { get } }) => get()")).projectFunctions).toEqual([
      "menuProject",
    ]);
  });

  it("lists, inspects, and removes project functions from the manager", async () => {
    await writeProjectFunction(
      "managedProject",
      "/** Managed project helper. */ async function managedProject({}) { return true; }",
    );
    await sessionStart({}, context());
    const listed = context();
    await functionsCommand.handler("list", listed);
    expect(listed.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("managedProject [project]"),
      "info",
    );

    const ctx = context({ mode: "tui" });
    ctx.ui.select = vi
      .fn()
      .mockImplementationOnce(async (_title: string, options: string[]) =>
        options.find((option) => option.startsWith("managedProject [project]")),
      )
      .mockImplementationOnce(async (_title: string, options: string[]) => {
        expect(options).toEqual(["Inspect source", "Remove from project", "Close"]);
        return "Inspect source";
      })
      .mockImplementationOnce(async (_title: string, options: string[]) =>
        options.find((option) => option.startsWith("managedProject [project]")),
      )
      .mockResolvedValueOnce("Remove from project");

    await functionsCommand.handler("", ctx);

    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Remove managedProject from project?",
      "Delete .pi/functions/managedProject.ts?",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith("Removed project function: managedProject", "info");
    await expect(
      readFile(join(cwd, ".pi/functions/managedProject.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await value("async ({ context: { get } }) => get()")).projectFunctions).toEqual([]);
  });

  it("labels session overrides and directly inspects project functions", async () => {
    await writeProjectFunction(
      "scopedProject",
      "/** Scoped project helper. */ async function scopedProject({}) { return 'project'; }",
    );
    await sessionStart({}, context());
    const overridden = await run("async function scopedProject({}) { return 'session'; }");
    expect(overridden.content[0].text).toContain("[Session functions: scopedProject()]");
    const listed = context();
    await functionsCommand.handler("list", listed);
    expect(listed.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("scopedProject [session override]"),
      "info",
    );

    await writeProjectFunction(
      "directProject",
      "/** Direct inspection helper. */ async function directProject({}) { return true; }",
    );
    await sessionStart({}, context());
    const inspected = context({ mode: "tui" });
    await functionsCommand.handler("show directProject", inspected);
    expect(inspected.ui.custom).toHaveBeenCalledTimes(1);
  });

  it("handles cancelled, absent, and blocked project removals", async () => {
    await writeProjectFunction(
      "removalMenu",
      "/** Removal menu helper. */ async function removalMenu({}) { return true; }",
    );
    await sessionStart({}, context());
    const cancelled = context({ mode: "tui" });
    cancelled.ui.confirm.mockResolvedValueOnce(false);
    cancelled.ui.select = vi
      .fn()
      .mockImplementationOnce(async (_title: string, options: string[]) =>
        options.find((option) => option.startsWith("removalMenu [project]")),
      )
      .mockResolvedValueOnce("Remove from project")
      .mockResolvedValueOnce(undefined);

    await functionsCommand.handler("", cancelled);
    expect((await value("async ({ context: { get } }) => get()")).projectFunctions).toEqual([
      "removalMenu",
    ]);

    await rm(join(cwd, ".pi/functions/removalMenu.ts"));
    const absent = context({ mode: "tui" });
    absent.ui.select = vi
      .fn()
      .mockImplementationOnce(async (_title: string, options: string[]) =>
        options.find((option) => option.startsWith("removalMenu [project]")),
      )
      .mockResolvedValueOnce("Remove from project");

    await functionsCommand.handler("", absent);
    expect(absent.ui.notify).toHaveBeenCalledWith(
      "Project function file was absent: removalMenu",
      "warning",
    );

    await Promise.all([
      writeProjectFunction(
        "removalMenuBase",
        "/** Removal base. */ async function removalMenuBase({}) { return true; }",
      ),
      writeProjectFunction(
        "removalMenuDependent",
        "/** Removal dependent. */ async function removalMenuDependent({ removalMenuBase }) { return removalMenuBase(); }",
      ),
    ]);
    await sessionStart({}, context());
    const blocked = context({ mode: "tui" });
    blocked.ui.select = vi
      .fn()
      .mockImplementationOnce(async (_title: string, options: string[]) =>
        options.find((option) => option.startsWith("removalMenuBase [project]")),
      )
      .mockResolvedValueOnce("Remove from project")
      .mockResolvedValueOnce(undefined);

    await functionsCommand.handler("", blocked);
    expect(blocked.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("dependent saved functions remain"),
      "error",
    );
  });

  it("handles cancelled and invalid project saves from the function manager", async () => {
    await run("async function cancelledProject({}) { return true; }");
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
    expect((await value("async ({ context: { get } }) => get()")).sessionFunctions).toEqual([
      "cancelledProject",
    ]);

    await run("((async function wrappedProject({}) { return true; }))");
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
    expect((await value("async ({ context: { get } }) => get()")).sessionFunctions).toEqual([
      "cancelledProject",
      "wrappedProject",
    ]);
  });

  it("reloads project functions that invoke the typed npm capability", async () => {
    const source = `/** Runs project tests. */
async function projectTests({ npm: { test } }) {
  return test({ raise: true });
}`;
    await writeProjectFunction("projectTests", source);
    execMock.mockClear();

    await sessionStart({}, context());
    const invoked = await run("async ({ projectTests }) => projectTests()");

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
      '/** Project greeting. */ async function projectGreeting({}) { return "project"; }',
    );
    await sessionStart({}, context());
    await tool.execute(
      "call-id",
      { code: 'async function projectGreeting({}) { return "session"; }', saveOnly: true },
      undefined,
      undefined,
      context(),
    );
    expect(await value("async ({ projectGreeting }) => projectGreeting()")).toBe("session");

    setBranchEntries([]);
    await sessionStart({}, context());
    expect(await value("async ({ projectGreeting }) => projectGreeting()")).toBe("project");
  });

  it("wires idempotent project removal through the functions capability", async () => {
    await writeProjectFunction(
      "removableProject",
      "/** Removable project. */ async function removableProject({}) { return true; }",
    );
    await sessionStart({}, context());

    const removed =
      await run(`async ({ functions: { list: functionList, promote, remove: removeProject } }) => ({
      first: await removeProject("removableProject"),
      second: await removeProject("removableProject"),
    })`);
    expect(removed.details.value).toEqual({
      first: { name: "removableProject", removed: true },
      second: { name: "removableProject", removed: false },
    });
    expect(removed.details.functions).toEqual([
      { action: "remove", name: "removableProject", scope: "project" },
    ]);
    await expect(
      readFile(join(cwd, ".pi/functions/removableProject.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports save-only project updates and clears session overrides", async () => {
    await writeProjectFunction(
      "versionedProject",
      "/** Project version one. */ async function versionedProject({}) { return 1; }",
    );
    setBranchEntries([
      sessionFunctionEntry(
        "versionedProject",
        'async function versionedProject({}) { return "session override"; }',
      ),
      sessionFunctionEntry("sessionHelper", "async function sessionHelper({}) { return 42; }"),
    ]);
    await sessionStart({}, context());

    const source = "/** Project version two. */ async function versionedProject({}) { return 2; }";
    const saved = await tool.execute(
      "call-id",
      { code: source, saveOnly: true },
      undefined,
      undefined,
      context(),
    );
    expect(saved.details.value).toEqual({ savedFunction: "versionedProject", executed: false });
    await value(
      'async ({ functions: { list: functionList, promote, remove: removeProject } }) => promote("versionedProject", "Project version two.")',
    );
    // A matching summary keeps the documented source instead of adding a second JSDoc block.
    const promoted = await readFile(join(cwd, ".pi/functions/versionedProject.ts"), "utf8");
    expect(promoted.match(/\/\*\*/g)).toHaveLength(1);
    expect(promoted).toContain("/** Project version two. */");
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        customType: "pit-function-definitions",
        data: { name: "versionedProject", deleted: true },
      }),
    );
    expect(
      await value(
        "async ({ versionedProject, sessionHelper }) => Promise.all([versionedProject(), sessionHelper()])",
      ),
    ).toEqual([2, 42]);
  }, 15_000);

  it("keeps legacy scope markers session-scoped until explicit promotion", async () => {
    const saved = await run(`/** Legacy marker. @pit project */
async function markedSession({}) {
  return "session";
}`);

    expect(saved.details.functions).toEqual([
      { action: "set", name: "markedSession", replaced: false },
    ]);
    expect(await value("async ({ context: { get } }) => get()")).toMatchObject({
      projectFunctions: [],
      sessionFunctions: ["markedSession"],
    });
    await expect(
      readFile(join(cwd, ".pi/functions/markedSession.ts"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("serializes parallel capacity validation against the live effective registry", async () => {
    setBranchEntries(
      Array.from({ length: 9 }, (_, index) => ({
        type: "custom",
        customType: "pit-function-definitions",
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
    const sessionFunctions = (await value("async ({ context: { get } }) => get()"))
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
      "/** Quota project. */ async function quotaProject({}) { return true; }",
    );
    setBranchEntries([
      sessionFunctionEntry("quotaProject", "async function quotaProject({}) { return false; }"),
    ]);
    await sessionStart({}, context());
    expect(await value("async ({ quotaProject }) => quotaProject()")).toBe(false);

    await functionsCommand.handler("delete quotaProject", context());
    expect(await value("async ({ quotaProject }) => quotaProject()")).toBe(true);
  });

  it("rejects removal with project, transitive, and session dependents", async () => {
    await Promise.all([
      writeProjectFunction(
        "dependencyBase",
        "/** Base. */ async function dependencyBase({}) { return 1; }",
      ),
      writeProjectFunction(
        "directProject",
        "/** Direct project dependent. */ async function directProject({ dependencyBase }) { return dependencyBase(); }",
      ),
      writeProjectFunction(
        "transitiveProject",
        "/** Transitive project dependent. */ async function transitiveProject({ directProject }) { return directProject(); }",
      ),
    ]);
    setBranchEntries([
      sessionFunctionEntry("directProject", "async function directProject({}) { return 2; }"),
      sessionFunctionEntry(
        "sessionDependent",
        "async function sessionDependent({ dependencyBase }) { return dependencyBase(); }",
      ),
    ]);
    await sessionStart({}, context());

    await expect(
      run(
        'async ({ functions: { list: functionList, promote, remove: removeProject } }) => removeProject("dependencyBase")',
      ),
    ).rejects.toThrow("direct: directProject, sessionDependent; transitive: transitiveProject");
    await expect(readFile(join(cwd, ".pi/functions/dependencyBase.ts"), "utf8")).resolves.toContain(
      "dependencyBase",
    );
  });

  it("serializes project removal with a concurrent dependent save", async () => {
    await writeProjectFunction(
      "removalRaceBase",
      "/** Removal race base. */ async function removalRaceBase({}) { return 1; }",
    );
    await sessionStart({}, context());
    const functionPath = join(cwd, ".pi/functions/removalRaceBase.ts");
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
      const removal = run(
        `async ({ functions: { list: functionList, promote, remove: removeProject } }) => removeProject("removalRaceBase")`,
      );
      await removalBlocked;
      const dependentSave = tool.execute(
        "call-id",
        {
          code: "async function removalRaceDependent({ removalRaceBase }) { return removalRaceBase(); }",
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
      expect(await value("async ({ context: { get } }) => get()")).toMatchObject({
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
      "/** Project base. */ async function overriddenBase({}) { return 1; }",
    );
    setBranchEntries([
      sessionFunctionEntry("overriddenBase", "async function overriddenBase({}) { return 2; }"),
      sessionFunctionEntry(
        "overrideConsumer",
        "async function overrideConsumer({ overriddenBase }) { return overriddenBase(); }",
      ),
    ]);
    await sessionStart({}, context());

    await expect(
      value(
        'async ({ functions: { list: functionList, promote, remove: removeProject } }) => removeProject("overriddenBase")',
      ),
    ).resolves.toEqual({ name: "overriddenBase", removed: true });
    await expect(value("async ({ overrideConsumer }) => overrideConsumer()")).resolves.toBe(2);
  });

  it("commits project definitions only after successful execution", async () => {
    await expect(
      run(`/** Fails intentionally. */
async function brokenProject({}) { throw new Error("project failure"); }`),
    ).rejects.toThrow("project failure");
    await expect(
      readFile(join(cwd, ".pi/functions/brokenProject.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(run("async ({ brokenProject }) => brokenProject()")).rejects.toThrow(
      /Property 'brokenProject' does not exist/,
    );
  });

  it("warns about malformed project files at session start", async () => {
    const directory = join(cwd, ".pi/functions");
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
    await writeProjectFunction(
      "keptProject",
      "/** Kept while disabled. */ async function keptProject({}) { return true; }",
    );
    await sessionStart({}, context());
    await rm(join(cwd, ".pi/pit.json"));
    await sessionStart({}, context());

    await expect(
      run("/** Disabled helper. */ async function disabledProject({}) { return true; }"),
    ).resolves.toMatchObject({
      details: { functions: [{ action: "set", name: "disabledProject" }] },
    });
    await expect(
      run(
        "async ({ functions: { list: functionList, promote, remove: removeProject } }) => functionList()",
      ),
    ).rejects.toThrow("Project functions are disabled");
    await expect(
      readFile(join(cwd, ".pi/functions/disabledProject.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(cwd, ".pi/functions/keptProject.ts"), "utf8")).resolves.toContain(
      "Kept while disabled",
    );
    await expect(run("async ({ keptProject }) => keptProject()")).rejects.toThrow(
      /Property 'keptProject' does not exist/,
    );
    expect(await value("async ({ context: { get } }) => get()")).toMatchObject({
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
    expect(await value("async ({ context: { get } }) => get()", ctx)).toMatchObject({
      projectFunctionsEnabled: false,
    });
  });

  it("requires project trust only for explicit persistent operations", async () => {
    expect(beforeAgentStart({ systemPrompt: "base" }, context())).toBeUndefined();
    await expect(
      run("/** */ async function undocumented({}) { return null; }"),
    ).resolves.toMatchObject({
      details: { functions: [{ action: "set", name: "undocumented" }] },
    });
    await expect(
      run("/** Summary. @pit user */ async function wrongScope({}) { return null; }"),
    ).resolves.toMatchObject({
      details: { functions: [{ action: "set", name: "wrongScope" }] },
    });

    const untrusted = context({ isProjectTrusted: () => false });
    await expect(
      run(
        'async ({ functions: { list: functionList, promote, remove: removeProject } }) => promote("undocumented", "Documented helper.")',
        untrusted,
      ),
    ).rejects.toThrow("trusted project");
    await expect(
      run(
        "async ({ functions: { list: functionList, promote, remove: removeProject } }) => functionList()",
        untrusted,
      ),
    ).rejects.toThrow("trusted project");
  });
});
