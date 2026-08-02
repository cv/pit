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
        { name: "capabilityProject", scope: "project", signature: "capabilityProject()" },
        { name: "capabilitySession", scope: "session", signature: "capabilitySession()" },
        { name: "removableDependent", scope: "session" },
        { name: "removableSession", scope: "session" },
      ],
      session: { name: "capabilitySession", scope: "session" },
      project: { name: "capabilityProject", scope: "project" },
    });

    await expect(
      value(
        `async ({ functions }) => functions.promote("capabilitySession", "Promoted through the capability.")`,
      ),
    ).resolves.toEqual({ name: "capabilitySession", promoted: true });
    await expect(
      readFile(join(cwd, ".pi/pit/functions/capabilitySession.ts"), "utf8"),
    ).resolves.toContain("Promoted through the capability.");

    await expect(
      value(`async ({ functions }) => functions.removeSession("removableSession")`),
    ).resolves.toEqual({
      name: "removableSession",
      removed: ["removableDependent", "removableSession"],
    });
    expect(await value("async ({ context }) => context.get()")).toMatchObject({
      projectFunctions: ["capabilityProject", "capabilitySession"],
      sessionFunctions: [],
    });
  }, 15_000);

  it("rejects unavailable and unknown operations", async () => {
    await expect(run(`async ({ functions }) => functions.get("missing")`)).rejects.toThrow(
      "is unavailable",
    );
    await expect(run(`async ({ functions }) => functions.getSaved("missing")`)).rejects.toThrow(
      "is unavailable",
    );
    await expect(
      run(`async ({ functions }) => functions.removeSession("missing")`),
    ).rejects.toThrow("was not found");
    await expect(
      run(`async ({ functions }) => (functions as any).unknown("value")`),
    ).rejects.toThrow("Unknown capability or method: functions.unknown");
  });
});
