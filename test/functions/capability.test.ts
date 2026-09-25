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
} from "../support/extension-fixture.js";

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
  const directory = join(cwd, ".pi/functions");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.ts`), source);
}

describe("functions capability", () => {
  it("lists and gets sorted project definitions", async () => {
    await Promise.all([
      writeProjectFunction(
        "betaProject",
        "/** Beta. */ async function betaProject({}) { return true; }",
      ),
      writeProjectFunction(
        "alphaProject",
        "/** Alpha. */ async function alphaProject({}) { return true; }",
      ),
    ]);
    await sessionStart({}, context());

    expect(
      await value(`async ({ functions: { get: functionGet, getSaved, list: functionList, listAll, planRemoval, promote, remove: removeProject, removeSession } }) => {
        const listed = await functionList();
        const found = await functionGet("alphaProject");
        return { names: listed.map((item) => item.name), source: found.source };
      }`),
    ).toEqual({
      names: ["alphaProject", "betaProject"],
      source: "/** Alpha. */ async function alphaProject({}) { return true; }",
    });
  });

  it("manages effective and session functions", async () => {
    await writeProjectFunction(
      "capabilityProject",
      "/** Capability project. */ async function capabilityProject({}) { return 'project'; }",
    );
    await sessionStart({}, context());
    await run("async function capabilitySession({}) { return 'session'; }");
    await run("async function removableSession({}) { return 1; }");
    await run(
      "async function removableDependent({ removableSession }) { return (await removableSession()) + 1; }",
    );

    expect(
      await value(`async ({ functions: { get: functionGet, getSaved, list: functionList, listAll, planRemoval, promote, remove: removeProject, removeSession } }) => {
          const listed = (await listAll({ limit: 200 })).functions.filter(entry => entry.kind === "source");
          const session = await getSaved("capabilitySession");
          const project = await getSaved("capabilityProject");
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
        `async ({ functions: { get: functionGet, getSaved, list: functionList, listAll, planRemoval, promote, remove: removeProject, removeSession } }) => promote("capabilitySession", "Promoted through the capability.")`,
      ),
    ).resolves.toEqual({ name: "capabilitySession", promoted: true, scope: "project" });
    await expect(
      readFile(join(cwd, ".pi/functions/capabilitySession.ts"), "utf8"),
    ).resolves.toContain("Promoted through the capability.");

    expect(
      await value(`async ({ functions: { get: functionGet, getSaved, list: functionList, listAll, planRemoval, promote, remove: removeProject, removeSession } }) => ({
        session: await planRemoval("removableSession"),
        project: await planRemoval("capabilityProject", "project"),
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
      run(
        `async ({ functions: { get: functionGet, getSaved, list: functionList, listAll, planRemoval, promote, remove: removeProject, removeSession } }) => removeSession("removableSession")`,
      ),
    ).rejects.toThrow("without explicit cascade");
    expect((await value("async ({ context: { get } }) => get()")).sessionFunctions).toEqual([
      "removableDependent",
      "removableSession",
    ]);
    await expect(
      value(
        `async ({ functions: { get: functionGet, getSaved, list: functionList, listAll, planRemoval, promote, remove: removeProject, removeSession } }) => removeSession("removableSession", { cascade: true })`,
      ),
    ).resolves.toEqual({
      name: "removableSession",
      removed: ["removableDependent", "removableSession"],
    });
    expect(await value("async ({ context: { get } }) => get()")).toMatchObject({
      projectFunctions: ["capabilityProject", "capabilitySession"],
      sessionFunctions: [],
    });
  });

  it("reports session overrides and blocked project removal plans", async () => {
    await writeProjectFunction(
      "sharedPlan",
      "/** Shared plan helper. */ async function sharedPlan({}) { return 'project'; }",
    );
    await sessionStart({}, context());
    await run("async function sharedPlan({}) { return 'session'; }");
    const override =
      await value(`async ({ functions: { get: functionGet, getSaved, list: functionList, listAll, planRemoval, promote, remove: removeProject, removeSession } }) => ({
      metadata: (await listAll({ scope: "session" })).functions.find(({ name }) => name === "sharedPlan"),
      plan: await planRemoval("sharedPlan"),
    })`);
    expect(override).toMatchObject({
      metadata: { scope: "session", overridesProject: true },
      plan: { scope: "session", blocked: false, removalClosure: ["sharedPlan"] },
    });
    await value(
      `async ({ functions: { get: functionGet, getSaved, list: functionList, listAll, planRemoval, promote, remove: removeProject, removeSession } }) => removeSession("sharedPlan")`,
    );

    await Promise.all([
      writeProjectFunction(
        "projectPlanBase",
        "/** Plan base. */ async function projectPlanBase({}) { return 1; }",
      ),
      writeProjectFunction(
        "projectPlanDependent",
        "/** Plan dependent. */ async function projectPlanDependent({ projectPlanBase }) { return projectPlanBase(); }",
      ),
    ]);
    await sessionStart({}, context());
    expect(
      await value(
        `async ({ functions: { get: functionGet, getSaved, list: functionList, listAll, planRemoval, promote, remove: removeProject, removeSession } }) => planRemoval("projectPlanBase", "project")`,
      ),
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
      run(
        `async ({ functions: { get: functionGet, getSaved, list: functionList, listAll, planRemoval, promote, remove: removeProject, removeSession } }) => removeProject("projectPlanBase")`,
      ),
    ).rejects.toThrow("dependent saved functions remain");
    await expect(
      value(
        `async ({ functions: { get: functionGet, getSaved, list: functionList, listAll, planRemoval, promote, remove: removeProject, removeSession } }) => functionGet("projectPlanBase")`,
      ),
    ).resolves.toMatchObject({ name: "projectPlanBase" });
  });

  it("rejects unavailable and unknown operations", async () => {
    await expect(
      run(
        `async ({ functions: { get: functionGet, getSaved, list: functionList, listAll, planRemoval, promote, remove: removeProject, removeSession } }) => functionGet("missing")`,
      ),
    ).rejects.toThrow("is unavailable");
    await expect(
      run(
        `async ({ functions: { get: functionGet, getSaved, list: functionList, listAll, planRemoval, promote, remove: removeProject, removeSession } }) => promote("missingDefault", "Summary", {})`,
      ),
    ).rejects.toThrow("was not found");
    await expect(
      run(
        `async ({ functions: { get: functionGet, getSaved, list: functionList, listAll, planRemoval, promote, remove: removeProject, removeSession } }) => getSaved("missing")`,
      ),
    ).rejects.toThrow("is unavailable");
    await expect(
      run(
        `async ({ functions: { get: functionGet, getSaved, list: functionList, listAll, planRemoval, promote, remove: removeProject, removeSession } }) => removeSession("missing")`,
      ),
    ).rejects.toThrow("was not found");
    await expect(
      run(
        `async ({ functions: { get: functionGet, getSaved, list: functionList, listAll, planRemoval, promote, remove: removeProject, removeSession } }) => (planRemoval as any)("missing", "invalid")`,
      ),
    ).rejects.toThrow('function scope must be "global", "user", "project", or "session"');
    await expect(
      run(
        `async ({ functions: { get: functionGet, getSaved, list: functionList, listAll, planRemoval, promote, remove: removeProject, removeSession } }) => (removeSession as any)("missing", { cascade: "yes" })`,
      ),
    ).rejects.toThrow("options.cascade must be a boolean");
    await expect(
      run(
        `async ({ functions: { get: functionGet, getSaved, list: functionList, listAll, planRemoval, promote, remove: removeProject, removeSession } }) => (removeSession as any)("missing", { extra: true })`,
      ),
    ).rejects.toThrow("unknown fields: extra");
  });
});
