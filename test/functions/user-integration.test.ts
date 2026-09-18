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
  setBranchEntries,
  value,
} from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

function agentDir(): string {
  return join(cwd, "agent");
}

async function writeUserFunction(name: string, source: string): Promise<void> {
  const directory = join(agentDir(), "functions");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.ts`), source);
}

async function enableProjectFunctions(): Promise<void> {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "pit.json"),
    JSON.stringify({
      projectFunctions: { enabled: true },
    }),
  );
}

async function writeProjectFunction(name: string, source: string): Promise<void> {
  const directory = join(cwd, ".pi", "functions");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.ts`), source);
}

describe("user functions", () => {
  it("loads users, supports project dependencies, and applies scope precedence", async () => {
    await writeUserFunction(
      "sharedValue",
      '/** Shared user value. */ async function sharedValue({}) { return "user"; }',
    );
    await writeUserFunction(
      "userConsumer",
      "/** User consumer. */ async function userConsumer({ sharedValue }) { return sharedValue(); }",
    );
    await enableProjectFunctions();
    await writeProjectFunction(
      "projectConsumer",
      "/** Project consumer. */ async function projectConsumer({ sharedValue }) { return sharedValue(); }",
    );
    await sessionStart({}, context());

    await expect(value("async ({ sharedValue }) => sharedValue()")).resolves.toBe("user");
    await expect(value("async ({ userConsumer }) => userConsumer()")).resolves.toBe("user");
    await expect(value("async ({ projectConsumer }) => projectConsumer()")).resolves.toBe("user");
    const initial = await value("async ({ context: { get } }) => get()");
    expect(initial).toMatchObject({
      userFunctions: ["sharedValue", "userConsumer"],
      projectFunctions: ["projectConsumer"],
    });

    await writeProjectFunction(
      "sharedValue",
      '/** Project override. */ async function sharedValue({}) { return "project"; }',
    );
    await sessionStart({}, context());
    await expect(value("async ({ sharedValue }) => sharedValue()")).resolves.toBe("project");
    await expect(value("async ({ userConsumer }) => userConsumer()")).resolves.toBe("project");
    await expect(value("async ({ projectConsumer }) => projectConsumer()")).resolves.toBe(
      "project",
    );
    await run('async function sharedValue({}) { return "session"; }');
    await expect(value("async ({ sharedValue }) => sharedValue()")).resolves.toBe("session");
    await expect(value("async ({ userConsumer }) => userConsumer()")).resolves.toBe("session");
    await expect(value("async ({ projectConsumer }) => projectConsumer()")).resolves.toBe(
      "session",
    );
    const metadata = await value(
      'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => getSaved("sharedValue")',
    );
    expect(metadata).toMatchObject({
      scope: "session",
      overridesUser: true,
      overridesProject: true,
    });
    const user = await value(
      'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => getSaved("sharedValue", "user")',
    );
    expect(user).toMatchObject({ scope: "user", overridesUser: false });
  }, 15_000);

  it("loads user functions automatically regardless of obsolete opt-outs", async () => {
    await writeUserFunction(
      "portable",
      "/** Portable. */ async function portable({}) { return true; }",
    );
    await writeFile(
      join(agentDir(), "pit.json"),
      JSON.stringify({ globalFunctions: { enabled: false } }),
    );
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi/pit.json"),
      JSON.stringify({ globalFunctions: { enabled: false } }),
    );
    await sessionStart({}, context({ isProjectTrusted: () => false }));
    await expect(value("async ({ portable }) => portable()")).resolves.toBe(true);
    const info = await value("async ({ context: { get } }) => get()");
    expect(info.userFunctions).toEqual(["portable"]);
  });

  it("promotes and removes a user function with confirmation", async () => {
    await sessionStart({}, context());
    await run("async function portableHelper({}) { return { portable: true }; }");

    await expect(
      value(
        'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => promote("portableHelper", "Portable helper.", { to: "user" })',
      ),
    ).resolves.toEqual({ name: "portableHelper", promoted: true, scope: "user" });
    await expect(
      readFile(join(agentDir(), "functions", "portableHelper.ts"), "utf8"),
    ).resolves.not.toContain("@pit");
    const info = await value("async ({ context: { get } }) => get()");
    expect(info.userFunctions).toContain("portableHelper");
    expect(info.sessionFunctions).not.toContain("portableHelper");

    await expect(
      value(
        'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => removeUser("portableHelper")',
      ),
    ).resolves.toEqual({ name: "portableHelper", removed: true });
    await expect(
      readFile(join(agentDir(), "functions", "portableHelper.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks promotion while non-user dependencies remain", async () => {
    await sessionStart({}, context());
    await run("async function localBase({}) { return 1; }");
    await run("async function dependentPortable({ localBase }) { return localBase(); }");

    await expect(
      value(
        'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => promote("dependentPortable", "Dependent helper.", { to: "user" })',
      ),
    ).rejects.toThrow("non-user dependencies remain: localBase");
  });

  it("advertises users and manages them interactively", async () => {
    await writeUserFunction(
      "catalogUser",
      "/** Catalog user. */ async function catalogUser({}) { return true; }",
    );
    await sessionStart({}, context());
    const prompt = beforeAgentStart({ systemPrompt: "base" });
    expect(prompt.systemPrompt).toContain("## User TypeScript functions");
    expect(prompt.systemPrompt).toContain("catalogUser()");

    const inspectContext = context({ mode: "tui" });
    inspectContext.ui.select
      .mockImplementationOnce(async (_title, options) =>
        options.find((option) => option.startsWith("catalogUser [user]")),
      )
      .mockResolvedValueOnce("Inspect source")
      .mockResolvedValueOnce(undefined);
    await functionsCommand.handler("", inspectContext);
    expect(inspectContext.ui.custom).toHaveBeenCalledOnce();

    await run("async function managerUser({}) { return true; }");
    const saveContext = context({ mode: "tui" });
    saveContext.ui.input.mockResolvedValueOnce("Manager user helper.");
    saveContext.ui.select
      .mockImplementationOnce(async (_title, options) =>
        options.find((option) => option.startsWith("managerUser [session]")),
      )
      .mockResolvedValueOnce("Save to user scope")
      .mockResolvedValueOnce(undefined);
    await functionsCommand.handler("", saveContext);
    expect(saveContext.ui.notify.mock.calls).toContainEqual([
      "Saved function to user scope: managerUser",
      "info",
    ]);
    await expect(
      readFile(join(agentDir(), "functions", "managerUser.ts"), "utf8"),
    ).resolves.not.toContain("@pit");

    const removeContext = context({ mode: "tui" });
    removeContext.ui.select
      .mockImplementationOnce(async (_title, options) =>
        options.find((option) => option.startsWith("managerUser [user]")),
      )
      .mockResolvedValueOnce("Remove from user scope")
      .mockResolvedValueOnce(undefined);
    await functionsCommand.handler("", removeContext);
    await expect(
      readFile(join(agentDir(), "functions", "managerUser.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates user capability options and interactive confirmation", async () => {
    await writeUserFunction(
      "confirmedUser",
      "/** Confirmed user. */ async function confirmedUser({}) { return true; }",
    );
    await sessionStart({}, context());

    await expect(
      value(
        "async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => listUser()",
      ),
    ).resolves.toEqual([expect.objectContaining({ name: "confirmedUser" })]);
    await expect(
      value(
        'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => getUser("confirmedUser")',
      ),
    ).resolves.toEqual(expect.objectContaining({ source: expect.not.stringContaining("@pit") }));
    await expect(
      value(
        'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => getUser("missingUser")',
      ),
    ).rejects.toThrow("is unavailable");
    await expect(
      value(
        'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => getSaved("missingUser", "user")',
      ),
    ).rejects.toThrow("User function");
    await expect(
      value(
        'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => (promote as any)("confirmedUser", "Summary", { unknown: true })',
      ),
    ).rejects.toThrow("unknown fields");
    await expect(
      value(
        'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => (promote as any)("confirmedUser", "Summary", { to: "machine" })',
      ),
    ).rejects.toThrow('must be "user" or "project"');

    const cancelled = context();
    cancelled.ui.confirm.mockResolvedValue(false);
    await expect(
      value(
        'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => removeUser("confirmedUser")',
        cancelled,
      ),
    ).rejects.toThrow("cancelled");
    const noUi = context({ hasUI: false });
    await expect(
      value(
        'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => removeUser("confirmedUser")',
        noUi,
      ),
    ).rejects.toThrow("requires interactive confirmation");
  });

  it("blocks user removal while user dependents remain", async () => {
    await writeUserFunction(
      "userRemovalBase",
      "/** Removal base. */ async function userRemovalBase({}) { return 1; }",
    );
    await writeUserFunction(
      "userRemovalConsumer",
      "/** Removal consumer. */ async function userRemovalConsumer({ userRemovalBase }) { return userRemovalBase(); }",
    );
    await sessionStart({}, context());

    const plan = await value(
      'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => planRemoval("userRemovalBase", "user")',
    );
    expect(plan).toMatchObject({
      scope: "user",
      directDependents: ["userRemovalConsumer"],
      blocked: true,
    });
    await expect(
      value(
        'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => removeUser("userRemovalBase")',
      ),
    ).rejects.toThrow("dependent saved functions remain");
  });
});

it("requires confirmation before user promotion", async () => {
  await sessionStart({}, context());
  await run("async function confirmationHelper({}) { return true; }");

  const cancelled = context();
  cancelled.ui.confirm.mockResolvedValue(false);
  await expect(
    value(
      'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => promote("confirmationHelper", "Confirmed helper.", { to: "user" })',
      cancelled,
    ),
  ).rejects.toThrow("cancelled");
  const noUi = context({ hasUI: false });
  await expect(
    value(
      'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => promote("confirmationHelper", "Confirmed helper.", { to: "user" })',
      noUi,
    ),
  ).rejects.toThrow("requires interactive confirmation");
  await expect(
    value(
      'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => promote("confirmationHelper", "", { to: "user" })',
    ),
  ).rejects.toThrow("User function summary is required");
});

it("reports sorted user metadata and transitive removal blockers", async () => {
  await writeUserFunction(
    "chainBase",
    "/** Chain base. */ async function chainBase({}) { return 1; }",
  );
  await writeUserFunction(
    "chainMiddle",
    "/** Chain middle. */ async function chainMiddle({ chainBase }) { return chainBase(); }",
  );
  await writeUserFunction(
    "chainTop",
    "/** Chain top. */ async function chainTop({ chainMiddle }) { return chainMiddle(); }",
  );
  await sessionStart({}, context());

  const listed = await value(
    "async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => listUser()",
  );
  expect(listed.map((entry: { name: string }) => entry.name)).toEqual([
    "chainBase",
    "chainMiddle",
    "chainTop",
  ]);
  const plan = await value(
    'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => planRemoval("chainBase")',
  );
  expect(plan).toMatchObject({
    directDependents: ["chainMiddle"],
    transitiveDependents: ["chainTop"],
    blocked: true,
  });
  await expect(
    value(
      'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => planRemoval("missing", "user")',
    ),
  ).rejects.toThrow('User function "missing" was not found');
});

it("handles cancelled and absent user manager operations", async () => {
  await writeUserFunction(
    "absentUserFile",
    "/** Absent file. */ async function absentUserFile({}) { return true; }",
  );
  await writeUserFunction(
    "absentCapabilityFile",
    "/** Absent capability. */ async function absentCapabilityFile({}) { return true; }",
  );
  await writeUserFunction(
    "removalCancelled",
    "/** Removal cancelled. */ async function removalCancelled({}) { return true; }",
  );
  await sessionStart({}, context());
  await run("async function summaryCancelled({}) { return true; }");
  await run("async function confirmationCancelled({}) { return true; }");

  const summaryContext = context({ mode: "tui" });
  summaryContext.ui.input.mockResolvedValueOnce(undefined);
  summaryContext.ui.select
    .mockImplementationOnce(async (_title, options) =>
      options.find((option) => option.startsWith("summaryCancelled [session]")),
    )
    .mockResolvedValueOnce("Save to user scope")
    .mockResolvedValueOnce(undefined);
  await functionsCommand.handler("", summaryContext);

  const confirmationContext = context({ mode: "tui" });
  confirmationContext.ui.input.mockResolvedValueOnce("Cancelled helper.");
  confirmationContext.ui.confirm.mockResolvedValueOnce(false);
  confirmationContext.ui.select
    .mockImplementationOnce(async (_title, options) =>
      options.find((option) => option.startsWith("confirmationCancelled [session]")),
    )
    .mockResolvedValueOnce("Save to user scope")
    .mockResolvedValueOnce(undefined);
  await functionsCommand.handler("", confirmationContext);

  const cancelledRemovalContext = context({ mode: "tui" });
  cancelledRemovalContext.ui.confirm.mockResolvedValueOnce(false);
  cancelledRemovalContext.ui.select
    .mockImplementationOnce(async (_title, options) =>
      options.find((option) => option.startsWith("removalCancelled [user]")),
    )
    .mockResolvedValueOnce("Remove from user scope")
    .mockResolvedValueOnce(undefined);
  await functionsCommand.handler("", cancelledRemovalContext);
  await expect(
    readFile(join(agentDir(), "functions", "removalCancelled.ts"), "utf8"),
  ).resolves.not.toContain("@pit");

  await rm(join(agentDir(), "functions", "absentCapabilityFile.ts"));
  await expect(
    value(
      'async ({ functions: { getUser, getSaved, listUser, planRemoval, promote, removeUser } }) => removeUser("absentCapabilityFile")',
    ),
  ).resolves.toEqual({ name: "absentCapabilityFile", removed: false });

  await rm(join(agentDir(), "functions", "absentUserFile.ts"));
  const removeContext = context({ mode: "tui" });
  removeContext.ui.select
    .mockImplementationOnce(async (_title, options) =>
      options.find((option) => option.startsWith("absentUserFile [user]")),
    )
    .mockResolvedValueOnce("Remove from user scope")
    .mockResolvedValueOnce(undefined);
  await functionsCommand.handler("", removeContext);
  expect(removeContext.ui.notify).toHaveBeenCalledWith(
    "User function file was absent: absentUserFile",
    "warning",
  );
}, 15_000);

it("keeps invalid user configuration quiet without a UI", async () => {
  await mkdir(agentDir(), { recursive: true });
  await writeFile(join(agentDir(), "pit.json"), "[]");
  const headless = context({ hasUI: false });
  await sessionStart({}, headless);
  expect(headless.ui.notify).not.toHaveBeenCalled();
  const info = await value("async ({ context: { get } }) => get()", headless);
  expect(info.userFunctions).toEqual([]);
});

it("executes namespaced user dependencies after reload", async () => {
  const directory = join(agentDir(), "functions", "company");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "answer.ts"),
    "/** Answer. */ async function answer({}) { return 42; }",
  );
  await sessionStart({}, context());
  await expect(value("async ({ company: { answer } }) => answer()")).resolves.toBe(42);
  await expect(
    value('async ({ functions: { getUser } }) => getUser("company.answer")'),
  ).resolves.toMatchObject({ name: "company.answer" });
});

it("fails closed for an invalid user override until explicitly removed", async () => {
  const directory = join(agentDir(), "functions", "workspace");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "read.ts"), "broken override");
  await writeUserFunction(
    "unrelated",
    "/** Unrelated. */ async function unrelated({}) { return 42; }",
  );
  await sessionStart({}, context());
  await expect(value("async ({ unrelated }) => unrelated()")).resolves.toBe(42);
  await expect(
    value('async ({ functions: { getUser } }) => getUser("workspace.read")'),
  ).rejects.toThrow("expected one documented top-level function declaration");
  await expect(value('async ({ workspace: { read } }) => read("package.json")')).rejects.toThrow(
    'Function "workspace.read" is unavailable',
  );
  await expect(
    value('async ({ functions: { removeUser } }) => removeUser("workspace.read")'),
  ).resolves.toMatchObject({ removed: true });
  await writeFile(join(cwd, "package.json"), "{}");
  await expect(
    value(
      'async ({ workspace: { read } }) => (await read("package.json", { format: "raw" })).content',
    ),
  ).resolves.toBe("{}");
});

it("does not bypass invalid overrides through transitive user dependencies", async () => {
  const directory = join(agentDir(), "functions", "workspace");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "read.ts"), "broken override");
  await writeUserFunction(
    "inspect",
    '/** Inspect. */ async function inspect({ workspace: { read } }) { return read("package.json"); }',
  );
  await sessionStart({}, context());
  await expect(value("async ({ inspect }) => inspect()")).rejects.toThrow(
    'Function "workspace.read" is unavailable',
  );
});

it("rejects old global APIs and ignores old session entries", async () => {
  setBranchEntries([
    {
      type: "custom",
      customType: "pit-functions",
      data: { name: "old", source: "async function old({}) { return 1; }" },
    },
  ]);
  await sessionStart({}, context());
  await expect(value("async ({ old }) => old()")).rejects.toThrow("does not exist");
  await expect(value("async ({ functions: { listGlobal } }) => listGlobal()")).rejects.toThrow(
    "does not exist",
  );
  await run("async function portable({}) { return 1; }");
  await expect(
    value(
      'async ({ functions: { promote } }) => (promote as any)("portable", "Portable", { to: "global" })',
    ),
  ).rejects.toThrow('must be "user" or "project"');
});
