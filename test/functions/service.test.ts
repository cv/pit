import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FunctionActivity, FunctionEntry } from "../../src/functions/core.js";
import { SavedFunctionService } from "../../src/functions/service.js";
import {
  createFunctionState,
  createFunctionStateCommitQueue,
  refreshEffectiveFunctions,
} from "../../src/functions/state.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function fixture() {
  const state = createFunctionState();
  const entries: Array<{ type: string; entry: FunctionEntry }> = [];
  const service = new SavedFunctionService({
    state,
    commit: createFunctionStateCommitQueue(),
    appendEntry: (type, entry) => entries.push({ type, entry }),
  });
  return { state, entries, service };
}

describe("SavedFunctionService", () => {
  it("prepares and commits session definitions atomically", async () => {
    const { state, entries, service } = fixture();
    const source = "async function sessionHelper({}) { return 1; }";
    const prepared = service.prepare({
      source,
      context: { cwd: "/tmp", isProjectTrusted: () => true },
    });
    expect(prepared.name).toBe("sessionHelper");
    expect(prepared.scopes.get("sessionHelper")).toBe("session");
    const activity: FunctionActivity[] = [];
    await service.commit(prepared, { cwd: "/tmp" }, activity);
    expect(state.session.get("sessionHelper")).toBe(source);
    expect(state.effective.get("sessionHelper")).toBe(source);
    expect(entries[0]?.entry).toEqual({ name: "sessionHelper", source });
    expect(activity).toEqual([{ action: "set", name: "sessionHelper", replaced: false }]);
  });

  it("validates explicit project preparation and trust", () => {
    const { state, service } = fixture();
    state.projectEnabled = true;
    expect(() =>
      service.prepare({
        source: "async () => true",
        project: true,
        context: { cwd: "/tmp", isProjectTrusted: () => true },
      }),
    ).toThrow("top-level function declaration");
    expect(() =>
      service.prepare({
        source: "/** Documented helper. */ async function documented({}) { return true; }",
        project: true,
        context: { cwd: "/tmp", isProjectTrusted: () => false },
      }),
    ).toThrow("trusted project");
  });

  it("validates and persists trusted project definitions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pit-service-"));
    directories.push(cwd);
    const { state, service } = fixture();
    const source = "/** Project helper. */\nasync function projectHelper({}) { return 2; }";
    expect(() =>
      service.prepare({ source, project: true, context: { cwd, isProjectTrusted: () => true } }),
    ).toThrow("Project functions are disabled");
    state.projectEnabled = true;
    state.session.set("projectHelper", "async function projectHelper({}) { return 1; }");
    const prepared = service.prepare({
      source,

      project: true,
      context: { cwd, isProjectTrusted: () => true },
    });
    expect(prepared.scopes.get("projectHelper")).toBe("project");
    const activity: FunctionActivity[] = [];
    await service.commit(prepared, { cwd }, activity);
    expect(state.project.get("projectHelper")).toBe(source);
    expect(state.session.has("projectHelper")).toBe(false);
    expect(await readFile(join(cwd, ".pi", "functions", "projectHelper.ts"), "utf8")).toBe(
      `${source}\n`,
    );
    expect(activity[0]).toMatchObject({ name: "projectHelper", scope: "project" });
  });

  it("promotes a session definition to a documented project function", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pit-service-"));
    directories.push(cwd);
    const { state, entries, service } = fixture();
    const source = "async function promotedHelper({}) { return 3; }";
    const prepared = service.prepare({
      source,
      context: { cwd, isProjectTrusted: () => true },
    });
    await service.commit(prepared, { cwd }, []);
    state.projectEnabled = true;

    await service.promoteToProject({
      name: "promotedHelper",
      summary: "  Runs the promoted helper.  ",
      context: { cwd, isProjectTrusted: () => true },
    });

    const projectSource = await readFile(
      join(cwd, ".pi", "functions", "promotedHelper.ts"),
      "utf8",
    );
    expect(projectSource).toContain("* Runs the promoted helper.");
    expect(projectSource).not.toContain("@pit");
    expect(projectSource).toContain(source);
    expect(state.project.get("promotedHelper")).toBe(projectSource.trimEnd());
    expect(state.session.has("promotedHelper")).toBe(false);
    expect(entries.at(-1)?.entry).toEqual({ name: "promotedHelper", deleted: true });
  });

  it("rejects invalid session-function promotions", async () => {
    const { state, service } = fixture();
    state.projectEnabled = true;
    state.session.set("summaryRequired", "async function summaryRequired({}) { return true; }");
    await expect(
      service.promoteToProject({
        name: "summaryRequired",
        summary: "  ",
        context: { cwd: "/tmp", isProjectTrusted: () => true },
      }),
    ).rejects.toThrow("summary is required");

    await expect(
      service.promoteToProject({
        name: "missing",
        summary: "Missing helper.",
        context: { cwd: "/tmp", isProjectTrusted: () => true },
      }),
    ).rejects.toThrow('Saved function "missing" was not found');

    state.session.set("wrapped", "((async function wrapped({}) { return true; }))");
    await expect(
      service.promoteToProject({
        name: "wrapped",
        summary: "Wrapped helper.",
        context: { cwd: "/tmp", isProjectTrusted: () => true },
      }),
    ).rejects.toThrow("must be a top-level function declaration");
  });

  it("requires trust and opt-in for project removal", async () => {
    const { state, service } = fixture();
    state.projectEnabled = true;
    expect(() =>
      service.removeFromProject({
        name: "helper",
        context: { cwd: "/tmp", isProjectTrusted: () => false },
      }),
    ).toThrow("require a trusted project");

    state.projectEnabled = false;
    expect(() =>
      service.removeFromProject({
        name: "helper",
        context: { cwd: "/tmp", isProjectTrusted: () => true },
      }),
    ).toThrow("Project functions are disabled");

    const cwd = await mkdtemp(join(tmpdir(), "pit-service-"));
    directories.push(cwd);
    state.projectEnabled = true;
    await expect(
      service.removeFromProject({
        name: "alreadyAbsent",
        context: { cwd, isProjectTrusted: () => true },
      }),
    ).resolves.toBe(false);
  });

  it("plans, guards, and serializes dependency-aware session removals", async () => {
    const { state, entries, service } = fixture();
    state.session.set("baseHelper", "async function baseHelper({}) { return 1; }");
    state.session.set(
      "dependentHelper",
      "async function dependentHelper({ baseHelper }) { return (await baseHelper()) + 1; }",
    );
    state.session.set(
      "transitiveHelper",
      "async function transitiveHelper({ dependentHelper }) { return (await dependentHelper()) + 1; }",
    );
    refreshEffectiveFunctions(state);

    expect(service.planRemoval("baseHelper")).toEqual({
      name: "baseHelper",
      scope: "session",
      directDependents: ["dependentHelper"],
      transitiveDependents: ["transitiveHelper"],
      removalClosure: ["baseHelper", "dependentHelper", "transitiveHelper"],
      requiresCascade: true,
      blocked: false,
    });
    expect(service.planRemoval("baseHelper", "session").removalClosure).toEqual([
      "baseHelper",
      "dependentHelper",
      "transitiveHelper",
    ]);
    expect(() => service.planRemoval("missingHelper")).toThrow(
      'Saved function "missingHelper" was not found',
    );
    expect(() => service.planRemoval("missingHelper", "project")).toThrow(
      'Project function "missingHelper" was not found',
    );
    expect(() => service.planRemoval("missingHelper", "session")).toThrow(
      'Session function "missingHelper" was not found',
    );
    await expect(service.removeSession("baseHelper")).rejects.toThrow("without explicit cascade");
    expect(state.session).toHaveLength(3);
    expect(entries).toEqual([]);

    const first = service.removeSession("baseHelper", { cascade: true });
    const concurrent = service.removeSession("baseHelper", { cascade: true });
    await expect(first).resolves.toEqual(["baseHelper", "dependentHelper", "transitiveHelper"]);
    await expect(concurrent).rejects.toThrow('Session function "baseHelper" was not found');
    expect(state.session).toHaveLength(0);
    expect(entries.map(({ entry }) => entry)).toEqual([
      { name: "baseHelper", deleted: true },
      { name: "dependentHelper", deleted: true },
      { name: "transitiveHelper", deleted: true },
    ]);
  });

  it("validates save-only requests and ignores anonymous commits", async () => {
    const { service } = fixture();
    const context = { cwd: "/tmp", isProjectTrusted: () => true };
    expect(() => service.prepare({ source: "1 + 1", saveOnly: true, context })).toThrow(
      "saveOnly requires",
    );
    expect(() =>
      service.prepare({
        source: "async function helper({}) {}",
        input: {},
        saveOnly: true,
        context,
      }),
    ).toThrow("does not accept top-level params");
    const prepared = service.prepare({ source: "1 + 1", context });
    await expect(service.commit(prepared, { cwd: "/tmp" }, [])).resolves.toBeUndefined();
  });
});
