import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SavedFunctionService } from "../../src/functions/service.js";
import { createFunctionState, createFunctionStateCommitQueue } from "../../src/functions/state.js";
import {
  globalFunctionConfigPath,
  globalFunctionDirectory,
  loadGlobalFunctionConfig,
  loadGlobalFunctions,
  removeGlobalFunction,
  saveGlobalFunction,
} from "../../src/functions/storage/global.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pit-global-functions-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function writeConfig(value: unknown): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(globalFunctionConfigPath(), JSON.stringify(value));
}

describe("global function storage", () => {
  it.each([
    { name: "missing section", value: {}, enabled: false, error: false },
    { name: "missing enabled", value: { globalFunctions: {} }, enabled: false, error: false },
    { name: "enabled", value: { globalFunctions: { enabled: true } }, enabled: true, error: false },
    { name: "invalid root", value: [], enabled: false, error: true },
    { name: "invalid section", value: { globalFunctions: [] }, enabled: false, error: true },
    {
      name: "invalid enabled",
      value: { globalFunctions: { enabled: "yes" } },
      enabled: false,
      error: true,
    },
  ])("reads $name configuration", async ({ value, enabled, error }) => {
    await writeConfig(value);
    const config = await loadGlobalFunctionConfig();
    expect(config.enabled).toBe(enabled);
    expect(Boolean(config.error)).toBe(error);
  });

  it("returns disabled configuration when the file is absent", async () => {
    await expect(loadGlobalFunctionConfig()).resolves.toEqual({ enabled: false });
  });

  it("saves, replaces, and removes global source files", async () => {
    const registry = new Map<string, string>();
    const first = "/** Stored global. */ async function storedGlobal() { return 1; }";
    const second = "/** Stored global two. */ async function storedGlobal() { return 2; }\n";

    await expect(saveGlobalFunction("storedGlobal", first, registry)).resolves.toBe(false);
    await expect(
      readFile(join(globalFunctionDirectory(), "storedGlobal.ts"), "utf8"),
    ).resolves.toBe(`${first}\n`);
    await expect(saveGlobalFunction("storedGlobal", second, registry)).resolves.toBe(true);
    await expect(
      readFile(join(globalFunctionDirectory(), "storedGlobal.ts"), "utf8"),
    ).resolves.toBe(second);
    await expect(removeGlobalFunction("storedGlobal")).resolves.toBe(true);
    await expect(removeGlobalFunction("storedGlobal")).resolves.toBe(false);
  });

  it("loads valid global dependencies and reports malformed candidates", async () => {
    const directory = globalFunctionDirectory();
    await mkdir(join(directory, "ignored-directory"), { recursive: true });
    await writeFile(join(directory, "ignored.txt"), "ignored");
    await writeFile(
      join(directory, "globalBase.ts"),
      "/** Global base. @pit global */ async function globalBase() { return 1; }",
    );
    await writeFile(
      join(directory, "globalDependent.ts"),
      "/** Global dependent. */ async function globalDependent() { return globalBase(); }",
    );
    await writeFile(join(directory, "missingMarker.ts"), "async function missingMarker() {};");
    await writeFile(
      join(directory, "wrongName.ts"),
      "/** Wrong name. */ async function actualName() { return true; }",
    );
    await writeFile(
      join(directory, "missingDependency.ts"),
      "/** Missing dependency. */ async function missingDependency() { return absentGlobal(); }",
    );

    const registry = new Map<string, string>();
    const metadata = new Map();
    const errors = await loadGlobalFunctions(registry, metadata);
    expect([...registry.keys()].sort()).toEqual(["globalBase", "globalDependent"]);
    expect([...metadata.keys()].sort()).toEqual(["globalBase", "globalDependent"]);
    expect(errors.join("\n")).toContain("expected one documented top-level function declaration");
    expect(errors.join("\n")).toContain("filename must be actualName.ts");
    expect(errors.join("\n")).toContain("absentGlobal");
  });

  it("rejects saves that exceed global registry capacity", async () => {
    const registry = new Map(
      Array.from({ length: 64 }, (_, index) => [
        `global${index}`,
        `async function global${index}() { return ${index}; }`,
      ]),
    );
    await expect(
      saveGlobalFunction(
        "overflowGlobal",
        "/** Overflow. */ async function overflowGlobal() { return true; }",
        registry,
      ),
    ).rejects.toThrow("limited to 64 functions");
  });

  it("guards direct global service operations", async () => {
    const state = createFunctionState();
    const service = new SavedFunctionService({
      state,
      commit: createFunctionStateCommitQueue(),
      appendEntry: () => undefined,
    });
    const request = {
      name: "missingGlobal",
      summary: "Missing global.",
      context: { cwd: root, isProjectTrusted: () => true },
    };
    await expect(service.promoteToGlobal(request)).rejects.toThrow("Global functions are disabled");
    expect(() => service.removeFromGlobal("missingGlobal")).toThrow(
      "Global functions are disabled",
    );

    state.globalEnabled = true;
    await expect(service.promoteToGlobal(request)).rejects.toThrow(
      'Session function "missingGlobal" was not found',
    );
    state.session.set("notDeclaration", "async () => true");
    await expect(service.promoteToGlobal({ ...request, name: "notDeclaration" })).rejects.toThrow(
      "must be a top-level function declaration",
    );
    await expect(service.removeFromGlobal("missingGlobal")).rejects.toThrow(
      'Global function "missingGlobal" was not found',
    );
  });
});
