import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFunctionState, createFunctionStateCommitQueue } from "../src/function-state.js";
import { SavedFunctionService } from "../src/saved-function-service.js";
import type { FunctionActivity, FunctionEntry } from "../src/saved-functions.js";

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
    const source = "async function sessionHelper() { return 1; }";
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

  it("validates and persists trusted project definitions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pit-service-"));
    directories.push(cwd);
    const { state, service } = fixture();
    const source =
      "/** Project helper.\n * @pit project\n */\nasync function projectHelper() { return 2; }";
    expect(() =>
      service.prepare({ source, context: { cwd, isProjectTrusted: () => true } }),
    ).toThrow("Project functions are disabled");
    state.projectEnabled = true;
    state.session.set("projectHelper", "async function projectHelper() { return 1; }");
    const prepared = service.prepare({
      source,
      context: { cwd, isProjectTrusted: () => true },
    });
    expect(prepared.scopes.get("projectHelper")).toBe("project");
    const activity: FunctionActivity[] = [];
    await service.commit(prepared, { cwd }, activity);
    expect(state.project.get("projectHelper")).toBe(source);
    expect(state.session.has("projectHelper")).toBe(false);
    expect(await readFile(join(cwd, ".pi", "pit", "functions", "projectHelper.ts"), "utf8")).toBe(
      `${source}\n`,
    );
    expect(activity[0]).toMatchObject({ name: "projectHelper", scope: "project" });
  });

  it("promotes a session definition to a documented project function", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pit-service-"));
    directories.push(cwd);
    const { state, entries, service } = fixture();
    const source = "async function promotedHelper() { return 3; }";
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
      join(cwd, ".pi", "pit", "functions", "promotedHelper.ts"),
      "utf8",
    );
    expect(projectSource).toContain("* Runs the promoted helper.");
    expect(projectSource).toContain("* @pit project");
    expect(projectSource).toContain(source);
    expect(state.project.get("promotedHelper")).toBe(projectSource.trimEnd());
    expect(state.session.has("promotedHelper")).toBe(false);
    expect(entries.at(-1)?.entry).toEqual({ name: "promotedHelper", deleted: true });
  });

  it("rejects invalid session-function promotions", async () => {
    const { state, service } = fixture();
    state.projectEnabled = true;
    state.session.set("summaryRequired", "async function summaryRequired() { return true; }");
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

    state.session.set("wrapped", "((async function wrapped() { return true; }))");
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

  it("validates save-only requests and ignores anonymous commits", async () => {
    const { service } = fixture();
    const context = { cwd: "/tmp", isProjectTrusted: () => true };
    expect(() => service.prepare({ source: "1 + 1", saveOnly: true, context })).toThrow(
      "saveOnly requires",
    );
    expect(() =>
      service.prepare({
        source: "async function helper() {}",
        input: {},
        saveOnly: true,
        context,
      }),
    ).toThrow("does not accept top-level params");
    const prepared = service.prepare({ source: "1 + 1", context });
    await expect(service.commit(prepared, { cwd: "/tmp" }, [])).resolves.toBeUndefined();
  });
});
