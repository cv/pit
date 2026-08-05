import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupHarness,
  context,
  cwd,
  run,
  sessionStart,
  setupHarness,
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

async function writeProjectFunction(name: string, source: string): Promise<void> {
  const directory = join(cwd, ".pi/pit/functions");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.ts`), source);
}

describe("functions capability", () => {
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

  it("manages effective and session functions", async () => {
    await run(
      "/** Capability project. @pit project */ async function capabilityProject() { return 'project'; }",
    );
    await run("async function capabilitySession() { return 'session'; }");
    await run("async function removableSession() { return 1; }");
    await run("async function removableDependent() { return (await removableSession()) + 1; }");

    expect(
      await value(`async ({ functions }) => {
          const listed = await functions.listAll();
          const session = await functions.getSaved("capabilitySession");
          const project = await functions.getSaved("capabilityProject");
          return { listed, session, project };
        }`),
    ).toMatchObject({
      listed: [
        {
          name: "capabilityProject",
          scope: "project",
          signature: "capabilityProject()",
          directDependencies: [],
          directDependents: [],
          overridesProject: false,
        },
        {
          name: "capabilitySession",
          scope: "session",
          directDependencies: [],
          directDependents: [],
          overridesProject: false,
        },
        {
          name: "removableDependent",
          scope: "session",
          directDependencies: ["removableSession"],
          directDependents: [],
        },
        {
          name: "removableSession",
          scope: "session",
          directDependencies: [],
          directDependents: ["removableDependent"],
        },
      ],
      session: { name: "capabilitySession", scope: "session", directDependencies: [] },
      project: { name: "capabilityProject", scope: "project", directDependents: [] },
    });

    await expect(
      value(
        `async ({ functions }) => functions.promote("capabilitySession", "Promoted through the capability.")`,
      ),
    ).resolves.toEqual({ name: "capabilitySession", promoted: true, scope: "project" });
    await expect(
      readFile(join(cwd, ".pi/pit/functions/capabilitySession.ts"), "utf8"),
    ).resolves.toContain("Promoted through the capability.");

    expect(
      await value(`async ({ functions }) => ({
        session: await functions.planRemoval("removableSession"),
        project: await functions.planRemoval("capabilityProject", "project"),
      })`),
    ).toEqual({
      session: {
        name: "removableSession",
        scope: "session",
        directDependents: ["removableDependent"],
        transitiveDependents: [],
        removalClosure: ["removableDependent", "removableSession"],
        requiresCascade: true,
        blocked: false,
      },
      project: {
        name: "capabilityProject",
        scope: "project",
        directDependents: [],
        transitiveDependents: [],
        removalClosure: ["capabilityProject"],
        requiresCascade: false,
        blocked: false,
      },
    });
    await expect(
      run(`async ({ functions }) => functions.removeSession("removableSession")`),
    ).rejects.toThrow("without explicit cascade");
    expect((await value("async ({ context }) => context.get()")).sessionFunctions).toEqual([
      "removableDependent",
      "removableSession",
    ]);
    await expect(
      value(
        `async ({ functions }) => functions.removeSession("removableSession", { cascade: true })`,
      ),
    ).resolves.toEqual({
      name: "removableSession",
      removed: ["removableDependent", "removableSession"],
    });
    expect(await value("async ({ context }) => context.get()")).toMatchObject({
      projectFunctions: ["capabilityProject", "capabilitySession"],
      sessionFunctions: [],
    });
  }, 15_000);

  it("reports session overrides and blocked project removal plans", async () => {
    await run(
      "/** Shared plan helper. @pit project */ async function sharedPlan() { return 'project'; }",
    );
    await run("async function sharedPlan() { return 'session'; }");
    const override = await value(`async ({ functions }) => ({
      metadata: (await functions.listAll()).find(({ name }) => name === "sharedPlan"),
      plan: await functions.planRemoval("sharedPlan"),
    })`);
    expect(override).toMatchObject({
      metadata: { scope: "session", overridesProject: true },
      plan: { scope: "session", blocked: false, removalClosure: ["sharedPlan"] },
    });
    await value(`async ({ functions }) => functions.removeSession("sharedPlan")`);

    await run("/** Plan base. @pit project */ async function projectPlanBase() { return 1; }");
    await run(
      "/** Plan dependent. @pit project */ async function projectPlanDependent() { return projectPlanBase(); }",
    );
    expect(
      await value(`async ({ functions }) => functions.planRemoval("projectPlanBase", "project")`),
    ).toEqual({
      name: "projectPlanBase",
      scope: "project",
      directDependents: ["projectPlanDependent"],
      transitiveDependents: [],
      removalClosure: ["projectPlanBase"],
      requiresCascade: false,
      blocked: true,
    });
    await expect(
      run(`async ({ functions }) => functions.remove("projectPlanBase")`),
    ).rejects.toThrow("dependent saved functions remain");
    await expect(
      value(`async ({ functions }) => functions.get("projectPlanBase")`),
    ).resolves.toMatchObject({ name: "projectPlanBase" });
  }, 15_000);

  it("rejects unavailable and unknown operations", async () => {
    await expect(run(`async ({ functions }) => functions.get("missing")`)).rejects.toThrow(
      "is unavailable",
    );
    await expect(
      run(`async ({ functions }) => functions.promote("missingDefault", "Summary", {})`),
    ).rejects.toThrow("was not found");
    await expect(run(`async ({ functions }) => functions.getSaved("missing")`)).rejects.toThrow(
      "is unavailable",
    );
    await expect(
      run(`async ({ functions }) => functions.removeSession("missing")`),
    ).rejects.toThrow("was not found");
    await expect(
      run(`async ({ functions }) => (functions as any).planRemoval("missing", "invalid")`),
    ).rejects.toThrow('function scope must be "global", "project", or "session"');
    await expect(
      run(
        `async ({ functions }) => (functions as any).removeSession("missing", { cascade: "yes" })`,
      ),
    ).rejects.toThrow("options.cascade must be a boolean");
    await expect(
      run(`async ({ functions }) => (functions as any).removeSession("missing", { extra: true })`),
    ).rejects.toThrow("unknown fields: extra");

    await expect(
      run(`async ({ functions }) => (functions as any).unknown("value")`),
    ).rejects.toThrow("Unknown capability or method: functions.unknown");
  });
});
