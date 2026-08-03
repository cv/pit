import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_REGISTRY,
  generateCapabilityContract,
  validateCapabilityCall,
} from "../src/capability-registry.js";
import {
  CAPABILITY_METHODS,
  display,
  effectiveRegistry,
  formatPitSkillsForPrompt,
  reconstructFunctions,
  savedFunctionCatalogNotice,
  validateRegistryCapacity,
} from "../src/index.js";
import { registerFunctionManager } from "../src/saved-function-manager.js";
import {
  beforeAgentStart,
  branchEntries,
  cleanupHarness,
  context,
  execMock,
  functionsCommand,
  run,
  runWithParams,
  sessionStart,
  sessionTree,
  setActiveTools,
  setBranchEntries,
  setupHarness,
  tool,
  toolResult,
  value,
} from "./extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("function registry handler", () => {
  it("bounds saved function count and aggregate source size", () => {
    expect(() => validateRegistryCapacity(new Map(), "large", "x".repeat(100_001))).toThrow(
      "saved function source exceeds",
    );

    const full = new Map(Array.from({ length: 64 }, (_, index) => [`fn${index}`, "x"]));
    expect(() => validateRegistryCapacity(full, "extra", "x")).toThrow("limited to 64 functions");
    expect(() => validateRegistryCapacity(full, "fn0", "replacement")).not.toThrow();

    const aggregate = new Map(
      Array.from({ length: 10 }, (_, index) => [`fn${index}`, "x".repeat(100_000)]),
    );
    expect(() => validateRegistryCapacity(aggregate, "fn0", "x".repeat(100_000))).not.toThrow();
    expect(() => validateRegistryCapacity(aggregate, "extra", "x")).toThrow(
      "exceeds 976.6KB total source",
    );
  });

  it("bounds session catalogs by complete signatures", () => {
    const functions = new Map(
      Array.from({ length: 64 }, (_, index) => {
        const name = `catalogFunction${String(index).padStart(2, "0")}${"x".repeat(40)}`;
        return [name, `async function ${name}() { return true; }`] as const;
      }),
    );
    const catalog = savedFunctionCatalogNotice(functions);

    expect(Buffer.byteLength(catalog)).toBeLessThanOrEqual(1200);
    expect(catalog).toMatch(/^\n\[Session functions: catalogFunction00x+\(\)/);
    expect(catalog).toMatch(/, … \d+ more\]$/);
    const entries = catalog.slice("\n[Session functions: ".length, -1).split(", ");
    expect(entries.slice(0, -1).every((entry) => /^catalogFunction\d{2}x+\(\)$/.test(entry))).toBe(
      true,
    );
  });

  it("applies capacity to the effective project and session registry", () => {
    const project = new Map(
      Array.from({ length: 63 }, (_, index) => [`projectSlot${index}`, "project"]),
    );
    const session = new Map([
      ["projectSlot0", "session override"],
      ["sessionSlot", "session"],
    ]);
    const effective = effectiveRegistry(project, session);

    expect(effective).toHaveLength(64);
    expect(effective.get("projectSlot0")).toBe("session override");
    expect(() => validateRegistryCapacity(effective, "overflowSlot", "overflow")).toThrow(
      "limited to 64 functions",
    );
    expect(() => validateRegistryCapacity(effective, "sessionSlot", "replacement")).not.toThrow();
  });
  it("reconstructs valid branch-local function mutations", () => {
    const functions = new Map<string, string>();
    const source = `() => "saved"`;
    reconstructFunctions(functions, [
      null,
      { type: "custom", customType: "other", data: {} },
      { type: "custom", customType: "pit-functions", data: null },
      { type: "custom", customType: "pit-functions", data: { name: "bad name", source } },
      { type: "custom", customType: "pit-functions", data: { name: 42, source } },
      { type: "custom", customType: "pit-functions", data: { name: "missing-source", source: 42 } },
      { type: "custom", customType: "pit-functions", data: { name: "stale", source: "() => 1n" } },
      { type: "custom", customType: "pit-functions", data: { name: "active", source } },
      { type: "custom", customType: "pit-functions", data: { name: "active", deleted: true } },
      { type: "custom", customType: "pit-functions", data: { name: "remaining", source } },
    ]);
    expect([...functions.keys()]).toEqual(["remaining"]);
  });

  it("supports function managers without optional project callbacks", async () => {
    let command: { handler: (args: string, ctx: any) => Promise<void> } | undefined;
    const pi = {
      appendEntry: vi.fn(),
      registerCommand: (_name: string, registered: typeof command) => {
        command = registered;
      },
    };

    const sessionFunctions = new Map([
      ["sessionOnly", "async function sessionOnly() { return true; }"],
    ]);
    registerFunctionManager(pi as any, sessionFunctions, {
      planSessionRemoval: (name) => ({
        directDependents: [],
        transitiveDependents: [],
        removalClosure: [name],
      }),
      removeSession: async (name) => {
        sessionFunctions.delete(name);
        return [name];
      },
    });
    const sessionCtx = context({ mode: "tui" });
    sessionCtx.ui.select = vi
      .fn()
      .mockImplementationOnce(async (_title: string, options: string[]) => options[0])
      .mockImplementationOnce(async (_title: string, options: string[]) => {
        expect(options).toEqual(["Inspect source", "Delete", "Close"]);
        return "Close";
      });
    await command?.handler("", sessionCtx);

    registerFunctionManager(pi as any, new Map(), {
      projectFunctions: new Map([
        ["projectOnly", "/** Project only. @pit project */ async function projectOnly() {}"],
      ]),
      planSessionRemoval: (name) => ({
        directDependents: [],
        transitiveDependents: [],
        removalClosure: [name],
      }),
      removeSession: async (name) => [name],
    });
    const projectCtx = context({ mode: "tui" });
    projectCtx.ui.select = vi
      .fn()
      .mockImplementationOnce(async (_title: string, options: string[]) => options[0])
      .mockImplementationOnce(async (_title: string, options: string[]) => {
        expect(options).toEqual(["Inspect source", "Close"]);
        return "Close";
      });
    await command?.handler("", projectCtx);
  });
});

describe("display", () => {
  it("falls back when a value cannot be stringified", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(display(circular)).toBe("[object Object]");
  });
});

describe("Pit skill prompt", () => {
  it("advertises model-invokable skills with Pit file-loading guidance", () => {
    const prompt = formatPitSkillsForPrompt([
      {
        name: "review<&>'",
        description: 'Review "changes" & report\nnext >',
        filePath: "/tmp/<review>&\"'/skill.md",
      },
      {
        name: "manual-only",
        description: "Only available through its command",
        filePath: "/tmp/manual/SKILL.md",
        disableModelInvocation: true,
      },
    ]);

    expect(prompt).toContain("typescript tool's workspace.read capability");
    expect(prompt).toContain("load the complete skill file");

    expect(prompt).toContain("parent of SKILL.md / dirname of the path");
    expect(prompt).toContain("<name>review&lt;&amp;&gt;&apos;</name>");
    expect(prompt).toContain(
      "<description>Review &quot;changes&quot; &amp; report\nnext &gt;</description>",
    );
    expect(prompt).toContain("<location>/tmp/&lt;review&gt;&amp;&quot;&apos;/skill.md</location>");
    expect(prompt).not.toContain("manual-only");
    expect(formatPitSkillsForPrompt([])).toBe("");
    expect(
      formatPitSkillsForPrompt([
        {
          name: "manual-only",
          description: "Manual",
          filePath: "/tmp/manual.md",
          disableModelInvocation: true,
        },
      ]),
    ).toBe("");
  });

  it("does not duplicate a native or previously injected skill catalog", () => {
    const skill = {
      name: "delivery",
      description: "Deliver completed changes",
      filePath: "/skills/delivery/SKILL.md",
    };

    expect(
      beforeAgentStart({
        systemPrompt: "base prompt\n\n<available_skills>native</available_skills>",
        systemPromptOptions: { selectedTools: ["typescript", "read"], skills: [skill] },
      }),
    ).toBeUndefined();
    expect(
      beforeAgentStart({
        systemPrompt: "custom prompt\n\n<available_skills>custom</available_skills>",
        systemPromptOptions: { selectedTools: ["typescript"], skills: [skill] },
      }),
    ).toBeUndefined();
  });

  it("uses the current loaded catalog after a resource refresh", () => {
    const first = beforeAgentStart({
      systemPrompt: "base prompt",
      systemPromptOptions: {
        skills: [{ name: "old-skill", description: "Old", filePath: "/skills/old.md" }],
      },
    });
    const refreshed = beforeAgentStart({
      systemPrompt: "base prompt",
      systemPromptOptions: {
        skills: [{ name: "new-skill", description: "New", filePath: "/skills/new.md" }],
      },
    });

    expect(first.systemPrompt).toContain("<name>old-skill</name>");
    expect(refreshed.systemPrompt).not.toContain("old-skill");
    expect(refreshed.systemPrompt).toContain("<name>new-skill</name>");
  });
  it("injects Pi's loaded skill catalog into Pit's system prompt", () => {
    const result = beforeAgentStart({
      systemPrompt: "base prompt",
      systemPromptOptions: {
        skills: [
          {
            name: "delivery",
            description: "Deliver completed changes",
            filePath: "/skills/delivery/SKILL.md",
          },
        ],
      },
    });

    expect(result.systemPrompt).toContain("base prompt");
    expect(result.systemPrompt).toContain("<available_skills>");
    expect(result.systemPrompt).toContain("<name>delivery</name>");
    expect(result.systemPrompt).toContain("<location>/skills/delivery/SKILL.md</location>");
  });
});

describe("pit extension", () => {
  it("registers compact model-facing usage metadata and activates the tool", async () => {
    expect(tool.label).toBe("TypeScript Workspace");
    expect(tool.promptSnippet).toContain("reusable functions");
    expect(tool.description).toContain("async ({ workspace, git })");
    expect(tool.description).toContain("Promise.all");
    expect(tool.description).toContain("Promise.allSettled");
    expect(tool.description).toContain("contextually type-checked");
    expect(tool.description).toContain("REUSABLE AND COMPOSED FUNCTIONS");
    expect(tool.description).toContain("Save functions aggressively");
    expect(tool.description).toContain("one named function per intent");
    expect(tool.description).toContain("active saved-function signatures");
    expect(tool.description).toContain("HASHED EDIT WORKFLOW");
    expect(tool.description).toContain('kind: "replace"');
    expect(tool.description).toContain("discard every prior revision and anchor");
    expect(tool.description).toContain("missing totalLines means lines");
    expect(tool.description).toContain('kind: "read", file, options?');
    expect(tool.description).toContain("workspace.search(query");
    expect(tool.description).toContain("shell.execFile(program, args");
    expect(tool.description).toContain("functions: list/get/remove project;");
    expect(tool.parameters.properties.label.description).toContain("15 words");
    expect(tool.parameters.properties.code.description).toContain("named function definition");
    expect(tool.parameters.properties.code.description).toContain("do not import");
    expect(tool.parameters.properties.params.description).toContain("second argument");
    expect(tool.parameters.properties.timeoutMs.description).toContain("30000");
    expect(tool.parameters.properties.saveOnly.description).toContain("without executing");
    expect(tool.promptGuidelines).toHaveLength(10);
    const guidelines = tool.promptGuidelines?.join("\n") ?? "";
    expect(guidelines).toContain("prefer git.status/diff/log");
    expect(guidelines).toContain("prefer npm.run/test/install");
    expect(guidelines).toContain("validate one minimal call");
    expect(guidelines).toContain("one tool invocation per step");
    expect(guidelines).toContain("successful edit invalidates");
    expect(guidelines).toContain("one parameterized saved function per intent");
    expect(tool.promptGuidelines?.every((guideline) => guideline.includes("typescript"))).toBe(
      true,
    );
    const metadataChars =
      tool.description.length +
      (tool.promptSnippet?.length ?? 0) +
      guidelines.length +
      (tool.parameters.properties.code.description?.length ?? 0) +
      (tool.parameters.properties.params.description?.length ?? 0);
    expect(metadataChars).toBeLessThan(6800);

    await sessionStart({}, context());
    expect(setActiveTools).toHaveBeenCalledWith(["typescript"]);
  });

  it("keeps capability declarations and model-facing metadata in sync", async () => {
    const contract = await readFile(join(process.cwd(), "src/capability-contract.d.ts"), "utf8");
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    expect(contract).toBe(generateCapabilityContract());

    for (const [capability, methods] of Object.entries(CAPABILITY_METHODS)) {
      const interfaceName =
        CAPABILITY_REGISTRY[capability as keyof typeof CAPABILITY_REGISTRY].interfaceName;
      const pattern = new RegExp(`interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`);
      const body = contract.match(pattern)?.[1] ?? "";
      const declared = [...body.matchAll(/^ {2}([A-Za-z_$][\w$]*)\(/gm)].map((match) => match[1]);
      expect(declared, capability).toEqual([...methods]);
      expect(tool.description, `metadata for ${capability}`).toContain(`${capability}:`);
      for (const method of methods) {
        expect(readme, `README for ${capability}.${method}`).toContain(`\`${method}(`);
      }
    }
  });

  it("validates capability dispatch and arity from the registry", () => {
    expect(() => validateCapabilityCall("context", "get", [])).not.toThrow();
    expect(() => validateCapabilityCall("git", "status", [])).not.toThrow();
    expect(() => validateCapabilityCall("git", "status", [[], {}, 1])).toThrow(
      /expects 0-2 argument/,
    );
    expect(() => validateCapabilityCall("context", "get", [1])).toThrow(/expects 0 argument/);
    expect(() => validateCapabilityCall("workspace", "read", [])).toThrow(/expects 1-2 argument/);
    expect(() => validateCapabilityCall("unknown", "method", [])).toThrow(
      "Unknown capability or method",
    );
  });

  it("suggests project promotion once after repeated session reuse", async () => {
    await run("async function reusableWorkflow() { return true; }");
    for (let index = 0; index < 4; index++) {
      const result = await run("reusableWorkflow()");
      expect(result.content[0].text).not.toContain("Promotion suggestion");
    }
    const threshold = await run("reusableWorkflow()");
    expect(threshold.content[0].text).toContain(
      "Promotion suggestion: heavily reused session function reusableWorkflow",
    );
    expect(threshold.content[0].text).toContain("functions.promote(name, summary)");
    const repeated = await run("reusableWorkflow()");
    expect(repeated.content[0].text).not.toContain("Promotion suggestion");
    await value(`async ({ functions }) => functions.removeSession("reusableWorkflow")`);
  });

  it("automatically saves and invokes named functions", async () => {
    const defined = await run(`async function greet(_capabilities, input) {
      return { greeting: "Hello, " + (input?.name ?? "world") + "!" };
    }`);
    expect(defined.details.value).toEqual({ greeting: "Hello, world!" });
    expect(defined.details.functions).toEqual([{ action: "set", name: "greet", replaced: false }]);
    expect(defined.content[0].text).toContain("Invoke later with: greet(input: unknown)");
    expect(defined.content[0].text).toContain("[Session functions: greet(input: unknown)]");
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        type: "custom",
        customType: "pit-functions",
        data: expect.objectContaining({
          name: "greet",
          source: expect.stringContaining("function greet"),
        }),
      }),
    );

    const invoked = await run(`greet({ name: "Pi" })`);
    expect(invoked.details.value).toEqual({ greeting: "Hello, Pi!" });
    expect(invoked.details.functions).toEqual([{ action: "run", name: "greet", scope: "session" }]);
    expect(invoked.content[0].text).toContain("[Session functions: greet(input: unknown)]");

    const replaced = await run(`async function greet() { return { greeting: "replaced" }; }`);
    expect(replaced.details.functions).toEqual([{ action: "set", name: "greet", replaced: true }]);
    expect(await value("greet()")).toEqual({ greeting: "replaced" });

    await expect(
      run(`async function broken() { throw new Error("initial failure"); }`),
    ).rejects.toThrow("initial failure");
    await expect(
      run(`async function greet() { throw new Error("replacement failure"); }`),
    ).rejects.toThrow("replacement failure");
    expect(await value("greet()")).toEqual({ greeting: "replaced" });

    const info = await value("async ({ context }) => context.get()");
    expect(info.savedFunctions).toEqual(["greet"]);
    expect(branchEntries.some((entry) => entry.data?.name === "broken")).toBe(false);
  });

  it("saves named functions without executing them", async () => {
    const source = `async function deferred({ shell }) {
      return shell.execFile("node", ["--version"]);
    }`;
    const saved = await tool.execute(
      "call-id",
      { code: source, saveOnly: true },
      undefined,
      undefined,
      context(),
    );

    expect(execMock).not.toHaveBeenCalled();
    expect(saved.details.value).toEqual({ savedFunction: "deferred", executed: false });
    expect(saved.content[0].text).toContain('Saved function "deferred" without executing it');
    expect(saved.content[0].text).toContain("[Session functions: deferred()]");
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        customType: "pit-functions",
        data: { name: "deferred", source },
      }),
    );

    const saveOnlyNotice = async (code: string): Promise<string> => {
      const result = await tool.execute(
        "call-id",
        { code, saveOnly: true },
        undefined,
        undefined,
        context(),
      );
      return result.content[0].text;
    };
    expect(
      await saveOnlyNotice(
        "async function requiredNotice(_capabilities, input: { value: string }) { return input.value; }",
      ),
    ).toContain("Invoke later with: requiredNotice(input: { value: string })");
    expect(
      await saveOnlyNotice(
        "async function optionalNotice(_capabilities, input?: number) { return input; }",
      ),
    ).toContain("Invoke later with: optionalNotice(input?: number)");
    expect(await saveOnlyNotice("async function noInputNotice() { return null; }")).toContain(
      "Invoke later with: noInputNotice()",
    );

    await tool.execute("call-id", { code: "deferred()" }, undefined, undefined, context());
    expect(execMock).toHaveBeenCalledOnce();

    await expect(
      tool.execute(
        "call-id",
        { code: "async () => true", saveOnly: true },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("saveOnly requires a named top-level function");
    await expect(
      tool.execute(
        "call-id",
        {
          code: "async function withInput(_capabilities, input: object) { return input; }",
          params: {},
          saveOnly: true,
        },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("saveOnly does not accept top-level params");
  });

  it("rejects replacements that invalidate saved dependents", async () => {
    await run(`async function dependency(_capabilities, input: { value: number } = { value: 1 }) {
      return input.value;
    }`);
    await run(`async function dependent() {
      return dependency({ value: 2 });
    }`);
    const entriesBefore = branchEntries.length;

    await expect(
      run(`async function dependency(
        _capabilities,
        input: { value: string } = { value: "replacement" },
      ) { return input.value; }`),
    ).rejects.toThrow(/number.*string/);

    expect(await value("dependency({ value: 3 })")).toBe(3);
    expect(await value("dependent()")).toBe(2);
    expect(branchEntries).toHaveLength(entriesBefore);
  });

  it("passes and validates top-level params as initial function input", async () => {
    const source =
      "async function inspect(_capabilities, input: { path: string }) { return { path: input.path }; }";
    const result = await runWithParams(source, { path: "README.md" });
    expect(result.details.value).toEqual({ path: "README.md" });
    expect(await value(`inspect({ path: "package.json" })`)).toEqual({ path: "package.json" });

    await expect(
      runWithParams(source.replace("inspect", "invalidInspect"), { path: 42 }),
    ).rejects.toThrow(/number.*string/);
    expect(branchEntries.some((entry) => entry.data?.name === "invalidInspect")).toBe(false);

    const anonymous = await runWithParams(
      "async (_capabilities, input: { value: number }) => ({ doubled: input.value * 2 })",
      { value: 21 },
    );
    expect(anonymous.details.value).toEqual({ doubled: 42 });
    await expect(runWithParams("inspect()", {})).rejects.toThrow(
      "Top-level params can only be passed to a function expression",
    );
  });

  it("does not render injected saved-function sources", async () => {
    await run("async function baseTask() { return { value: 1 }; }");
    await run(
      "async function composedTask() { const base = await baseTask(); return { value: base.value + 1 }; }",
    );
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const expanded =
      tool
        .renderCall?.({ code: "composedTask()" }, theme, { expanded: true, argsComplete: true })
        .render(240)
        .join("\n") ?? "";

    expect(expanded).toContain("composedTask()");
    expect(expanded).not.toContain("saved dependency:");
    expect(expanded).not.toContain("saved function:");
    expect(expanded).not.toContain("async function baseTask");
  });

  it("allows saved functions to call one another", async () => {
    await value(
      "async function base(_capabilities, input) { return { value: (input?.value ?? 0) * 2 }; }",
    );
    await value(`async function composed(_capabilities, input) {
      const result = await base(input);
      return { value: result.value + 1 };
    }`);
    expect(await value("composed({ value: 20 })")).toEqual({ value: 41 });
  });

  it("persists named functions on the active session branch", async () => {
    await value("async function persistent() { return { ok: true }; }");
    await sessionStart({}, context());
    const reloaded = await run("persistent()");
    expect(reloaded.details.value).toEqual({ ok: true });
    expect(reloaded.content[0].text).toContain("[Session functions: persistent()]");

    const previousBranch = [...branchEntries];
    setBranchEntries([]);
    sessionTree({}, context());
    await expect(run("persistent()")).rejects.toThrow("Cannot find name 'persistent'");

    setBranchEntries(previousBranch);
    sessionTree({}, context());
    const restored = await run("persistent()");
    expect(restored.details.value).toEqual({ ok: true });
    expect(restored.content[0].text).toContain("[Session functions: persistent()]");
  });

  it("handles empty, missing, non-TUI, and cancelled function management", async () => {
    const nonTui = context();
    await functionsCommand.handler("", nonTui);
    expect(nonTui.ui.notify).toHaveBeenCalledWith("No saved functions", "info");
    await functionsCommand.handler("show missing", nonTui);
    expect(nonTui.ui.notify).toHaveBeenCalledWith(
      `Saved function "missing" was not found`,
      "error",
    );

    const tui = context({ mode: "tui" });
    await functionsCommand.handler("", tui);
    expect(tui.ui.notify).toHaveBeenCalledWith("No saved functions", "info");

    await run("async function solo() { return true; }");
    await functionsCommand.handler("show solo", nonTui);
    expect(nonTui.ui.notify).toHaveBeenCalledWith(
      "Saved source inspection requires TUI mode",
      "error",
    );

    const entriesBeforeCancellation = branchEntries.length;
    nonTui.ui.confirm = vi.fn(async () => false);
    await functionsCommand.handler("delete solo", nonTui);
    expect((await value("async ({ context }) => context.get()")).savedFunctions).toEqual(["solo"]);
    expect(branchEntries).toHaveLength(entriesBeforeCancellation);
    nonTui.ui.confirm = vi.fn(async () => true);
    await functionsCommand.handler("delete solo", nonTui);
    expect((await value("async ({ context }) => context.get()")).savedFunctions).toEqual([]);
    expect(nonTui.ui.notify).toHaveBeenCalledWith("Deleted saved function: solo", "info");
  });

  it("lists and deletes saved functions through the /functions command", async () => {
    await run("async function baseTask() { return 1; }");
    await run("async function composedTask() { return (await baseTask()) + 1; }");
    await run("async function transitiveTask() { return (await composedTask()) + 1; }");
    const ctx = context();

    await functionsCommand.handler("list", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("baseTask"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("composedTask"), "info");

    await functionsCommand.handler("delete baseTask", ctx);
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Delete baseTask?",
      expect.stringMatching(
        /Also delete dependents: composedTask, transitiveTask\nDirect: composedTask\nTransitive: transitiveTask/,
      ),
    );
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        customType: "pit-functions",
        data: { name: "baseTask", deleted: true },
      }),
    );
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        customType: "pit-functions",
        data: { name: "composedTask", deleted: true },
      }),
    );
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        customType: "pit-functions",
        data: { name: "transitiveTask", deleted: true },
      }),
    );
    expect((await value("async ({ context }) => context.get()")).savedFunctions).toEqual([]);

    await functionsCommand.handler("delete missing", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(`Saved function "missing" was not found`, "error");
    await functionsCommand.handler("unknown", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /functions"),
      "error",
    );
  });

  it("inspects saved source and drives the interactive /functions manager", async () => {
    await run("async function inspectMe() { return { ok: true }; }");
    const ctx = context({ mode: "tui" });
    let rendered = "";
    ctx.ui.custom = vi.fn(async (factory?: any) => {
      if (!factory) {
        return;
      }
      let closed = false;
      const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
      const component = factory({}, theme, {}, () => {
        closed = true;
      });
      rendered = component.render(120).join("\n");
      component.invalidate();
      component.handleInput("x");
      expect(closed).toBe(false);
      component.handleInput("\r");
      expect(closed).toBe(true);
      component.handleInput("\u001b");
      component.handleInput("\u0003");
      component.handleInput("q");
    });

    await functionsCommand.handler("show inspectMe", ctx);
    expect(rendered).toContain("inspectMe");
    expect(rendered).toContain("async function inspectMe");

    const longSource = Array.from(
      { length: 505 },
      (_, index) => `// viewer line ${index + 1}`,
    ).join("\n");
    await run(`async function longViewer() {\n${longSource}\nreturn true;\n}`);
    await functionsCommand.handler("show longViewer", ctx);
    expect(rendered).toContain("source lines omitted");

    ctx.ui.select = vi
      .fn()
      .mockImplementationOnce(async (_title: string, options: string[]) => options[0])
      .mockResolvedValueOnce("Inspect source")
      .mockImplementationOnce(async (_title: string, options: string[]) => options[0])
      .mockResolvedValueOnce("Close");
    await functionsCommand.handler("", ctx);
    expect(ctx.ui.select).toHaveBeenCalledWith(
      "Saved functions",
      expect.arrayContaining([expect.stringContaining("inspectMe")]),
    );
    expect(ctx.ui.custom).toHaveBeenCalledTimes(3);

    ctx.ui.select = vi.fn().mockResolvedValueOnce("not an entry");
    await functionsCommand.handler("", ctx);
    ctx.ui.select = vi.fn().mockResolvedValueOnce(undefined);
    await functionsCommand.handler("", ctx);

    ctx.ui.select = vi
      .fn()
      .mockImplementationOnce(async (_title: string, options: string[]) => options[0])
      .mockResolvedValueOnce(undefined);
    await functionsCommand.handler("", ctx);

    ctx.ui.select = vi
      .fn()
      .mockImplementationOnce(async (_title: string, options: string[]) =>
        options.find((option) => option.startsWith("longViewer")),
      )
      .mockResolvedValueOnce("Delete")
      .mockResolvedValueOnce(undefined);
    await functionsCommand.handler("", ctx);
    expect((await value("async ({ context }) => context.get()")).savedFunctions).toEqual([
      "inspectMe",
    ]);
  });

  it("rejects reserved, oversized, and unknown saved functions", async () => {
    await expect(run("async function Promise() { return null; }")).rejects.toThrow(
      "non-reserved TypeScript identifier",
    );
    const oversized = `async function enormous() { /*${"x".repeat(100_001)}*/ return null; }`;
    await expect(run(oversized)).rejects.toThrow("saved function source exceeds");
    await expect(run("missingFunction()")).rejects.toThrow("Cannot find name 'missingFunction'");
    await expect(
      run(`async (capabilities) => (capabilities as any).__pit.savedFunctionRun("missing")`),
    ).rejects.toThrow('Saved function "missing" is unavailable');
  });
  it("preserves structured context for failed saved functions", async () => {
    await run(`async function failureLeaf(_capabilities, input: { fail?: boolean } = {}) {
      if (input.fail) throw new Error("boom");
      return true;
    }`);
    await run(`async function failureOuter(_capabilities, input: { fail?: boolean } = {}) {
      return failureLeaf(input);
    }`);

    await expect(
      tool.execute(
        "failure-id",
        { code: "failureOuter({ fail: true })" },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("boom");
    const enriched = await toolResult({
      toolName: "typescript",
      toolCallId: "failure-id",
      isError: true,
      content: [{ type: "text", text: "wrapped" }],
    });
    expect(enriched.content).toEqual([{ type: "text", text: "boom" }]);
    expect(enriched.details.failure).toEqual({
      functionPath: ["failureOuter", "failureLeaf"],
      rootError: "boom",
      kind: "user",
    });
    expect(enriched.details.functions).toEqual([
      { action: "run", name: "failureOuter", scope: "session" },
      { action: "run", name: "failureLeaf", scope: "session" },
    ]);
    expect(enriched.details.traces.length).toBeGreaterThan(0);

    await value(`async ({ functions }) => functions.removeSession("failureOuter")`);
    await value(`async ({ functions }) => functions.removeSession("failureLeaf")`);
  });
});
