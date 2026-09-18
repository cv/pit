import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  branchEntries,
  cleanupHarness,
  context,
  cwd,
  sessionStart,
  setupHarness,
  tool,
  value,
} from "../support/extension-fixture.js";

const base = "async function calculate({}, value: number): Promise<number> { return value + 1; }";
const project =
  "async function calculate({ $next }, value: number) { return (await $next(value)) * 2; }";
const session =
  "async function calculate({ $next }, value: number) { return (await $next(value)) + 3; }";

async function persist(scope: "user" | "project", id: string, source: string): Promise<string> {
  const directory = scope === "user" ? join(cwd, "agent/functions") : join(cwd, ".pi/functions");
  const file = join(directory, ...id.split(".")) + ".ts";
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `/** ${id} override fixture. */\n${source}`);
  return file;
}

function define(code: string, functionId = "company.calculate", params?: unknown) {
  return tool.execute(
    "override-definition",
    { code, functionId, ...(params === undefined ? { saveOnly: true } : { params }) },
    undefined,
    undefined,
    context(),
  );
}

beforeEach(async () => {
  await setupHarness();
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi/pit.json"),
    JSON.stringify({ projectFunctions: { enabled: true } }),
  );
});
afterEach(cleanupHarness);

describe("persistent override chains", () => {
  it("executes a named session next chain and reconstructs it after reload", async () => {
    await persist("user", "company.calculate", base);
    await persist("project", "company.calculate", project);
    await sessionStart({}, context());
    const first = await define(session, "company.calculate", 4);
    expect(first.details.value).toBe(13);
    await expect(value("async ({ company: { calculate } }) => calculate(4)")).resolves.toBe(13);
    await sessionStart({}, context());
    await expect(value("async ({ company: { calculate } }) => calculate(4)")).resolves.toBe(13);
  });

  it("rebinds next relative to the destination when promoted to project", async () => {
    await persist("user", "company.calculate", base);
    const file = await persist("project", "company.calculate", project);
    await sessionStart({}, context());
    await define(session);
    await expect(value("async ({ company: { calculate } }) => calculate(4)")).resolves.toBe(13);
    await value(
      'async ({ functions: { promote } }) => promote("company.calculate", "Promoted decorator.")',
    );
    expect(await readFile(file, "utf8")).toContain("$next");
    await expect(value("async ({ company: { calculate } }) => calculate(4)")).resolves.toBe(8);
    await sessionStart({}, context());
    await expect(value("async ({ company: { calculate } }) => calculate(4)")).resolves.toBe(8);
    expect((await value("async ({ context: { get } }) => get()")).sessionFunctions).toEqual([]);
  });

  it("does not overwrite a user file when promotion loses its next target", async () => {
    const file = await persist("user", "company.calculate", base);
    const original = await readFile(file, "utf8");
    await sessionStart({}, context());
    await define(session);
    const entries = branchEntries.length;
    await expect(
      value(
        'async ({ functions: { promote } }) => promote("company.calculate", "Not portable.", { to: "user" })',
      ),
    ).rejects.toThrow("without a lower definition");
    expect(await readFile(file, "utf8")).toBe(original);
    expect(branchEntries).toHaveLength(entries);
    await expect(value("async ({ company: { calculate } }) => calculate(4)")).resolves.toBe(8);
  });

  it("promotes and reloads a user decorator of a native global", async () => {
    await sessionStart({}, context());
    const source =
      'async function get({ $next: original }) { const result = await original(); return { ...result, cwd: result.cwd + "/decorated" }; }';
    await define(source, "context.get");
    await value(
      'async ({ functions: { promote } }) => promote("context.get", "Decorate context.", { to: "user" })',
    );
    await sessionStart({}, context());
    await expect(value("async ({ context: { get } }) => (await get()).cwd")).resolves.toBe(
      cwd + "/decorated",
    );
  });

  it("keeps invalid persistent overrides unavailable instead of revealing the lower implementation", async () => {
    await persist("user", "company.calculate", base);
    await persist(
      "project",
      "company.calculate",
      "async function calculate({}, value: number): Promise<string> { return String(value); }",
    );
    const ctx = context();
    await sessionStart({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Override company.calculate"),
      "warning",
    );
    await expect(value("async ({ company: { calculate } }) => calculate(4)")).rejects.toThrow(
      'Function "company.calculate" is unavailable',
    );
    await expect(value("async ({}) => 42")).resolves.toBe(42);
  });

  it.each<{ name: string; source: string }>([
    {
      name: "narrower input",
      source: "async function calculate({}, value: 1): Promise<number> { return value; }",
    },
    {
      name: "incompatible result",
      source:
        "async function calculate({}, value: number): Promise<string> { return String(value); }",
    },
  ])("rejects $name before changing session state", async ({ source }) => {
    await persist("user", "company.calculate", base);
    await sessionStart({}, context());
    const entries = branchEntries.length;
    await expect(define(source)).rejects.toThrow("TypeScript validation failed");
    expect(branchEntries).toHaveLength(entries);
    await expect(value("async ({ company: { calculate } }) => calculate(4)")).resolves.toBe(5);
  });

  it("allows compatible fallback but blocks removing the last next target", async () => {
    const userFile = await persist("user", "company.calculate", base);
    await persist("project", "company.calculate", project);
    await sessionStart({}, context());
    await define(session);
    await expect(
      value(
        'async ({ functions: { planRemoval } }) => planRemoval("company.calculate", "project")',
      ),
    ).resolves.toMatchObject({ blocked: false });
    await value('async ({ functions: { remove } }) => remove("company.calculate")');
    await expect(value("async ({ company: { calculate } }) => calculate(4)")).resolves.toBe(8);
    await expect(
      value('async ({ functions: { planRemoval } }) => planRemoval("company.calculate", "user")'),
    ).resolves.toMatchObject({ blocked: true });
    await expect(
      value('async ({ functions: { removeUser } }) => removeUser("company.calculate")'),
    ).rejects.toThrow("dependent saved functions remain");
    expect(await readFile(userFile, "utf8")).toContain("function calculate");
  });
});
