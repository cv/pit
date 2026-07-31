import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beforeAgentStart,
  branchEntries,
  cleanupHarness,
  context,
  cwd,
  run,
  sessionStart,
  setBranchEntries,
  setupHarness,
  tool,
  value,
} from "./extension-fixture.js";

beforeEach(async () => {
  await setupHarness();
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi/pit.json"),
    JSON.stringify({ projectFunctions: { enabled: true } }),
  );
  await sessionStart({}, context());
});
afterEach(cleanupHarness);

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

  it("rejects removal with project, transitive, and session dependents", async () => {
    await run("/** Base. @pit project */ async function dependencyBase() { return 1; }");
    await run(
      "/** Direct project dependent. @pit project */ async function directProject() { return dependencyBase(); }",
    );
    await run(
      "/** Transitive project dependent. @pit project */ async function transitiveProject() { return directProject(); }",
    );
    await run(
      "/** Another transitive dependent. @pit project */ async function anotherTransitive(): Promise<number> { return directProject(); }",
    );
    for (const code of [
      "/** Cycle A. @pit project */ async function cycleA(): Promise<number> { return 0; }",
      "/** Cycle B. @pit project */ async function cycleB(): Promise<number> { return cycleA(); }",
      "/** Cycle A replacement. @pit project */ async function cycleA(): Promise<number> { return cycleB(); }",
    ]) {
      await tool.execute("call-id", { code, saveOnly: true }, undefined, undefined, context());
    }
    await run("async function sessionDependent() { return dependencyBase(); }");
    await run("async function directProject() { return 2; }");

    await expect(
      run('async ({ functions }) => functions.remove("dependencyBase")'),
    ).rejects.toThrow(
      "direct: directProject, sessionDependent; transitive: anotherTransitive, transitiveProject",
    );
    await expect(
      readFile(join(cwd, ".pi/pit/functions/dependencyBase.ts"), "utf8"),
    ).resolves.toContain("dependencyBase");
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

  it("applies function-count quotas to the effective project and session registry", async () => {
    await run("/** Project slot. @pit project */ async function projectSlot() { return true; }");
    setBranchEntries(
      Array.from({ length: 63 }, (_, index) => ({
        type: "custom",
        customType: "pit-functions",
        data: {
          name: `sessionSlot${index}`,
          source: `async function sessionSlot${index}() { return ${index}; }`,
        },
      })),
    );
    await sessionStart({}, context());
    expect((await value("async ({ context }) => context.get()")).savedFunctions).toHaveLength(64);
    await expect(
      tool.execute(
        "call-id",
        { code: "async function overflowSlot() { return true; }", saveOnly: true },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("limited to 64 functions");
    await expect(
      tool.execute(
        "call-id",
        { code: "async function sessionSlot0() { return 100; }", saveOnly: true },
        undefined,
        undefined,
        context(),
      ),
    ).resolves.toBeDefined();
  }, 15_000);

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
