import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FUNCTION_ENTRY_TYPE } from "../../src/functions/core.js";
import {
  branchEntries,
  cleanupHarness,
  context,
  cwd,
  functionsCommand,
  run,
  sessionStart,
  sessionTree,
  setBranchEntries,
  setupHarness,
  tool,
  value,
} from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

function define(
  code: string,
  functionId: string,
  options: { saveOnly?: boolean; params?: unknown } = {},
) {
  return tool.execute(
    "namespaced-definition",
    { code, functionId, ...options },
    undefined,
    undefined,
    context(),
  );
}

describe("namespaced session definitions", () => {
  it("executes a named definition with input and saves only its full identity", async () => {
    const defined = await define(
      "async function check({}, input: { value: number }) { return input.value * 2; }",
      "company.check",
      { params: { value: 21 } },
    );
    expect(defined.details.value).toBe(42);
    expect(defined.content[0].text).toContain('Saved function "company.check"');
    expect(defined.content[0].text).toContain("Inject { company: { check } }");
    expect(defined.content[0].text).toContain("then call check(input: { value: number })");
    expect(defined.content[0].text).toContain("Session functions: company.check(input:");
    expect(branchEntries.at(-1)).toMatchObject({
      customType: FUNCTION_ENTRY_TYPE,
      data: { name: "company.check" },
    });
    const info = await value("async ({ context: { get } }) => get()");
    expect(info.sessionFunctions).toEqual(["company.check"]);
    await expect(value("async ({ company: { check } }) => check({ value: 3 })")).resolves.toBe(6);
    await expect(value("async ({ check }) => check({ value: 3 })")).rejects.toThrow(
      "does not exist",
    );
    await expect(
      value('async ({ company: { check } }) => check({ value: "wrong" })'),
    ).rejects.toThrow("number");
  });

  it("keeps equal leaf names in separate namespaces and attributes calls by full id", async () => {
    await define(
      "async function check({ context: { get } }) { return (await get()).cwd; }",
      "company.check",
      { saveOnly: true },
    );
    await define('async function check({}) { return "second"; }', "other.check", {
      saveOnly: true,
    });
    const result = await run(
      "async ({ company: { check }, other: { check: second } }) => Promise.all([check(), second()])",
    );
    expect(result.details.value).toEqual([cwd, "second"]);
    expect(result.details.traces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "context",
          function: expect.objectContaining({ name: "company.check", scope: "session" }),
        }),
      ]),
    );
    expect(
      await value('async ({ functions: { getSaved } }) => getSaved("other.check")'),
    ).toMatchObject({ name: "other.check", signature: "other.check()" });
  });

  it("saves without execution and leaves the prior definition intact after a failed replacement", async () => {
    await define('async function check({}) { return "original"; }', "company.check");
    const journalLength = branchEntries.length;
    await expect(
      define(
        'async function check({}) { throw new Error("replacement failed"); }',
        "company.check",
      ),
    ).rejects.toThrow("replacement failed");
    expect(branchEntries).toHaveLength(journalLength);
    await expect(value("async ({ company: { check } }) => check()")).resolves.toBe("original");
    const deferred = await define(
      'async function check({}) { throw new Error("deferred"); }',
      "other.check",
      { saveOnly: true },
    );
    expect(deferred.details.value).toEqual({ savedFunction: "other.check", executed: false });
    await expect(value("async ({ other: { check } }) => check()")).rejects.toThrow(
      'Function "other.check" failed: deferred',
    );
  });

  it.each<{ name: string; source: string; id: string; error: string }>([
    {
      name: "anonymous arrow",
      source: "async ({}) => 1",
      id: "company.check",
      error: "functionId requires a named top-level function",
    },
    {
      name: "anonymous expression",
      source: "async function ({}) { return 1; }",
      id: "company.check",
      error: "functionId requires a named top-level function",
    },
    {
      name: "leaf mismatch",
      source: "async function check({}) { return 1; }",
      id: "company.other",
      error: "must end with the declaration name",
    },
    {
      name: "empty identifier",
      source: "async function check({}) { return 1; }",
      id: "",
      error: "function identifier",
    },
    {
      name: "path traversal",
      source: "async function check({}) { return 1; }",
      id: "../check",
      error: "function identifier",
    },
    {
      name: "prototype-sensitive segment",
      source: "async function check({}) { return 1; }",
      id: "constructor.check",
      error: "function identifier",
    },
    {
      name: "reserved next segment",
      source: "async function check({}) { return 1; }",
      id: "$next.check",
      error: "function identifier",
    },
    {
      name: "private namespace",
      source: "async function check({}) { return 1; }",
      id: "__pit.check",
      error: "function identifier",
    },
    {
      name: "sealed builtin",
      source: "async function promote({}) { return null; }",
      id: "functions.promote",
      error: "sealed",
    },
  ])("rejects $name without writing session history", async ({ source, id, error }) => {
    await expect(define(source, id, { saveOnly: true })).rejects.toThrow(error);
    expect(branchEntries).toEqual([]);
  });

  it("rejects leaf/namespace conflicts before committing", async () => {
    await define("async function check({}) { return 1; }", "company.check", { saveOnly: true });
    const journalLength = branchEntries.length;
    await expect(
      define("async function company({}) { return 1; }", "company", { saveOnly: true }),
    ).rejects.toThrow("namespace conflict");
    expect(branchEntries).toHaveLength(journalLength);
    await expect(value("async ({ company: { check } }) => check()")).resolves.toBe(1);
  });

  it("replays namespaced definitions and tombstones on the active branch", async () => {
    await define("async function check({}) { return 1; }", "company.check", { saveOnly: true });
    const savedBranch = [...branchEntries];
    await sessionStart({}, context());
    await expect(value("async ({ company: { check } }) => check()")).resolves.toBe(1);
    setBranchEntries([]);
    sessionTree({}, context());
    await expect(value("async ({ company: { check } }) => check()")).rejects.toThrow(
      "does not exist",
    );
    setBranchEntries(savedBranch);
    sessionTree({}, context());
    await expect(value("async ({ company: { check } }) => check()")).resolves.toBe(1);
    await value('async ({ functions: { removeSession } }) => removeSession("company.check")');
    expect(branchEntries.at(-1)).toMatchObject({ data: { name: "company.check", deleted: true } });
    await sessionStart({}, context());
    await expect(value("async ({ company: { check } }) => check()")).rejects.toThrow(
      "does not exist",
    );
  });

  it("rejects forged session identities during reconstruction", async () => {
    setBranchEntries([
      {
        type: "custom",
        customType: FUNCTION_ENTRY_TYPE,
        data: { name: "company.wrong", source: "async function check({}) { return 1; }" },
      },
      {
        type: "custom",
        customType: FUNCTION_ENTRY_TYPE,
        data: { name: "company.anonymous", source: "async ({}) => 1" },
      },
      {
        type: "custom",
        customType: FUNCTION_ENTRY_TYPE,
        data: { name: "functions.promote", source: "async function promote({}) { return null; }" },
      },
      {
        type: "custom",
        customType: FUNCTION_ENTRY_TYPE,
        data: { name: "company.valid", source: "async function valid({}) { return 2; }" },
      },
    ]);
    await sessionStart({}, context());
    expect((await value("async ({ context: { get } }) => get()")).sessionFunctions).toEqual([
      "company.valid",
    ]);
  });

  it.each<{ scope: "project" | "user" }>([{ scope: "project" }, { scope: "user" }])(
    "preserves canonical identity when promoting to $scope storage",
    async ({ scope }) => {
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(
        join(cwd, ".pi/pit.json"),
        JSON.stringify({ projectFunctions: { enabled: true } }),
      );
      await sessionStart({}, context());
      await define("async function check({}) { return 42; }", "company.check", { saveOnly: true });
      await expect(
        value(
          `async ({ functions: { promote } }) => promote("company.check", "Canonical check.", { to: "${scope}" })`,
        ),
      ).resolves.toMatchObject({ name: "company.check", scope });
      expect(
        await value('async ({ functions: { getSaved } }) => getSaved("company.check")'),
      ).toMatchObject({ name: "company.check", signature: "company.check()", scope });
      const directory =
        scope === "project" ? join(cwd, ".pi/functions") : join(cwd, "agent/functions");
      expect(await readFile(join(directory, "company/check.ts"), "utf8")).toContain(
        "function check",
      );
      await sessionStart({}, context());
      await expect(value("async ({ company: { check } }) => check()")).resolves.toBe(42);
      expect((await value("async ({ context: { get } }) => get()")).sessionFunctions).toEqual([]);
    },
  );

  it("uses canonical identities in manager inspection and cascade removal", async () => {
    await define("async function base({}) { return 1; }", "company.base", { saveOnly: true });
    await define(
      "async function check({ company: { base } }) { return base(); }",
      "company.check",
      { saveOnly: true },
    );
    const ctx = context({ mode: "tui" });
    await functionsCommand.handler("show company.check", ctx);
    expect(ctx.ui.custom).toHaveBeenCalledOnce();
    await expect(
      value('async ({ functions: { removeSession } }) => removeSession("company.base")'),
    ).rejects.toThrow("cascade");
    await expect(
      value(
        'async ({ functions: { removeSession } }) => removeSession("company.base", { cascade: true })',
      ),
    ).resolves.toMatchObject({ removed: ["company.base", "company.check"] });
  });
});
