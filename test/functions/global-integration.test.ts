import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  beforeAgentStart,
  cleanupHarness,
  context,
  cwd,
  functionsCommand,
  run,
  sessionStart,
  setupHarness,
  value,
} from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

function agentDir(): string {
  return join(cwd, "agent");
}

async function enableGlobalFunctions(): Promise<void> {
  await mkdir(agentDir(), { recursive: true });
  await writeFile(
    join(agentDir(), "pit.json"),
    JSON.stringify({ globalFunctions: { enabled: true } }),
  );
}

async function writeGlobalFunction(name: string, source: string): Promise<void> {
  const directory = join(agentDir(), "pit", "functions");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.ts`), source);
}

async function enableProjectFunctions(globalEnabled?: boolean): Promise<void> {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "pit.json"),
    JSON.stringify({
      projectFunctions: { enabled: true },
      ...(globalEnabled === undefined ? {} : { globalFunctions: { enabled: globalEnabled } }),
    }),
  );
}

async function writeProjectFunction(name: string, source: string): Promise<void> {
  const directory = join(cwd, ".pi", "pit", "functions");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.ts`), source);
}

describe("global functions", () => {
  it("loads globals, supports project dependencies, and applies scope precedence", async () => {
    await enableGlobalFunctions();
    await writeGlobalFunction(
      "sharedValue",
      '/** Shared global value. @pit global */ async function sharedValue() { return "global"; }',
    );
    await writeGlobalFunction(
      "globalConsumer",
      "/** Global consumer. @pit global */ async function globalConsumer() { return sharedValue(); }",
    );
    await enableProjectFunctions();
    await writeProjectFunction(
      "projectConsumer",
      "/** Project consumer. @pit project */ async function projectConsumer() { return sharedValue(); }",
    );
    await sessionStart({}, context());

    await expect(value("sharedValue()")).resolves.toBe("global");
    await expect(value("globalConsumer()")).resolves.toBe("global");
    await expect(value("projectConsumer()")).resolves.toBe("global");
    const initial = await value("async ({ context }) => context.get()");
    expect(initial).toMatchObject({
      globalFunctionsEnabled: true,
      globalFunctions: ["globalConsumer", "sharedValue"],
      projectFunctions: ["projectConsumer"],
    });

    await writeProjectFunction(
      "sharedValue",
      '/** Project override. @pit project */ async function sharedValue() { return "project"; }',
    );
    await sessionStart({}, context());
    await expect(value("sharedValue()")).resolves.toBe("project");
    await expect(value("globalConsumer()")).resolves.toBe("global");
    await expect(value("projectConsumer()")).resolves.toBe("project");
    await run('async function sharedValue() { return "session"; }');
    await expect(value("sharedValue()")).resolves.toBe("session");
    await expect(value("globalConsumer()")).resolves.toBe("global");
    await expect(value("projectConsumer()")).resolves.toBe("project");
    const metadata = await value('async ({ functions }) => functions.getSaved("sharedValue")');
    expect(metadata).toMatchObject({
      scope: "session",
      overridesGlobal: true,
      overridesProject: true,
    });
    const global = await value(
      'async ({ functions }) => functions.getSaved("sharedValue", "global")',
    );
    expect(global).toMatchObject({ scope: "global", overridesGlobal: false });
  }, 15_000);

  it("honors a trusted project opt-out", async () => {
    await enableGlobalFunctions();
    await writeGlobalFunction(
      "hiddenGlobal",
      "/** Hidden global. @pit global */ async function hiddenGlobal() { return true; }",
    );
    await enableProjectFunctions(false);
    await sessionStart({}, context());

    const info = await value("async ({ context }) => context.get()");
    expect(info).toMatchObject({ globalFunctionsEnabled: false, globalFunctions: [] });
    await expect(value("hiddenGlobal()")).rejects.toThrow("Cannot find name 'hiddenGlobal'");
    await expect(value("async ({ functions }) => functions.listGlobal()")).rejects.toThrow(
      "Global functions are disabled",
    );
  });

  it("promotes and removes a global function with confirmation", async () => {
    await enableGlobalFunctions();
    await sessionStart({}, context());
    await run("async function portableHelper() { return { portable: true }; }");

    await expect(
      value(
        'async ({ functions }) => functions.promote("portableHelper", "Portable helper.", { to: "global" })',
      ),
    ).resolves.toEqual({ name: "portableHelper", promoted: true, scope: "global" });
    await expect(
      readFile(join(agentDir(), "pit", "functions", "portableHelper.ts"), "utf8"),
    ).resolves.toContain("@pit global");
    const info = await value("async ({ context }) => context.get()");
    expect(info.globalFunctions).toContain("portableHelper");
    expect(info.sessionFunctions).not.toContain("portableHelper");

    await expect(
      value('async ({ functions }) => functions.removeGlobal("portableHelper")'),
    ).resolves.toEqual({ name: "portableHelper", removed: true });
    await expect(
      readFile(join(agentDir(), "pit", "functions", "portableHelper.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks promotion while non-global dependencies remain", async () => {
    await enableGlobalFunctions();
    await sessionStart({}, context());
    await run("async function localBase() { return 1; }");
    await run("async function dependentPortable() { return localBase(); }");

    await expect(
      value(
        'async ({ functions }) => functions.promote("dependentPortable", "Dependent helper.", { to: "global" })',
      ),
    ).rejects.toThrow("non-global dependencies remain: localBase");
  });

  it("advertises globals and manages them interactively", async () => {
    await enableGlobalFunctions();
    await writeGlobalFunction(
      "catalogGlobal",
      "/** Catalog global. @pit global */ async function catalogGlobal() { return true; }",
    );
    await sessionStart({}, context());
    const prompt = beforeAgentStart({ systemPrompt: "base" });
    expect(prompt.systemPrompt).toContain("## Global TypeScript functions");
    expect(prompt.systemPrompt).toContain("catalogGlobal()");

    const inspectContext = context({ mode: "tui" });
    inspectContext.ui.select
      .mockImplementationOnce(async (_title, options) =>
        options.find((option) => option.startsWith("catalogGlobal [global]")),
      )
      .mockResolvedValueOnce("Inspect source")
      .mockResolvedValueOnce(undefined);
    await functionsCommand.handler("", inspectContext);
    expect(inspectContext.ui.custom).toHaveBeenCalledOnce();

    await run("async function managerGlobal() { return true; }");
    const saveContext = context({ mode: "tui" });
    saveContext.ui.input.mockResolvedValueOnce("Manager global helper.");
    saveContext.ui.select
      .mockImplementationOnce(async (_title, options) =>
        options.find((option) => option.startsWith("managerGlobal [session]")),
      )
      .mockResolvedValueOnce("Save globally")
      .mockResolvedValueOnce(undefined);
    await functionsCommand.handler("", saveContext);
    expect(saveContext.ui.notify.mock.calls).toContainEqual([
      "Saved function globally: managerGlobal",
      "info",
    ]);
    await expect(
      readFile(join(agentDir(), "pit", "functions", "managerGlobal.ts"), "utf8"),
    ).resolves.toContain("@pit global");

    const removeContext = context({ mode: "tui" });
    removeContext.ui.select
      .mockImplementationOnce(async (_title, options) =>
        options.find((option) => option.startsWith("managerGlobal [global]")),
      )
      .mockResolvedValueOnce("Remove globally")
      .mockResolvedValueOnce(undefined);
    await functionsCommand.handler("", removeContext);
    await expect(
      readFile(join(agentDir(), "pit", "functions", "managerGlobal.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates global capability options and interactive confirmation", async () => {
    await enableGlobalFunctions();
    await writeGlobalFunction(
      "confirmedGlobal",
      "/** Confirmed global. @pit global */ async function confirmedGlobal() { return true; }",
    );
    await sessionStart({}, context());

    await expect(value("async ({ functions }) => functions.listGlobal()")).resolves.toEqual([
      expect.objectContaining({ name: "confirmedGlobal" }),
    ]);
    await expect(
      value('async ({ functions }) => functions.getGlobal("confirmedGlobal")'),
    ).resolves.toEqual(expect.objectContaining({ source: expect.stringContaining("@pit global") }));
    await expect(
      value('async ({ functions }) => functions.getGlobal("missingGlobal")'),
    ).rejects.toThrow("is unavailable");
    await expect(
      value('async ({ functions }) => functions.getSaved("missingGlobal", "global")'),
    ).rejects.toThrow("Global saved function");
    await expect(
      value(
        'async ({ functions }) => (functions as any).promote("confirmedGlobal", "Summary", { unknown: true })',
      ),
    ).rejects.toThrow("unknown fields");
    await expect(
      value(
        'async ({ functions }) => (functions as any).promote("confirmedGlobal", "Summary", { to: "machine" })',
      ),
    ).rejects.toThrow('must be "global" or "project"');

    const cancelled = context();
    cancelled.ui.confirm.mockResolvedValue(false);
    await expect(
      value('async ({ functions }) => functions.removeGlobal("confirmedGlobal")', cancelled),
    ).rejects.toThrow("cancelled");
    const noUi = context({ hasUI: false });
    await expect(
      value('async ({ functions }) => functions.removeGlobal("confirmedGlobal")', noUi),
    ).rejects.toThrow("requires interactive confirmation");
  });

  it("blocks global removal while global dependents remain", async () => {
    await enableGlobalFunctions();
    await writeGlobalFunction(
      "globalRemovalBase",
      "/** Removal base. @pit global */ async function globalRemovalBase() { return 1; }",
    );
    await writeGlobalFunction(
      "globalRemovalConsumer",
      "/** Removal consumer. @pit global */ async function globalRemovalConsumer() { return globalRemovalBase(); }",
    );
    await sessionStart({}, context());

    const plan = await value(
      'async ({ functions }) => functions.planRemoval("globalRemovalBase", "global")',
    );
    expect(plan).toMatchObject({
      scope: "global",
      directDependents: ["globalRemovalConsumer"],
      blocked: true,
    });
    await expect(
      value('async ({ functions }) => functions.removeGlobal("globalRemovalBase")'),
    ).rejects.toThrow("dependent saved functions remain");
  });
});

it("requires confirmation before global promotion", async () => {
  await enableGlobalFunctions();
  await sessionStart({}, context());
  await run("async function confirmationHelper() { return true; }");

  const cancelled = context();
  cancelled.ui.confirm.mockResolvedValue(false);
  await expect(
    value(
      'async ({ functions }) => functions.promote("confirmationHelper", "Confirmed helper.", { to: "global" })',
      cancelled,
    ),
  ).rejects.toThrow("cancelled");
  const noUi = context({ hasUI: false });
  await expect(
    value(
      'async ({ functions }) => functions.promote("confirmationHelper", "Confirmed helper.", { to: "global" })',
      noUi,
    ),
  ).rejects.toThrow("requires interactive confirmation");
  await expect(
    value('async ({ functions }) => functions.promote("confirmationHelper", "", { to: "global" })'),
  ).rejects.toThrow("Global function summary is required");
});

it("reports sorted global metadata and transitive removal blockers", async () => {
  await enableGlobalFunctions();
  await writeGlobalFunction(
    "chainBase",
    "/** Chain base. @pit global */ async function chainBase() { return 1; }",
  );
  await writeGlobalFunction(
    "chainMiddle",
    "/** Chain middle. @pit global */ async function chainMiddle() { return chainBase(); }",
  );
  await writeGlobalFunction(
    "chainTop",
    "/** Chain top. @pit global */ async function chainTop() { return chainMiddle(); }",
  );
  await sessionStart({}, context());

  const listed = await value("async ({ functions }) => functions.listGlobal()");
  expect(listed.map((entry: { name: string }) => entry.name)).toEqual([
    "chainBase",
    "chainMiddle",
    "chainTop",
  ]);
  const plan = await value('async ({ functions }) => functions.planRemoval("chainBase")');
  expect(plan).toMatchObject({
    directDependents: ["chainMiddle"],
    transitiveDependents: ["chainTop"],
    blocked: true,
  });
  await expect(
    value('async ({ functions }) => functions.planRemoval("missing", "global")'),
  ).rejects.toThrow('Global function "missing" was not found');
});

it("handles cancelled and absent global manager operations", async () => {
  await enableGlobalFunctions();
  await writeGlobalFunction(
    "absentGlobalFile",
    "/** Absent file. @pit global */ async function absentGlobalFile() { return true; }",
  );
  await writeGlobalFunction(
    "absentCapabilityFile",
    "/** Absent capability. @pit global */ async function absentCapabilityFile() { return true; }",
  );
  await writeGlobalFunction(
    "removalCancelled",
    "/** Removal cancelled. @pit global */ async function removalCancelled() { return true; }",
  );
  await sessionStart({}, context());
  await run("async function summaryCancelled() { return true; }");
  await run("async function confirmationCancelled() { return true; }");

  const summaryContext = context({ mode: "tui" });
  summaryContext.ui.input.mockResolvedValueOnce(undefined);
  summaryContext.ui.select
    .mockImplementationOnce(async (_title, options) =>
      options.find((option) => option.startsWith("summaryCancelled [session]")),
    )
    .mockResolvedValueOnce("Save globally")
    .mockResolvedValueOnce(undefined);
  await functionsCommand.handler("", summaryContext);

  const confirmationContext = context({ mode: "tui" });
  confirmationContext.ui.input.mockResolvedValueOnce("Cancelled helper.");
  confirmationContext.ui.confirm.mockResolvedValueOnce(false);
  confirmationContext.ui.select
    .mockImplementationOnce(async (_title, options) =>
      options.find((option) => option.startsWith("confirmationCancelled [session]")),
    )
    .mockResolvedValueOnce("Save globally")
    .mockResolvedValueOnce(undefined);
  await functionsCommand.handler("", confirmationContext);

  const cancelledRemovalContext = context({ mode: "tui" });
  cancelledRemovalContext.ui.confirm.mockResolvedValueOnce(false);
  cancelledRemovalContext.ui.select
    .mockImplementationOnce(async (_title, options) =>
      options.find((option) => option.startsWith("removalCancelled [global]")),
    )
    .mockResolvedValueOnce("Remove globally")
    .mockResolvedValueOnce(undefined);
  await functionsCommand.handler("", cancelledRemovalContext);
  await expect(
    readFile(join(agentDir(), "pit", "functions", "removalCancelled.ts"), "utf8"),
  ).resolves.toContain("@pit global");

  await rm(join(agentDir(), "pit", "functions", "absentCapabilityFile.ts"));
  await expect(
    value('async ({ functions }) => functions.removeGlobal("absentCapabilityFile")'),
  ).resolves.toEqual({ name: "absentCapabilityFile", removed: false });

  await rm(join(agentDir(), "pit", "functions", "absentGlobalFile.ts"));
  const removeContext = context({ mode: "tui" });
  removeContext.ui.select
    .mockImplementationOnce(async (_title, options) =>
      options.find((option) => option.startsWith("absentGlobalFile [global]")),
    )
    .mockResolvedValueOnce("Remove globally")
    .mockResolvedValueOnce(undefined);
  await functionsCommand.handler("", removeContext);
  expect(removeContext.ui.notify).toHaveBeenCalledWith(
    "Global function file was absent: absentGlobalFile",
    "warning",
  );
}, 15_000);

it("keeps invalid global configuration quiet without a UI", async () => {
  await mkdir(agentDir(), { recursive: true });
  await writeFile(join(agentDir(), "pit.json"), "[]");
  const headless = context({ hasUI: false });
  await sessionStart({}, headless);
  expect(headless.ui.notify).not.toHaveBeenCalled();
  const info = await value("async ({ context }) => context.get()", headless);
  expect(info.globalFunctionsEnabled).toBe(false);
});
