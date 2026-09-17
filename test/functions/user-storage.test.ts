import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SavedFunctionService } from "../../src/functions/service.js";
import { createFunctionState, createFunctionStateCommitQueue } from "../../src/functions/state.js";
import {
  userFunctionDirectory,
  userFunctionPath,
  loadUserFunctions,
  removeUserFunction,
  saveUserFunction,
} from "../../src/functions/storage/user.js";
import { assertFunctionsAvailable } from "../../src/functions/storage/validation.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pit-user-functions-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("user function storage", () => {
  it("saves, replaces, and removes user source files", async () => {
    const registry = new Map<string, string>();
    const first = "/** Stored user. */ async function storedUser({}) { return 1; }";
    const second = "/** Stored user two. */ async function storedUser({}) { return 2; }\n";

    await expect(saveUserFunction("storedUser", first, registry)).resolves.toBe(false);
    await expect(readFile(join(userFunctionDirectory(), "storedUser.ts"), "utf8")).resolves.toBe(
      `${first}\n`,
    );
    await expect(saveUserFunction("storedUser", second, registry)).resolves.toBe(true);
    await expect(readFile(join(userFunctionDirectory(), "storedUser.ts"), "utf8")).resolves.toBe(
      second,
    );
    await expect(removeUserFunction("storedUser")).resolves.toBe(true);
    await expect(removeUserFunction("storedUser")).resolves.toBe(false);
  });

  it("loads valid user dependencies and reports malformed candidates", async () => {
    const directory = userFunctionDirectory();
    await mkdir(join(directory, "ignored-directory"), { recursive: true });
    await writeFile(join(directory, "ignored.txt"), "ignored");
    await writeFile(
      join(directory, "userBase.ts"),
      "/** User base. @pit user */ async function userBase({}) { return 1; }",
    );
    await writeFile(
      join(directory, "userDependent.ts"),
      "/** User dependent. */ async function userDependent({ userBase }) { return userBase(); }",
    );
    await writeFile(join(directory, "missingMarker.ts"), "async function missingMarker({}) {};");
    await writeFile(
      join(directory, "wrongName.ts"),
      "/** Wrong name. */ async function actualName({}) { return true; }",
    );
    await writeFile(
      join(directory, "missingDependency.ts"),
      "/** Missing dependency. */ async function missingDependency({ absentUser }) { return absentUser(); }",
    );

    const registry = new Map<string, string>();
    const metadata = new Map();
    const errors = await loadUserFunctions(registry, metadata);
    expect([...registry.keys()].sort()).toEqual(["userBase", "userDependent"]);
    expect([...metadata.keys()].sort()).toEqual(["userBase", "userDependent"]);
    expect(errors.join("\n")).toContain("expected one documented top-level function declaration");
    expect(errors.join("\n")).toContain("filename must be actualName.ts");
    expect(errors.join("\n")).toContain("absentUser");
  });

  it("rejects saves that exceed user registry capacity", async () => {
    const registry = new Map(
      Array.from({ length: 64 }, (_, index) => [
        `user${index}`,
        `async function user${index}({}) { return ${index}; }`,
      ]),
    );
    await expect(
      saveUserFunction(
        "overflowUser",
        "/** Overflow. */ async function overflowUser({}) { return true; }",
        registry,
      ),
    ).rejects.toThrow("limited to 64 functions");
  });

  it("guards direct user service operations", async () => {
    const state = createFunctionState();
    const service = new SavedFunctionService({
      state,
      commit: createFunctionStateCommitQueue(),
      appendEntry: () => undefined,
    });
    const request = {
      name: "missingUser",
      summary: "Missing user.",
      context: { cwd: root, isProjectTrusted: () => true },
    };
    await expect(service.promoteToUser(request)).rejects.toThrow(
      'Session function "missingUser" was not found',
    );
    state.session.set("notDeclaration", "async () => true");
    await expect(service.promoteToUser({ ...request, name: "notDeclaration" })).rejects.toThrow(
      "must be a top-level function declaration",
    );
    await expect(service.removeFromUser("missingUser")).rejects.toThrow(
      'User function "missingUser" was not found',
    );
  });

  it("uses only the active agent directory and leaves legacy files untouched", async () => {
    const legacy = join(root, "pit", "functions");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "old.ts"), "legacy content");
    const registry = new Map<string, string>();
    expect(userFunctionDirectory()).toBe(join(root, "functions"));
    expect(await loadUserFunctions(registry, new Map())).toEqual([]);
    expect(registry.size).toBe(0);
    await expect(readFile(join(root, "functions"))).rejects.toMatchObject({ code: "ENOENT" });
    const source = "/** Current. */ async function old({}) { return 1; }";
    await saveUserFunction("old", source, registry);
    await removeUserFunction("old");
    expect(await readFile(join(legacy, "old.ts"), "utf8")).toBe("legacy content");
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "another-agent"));
    expect(userFunctionDirectory()).toBe(join(root, "another-agent", "functions"));
  });

  it("loads namespaced files with path-derived metadata and dependencies", async () => {
    const sources = new Map<string, string>();
    await saveUserFunction(
      "company.base",
      "/** Base. */ async function base({}) { return 42; }",
      sources,
    );
    await saveUserFunction(
      "company.answer",
      "/** Answer. */ async function answer({ company: { base } }) { return base(); }",
      sources,
    );
    expect(userFunctionPath("company.answer")).toBe(
      join(root, "functions", "company", "answer.ts"),
    );
    const registry = new Map<string, string>();
    const metadata = new Map();
    expect(await loadUserFunctions(registry, metadata)).toEqual([]);
    expect([...registry.keys()].sort()).toEqual(["company.answer", "company.base"]);
    expect(metadata.get("company.answer")).toMatchObject({
      name: "company.answer",
      signature: "company.answer()",
    });
  });

  it.each([
    {
      name: "alternate dotted filename",
      file: "workspace.read.ts",
      source: "/** Read. */ async function read({}) { return true; }",
      error: "canonical directories",
    },
    {
      name: "declaration mismatch",
      file: "company/answer.ts",
      source: "/** Wrong. */ async function other({}) { return true; }",
      error: "filename must be other.ts",
    },
    {
      name: "oversized source",
      file: "big.ts",
      source: "x".repeat(100_001),
      error: "source exceeds",
    },
    {
      name: "namespace capture",
      file: "bad.ts",
      source: "/** Bad. */ async function bad({ workspace }) { return workspace.read('a'); }",
      error: "unavailable function",
    },
  ])("rejects $name and retains its diagnostic", async ({ file, source, error }) => {
    const directory = join(root, "functions");
    await mkdir(join(directory, "company"), { recursive: true });
    await writeFile(join(directory, file), source);
    const invalid = new Map<string, string>();
    const registry = new Map<string, string>();
    expect((await loadUserFunctions(registry, new Map(), invalid)).join("\n")).toContain(error);
    expect(registry.size).toBe(0);
    expect(invalid.size).toBe(1);
  });

  it("rejects case and namespace collisions without a discovery-order winner", async () => {
    const directory = userFunctionDirectory();
    await mkdir(join(directory, "thing"), { recursive: true });
    await writeFile(join(directory, "Thing.ts"), "/** Upper. */ async function Thing({}) {} ");
    await writeFile(join(directory, "thing.ts"), "/** Lower. */ async function thing({}) {} ");
    await writeFile(
      join(directory, "thing", "child.ts"),
      "/** Child. */ async function child({}) {} ",
    );
    const invalid = new Map<string, string>();
    const registry = new Map<string, string>();
    expect((await loadUserFunctions(registry, new Map(), invalid)).length).toBeGreaterThan(0);
    expect(registry.size).toBe(0);
    expect([...invalid.keys()].sort()).toEqual(["Thing", "thing", "thing.child"]);
  });

  it("does not read or mutate symlinked definitions and subdirectories", async () => {
    const directory = userFunctionDirectory();
    await mkdir(directory, { recursive: true });
    const outside = join(root, "external.ts");
    const original = "/** Outside. */ async function linked({}) { return 1; }";
    await writeFile(outside, original);
    await symlink(outside, join(directory, "linked.ts"));
    await symlink(root, join(directory, "external"), "dir");
    const registry = new Map<string, string>();
    expect((await loadUserFunctions(registry, new Map())).join("\n")).toContain("symlinks");
    expect(registry.size).toBe(0);
    await expect(saveUserFunction("linked", original, registry)).rejects.toThrow("symlinks");
    await expect(removeUserFunction("linked")).rejects.toThrow("symlinks");
    await expect(saveUserFunction("external.linked", original, registry)).rejects.toThrow(
      "symlinks",
    );
    expect(await readFile(outside, "utf8")).toBe(original);
  });

  it.each([
    {
      name: "missing declaration",
      id: "value",
      source: "({}) => 1",
      error: "declaration must match",
    },
    {
      name: "wrong declaration",
      id: "value",
      source: "/** Value. */ async function wrong({}) {}",
      error: "declaration must match",
    },
    {
      name: "Windows reserved filename",
      id: "company.CON",
      source: "/** Value. */ async function CON({}) {}",
      error: "reserved filesystem name",
    },
  ])("rejects writes with $name", async ({ id, source, error }) => {
    await expect(saveUserFunction(id, source, new Map())).rejects.toThrow(error);
  });

  it("rejects case-only duplicates before writing", async () => {
    const registry = new Map<string, string>();
    await saveUserFunction("Helper", "/** Helper. */ async function Helper({}) {}", registry);
    await expect(
      saveUserFunction("helper", "/** Helper. */ async function helper({}) {}", registry),
    ).rejects.toThrow("case-insensitive function collision");
  });

  it("ignores hidden and declaration files while surfacing root errors", async () => {
    const directory = userFunctionDirectory();
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, ".ignored.ts"), "invalid");
    await writeFile(join(directory, "ignored.d.ts"), "invalid");
    expect(await loadUserFunctions(new Map(), new Map())).toEqual([]);
    await writeFile(join(root, "not-directory"), "x");
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "not-directory"));
    await expect(loadUserFunctions(new Map(), new Map())).rejects.toThrow();
  });

  it.each([
    { name: "entry", count: 2049, extension: "txt", source: "", error: "entry limit" },
    {
      name: "aggregate source",
      count: 41,
      extension: "ts",
      source: "/** Size. */ async function value({}) { /*" + "x".repeat(98_000) + "*/ }",
      error: "source byte limit",
    },
  ])("bounds $name discovery", async ({ count, extension, source, error }) => {
    const directory = userFunctionDirectory();
    await mkdir(directory, { recursive: true });
    for (let index = 0; index < count; index += 64) {
      await Promise.all(
        Array.from({ length: Math.min(64, count - index) }, (_, offset) =>
          writeFile(join(directory, `value${index + offset}.${extension}`), source),
        ),
      );
    }
    await expect(loadUserFunctions(new Map(), new Map())).rejects.toThrow(error);
  });

  it("removes a dependent when its required user definition exceeds capacity", async () => {
    const directory = userFunctionDirectory();
    await mkdir(directory, { recursive: true });
    const sizedSource = (name: string, dependency?: string): string => {
      const prefix = `/** Quota fixture. */ async function ${name}({ ${dependency ?? ""} }) { /*`;
      const suffix = `*/ return ${dependency ? `${dependency}()` : "1"}; }`;
      return prefix + "x".repeat(99_000 - Buffer.byteLength(prefix + suffix)) + suffix;
    };
    await writeFile(join(directory, "aConsumer.ts"), sizedSource("aConsumer", "zBase"));
    await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        writeFile(join(directory, `b${index}.ts`), sizedSource(`b${index}`)),
      ),
    );
    await writeFile(join(directory, "zBase.ts"), sizedSource("zBase"));
    const registry = new Map<string, string>();
    const invalid = new Map<string, string>();
    await loadUserFunctions(registry, new Map(), invalid);
    expect(registry.has("aConsumer")).toBe(false);
    expect(invalid.has("aConsumer")).toBe(true);
    expect(invalid.get("zBase")).toContain("total source");
  });

  it("keeps global definitions immutable and permits removal of invalid definitions", () => {
    const state = createFunctionState();
    state.invalidProject.set("bad", "Invalid source");
    const service = new SavedFunctionService({
      state,
      commit: createFunctionStateCommitQueue(),
      appendEntry: () => undefined,
    });
    expect(() => service.planRemoval("workspace.read", "global")).toThrow(
      "Global functions are immutable",
    );
    expect(service.planRemoval("bad")).toMatchObject({ scope: "project", blocked: false });
  });

  it("checks shared dependency closures once and isolates unrelated invalid source", () => {
    const sources = new Map([
      ["left", "async function left({ common }) { return common(); }"],
      ["right", "async function right({ common }) { return common(); }"],
      ["common", "async function common({ context: { get } }) { return get(); }"],
    ]);
    expect(() =>
      assertFunctionsAvailable(
        "async ({ left, right }) => Promise.all([left(), right()])",
        sources,
        new Map([["unrelated", "invalid"]]),
      ),
    ).not.toThrow();
  });
});
