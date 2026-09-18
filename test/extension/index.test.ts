import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAPABILITY_REGISTRY,
  generateCapabilityContract,
  validateCapabilityCall,
} from "../../src/capabilities/registry.js";
import { CAPABILITY_METHODS } from "../../src/index.js";
import {
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
} from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("pit extension", () => {
  it("registers compact model-facing usage metadata and activates the tool", async () => {
    expect(tool.label).toBe("TypeScript Workspace");
    expect(tool.promptSnippet).toContain("explicit");
    expect(tool.description).toContain("async ({ workspace: { read }");
    expect(tool.description).toContain("Promise.all");
    expect(tool.description).toContain("Promise.allSettled");
    expect(tool.description).toContain("contextually type-checked");
    expect(tool.description).toContain("REUSABLE AND COMPOSED FUNCTIONS");
    expect(tool.description).toContain("Prefer named functions");
    expect(tool.description).toContain("explicitly");
    expect(tool.description).toContain("available function");
    expect(tool.description).toContain("inject $next");
    expect(tool.description).toContain("HASHED EDIT WORKFLOW");
    expect(tool.description).toContain('kind: "replace"');
    expect(tool.description).toContain("discard every prior revision and anchor");
    expect(tool.description).toContain("missing totalLines means lines");
    expect(tool.description).toContain('kind: "read", file, options?');
    expect(tool.description).toContain("workspace.search(query");
    expect(tool.description).toContain("shell.execFile(program, args");
    expect(tool.description).toContain("functions: project list/get/remove; user list/get/remove;");
    expect(tool.parameters.properties.label.description).toContain("15 words");
    expect(tool.parameters.properties.code.description).toContain("named function definition");
    expect(tool.parameters.properties.code.description).toContain("do not import");
    expect(tool.parameters.properties.params.description).toContain("injected dependency object");
    expect(tool.parameters.properties.timeoutMs.description).toContain("30000");
    expect(tool.parameters.properties.saveOnly.description).toContain("without executing");
    expect(tool.promptGuidelines).toHaveLength(11);
    const guidelines = tool.promptGuidelines?.join("\n") ?? "";
    expect(guidelines).toContain("prefer git.status/diff/log");
    expect(guidelines).toContain("prefer npm.run/test/install");
    expect(guidelines).toContain("validate one minimal call");
    expect(guidelines).toContain("one tool invocation per step");
    expect(guidelines).toContain("successful edit invalidates");
    expect(guidelines).toContain("one parameterized function per intent");
    expect(tool.promptGuidelines?.every((guideline) => guideline.includes("typescript"))).toBe(
      true,
    );
    const metadataChars =
      tool.description.length +
      (tool.promptSnippet?.length ?? 0) +
      guidelines.length +
      (tool.parameters.properties.code.description?.length ?? 0) +
      (tool.parameters.properties.params.description?.length ?? 0);
    expect(metadataChars).toBeLessThan(7100);

    await sessionStart({}, context());
    expect(setActiveTools).toHaveBeenCalledWith(["typescript"]);
  });

  it("keeps capability declarations and model-facing metadata in sync", async () => {
    const contract = await readFile(
      join(process.cwd(), "src/generated/capability-contract.d.ts"),
      "utf8",
    );
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    expect(contract).toBe(generateCapabilityContract());

    for (const [capability, methods] of Object.entries(CAPABILITY_METHODS)) {
      const interfaceName =
        CAPABILITY_REGISTRY[capability as keyof typeof CAPABILITY_REGISTRY].interfaceName;
      const pattern = new RegExp(`interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`);
      const body = contract.match(pattern)?.[1] ?? "";
      const declared = [...body.matchAll(/^ {2}([A-Za-z_$][\w$]*)\(/gm)].map((match) => match[1]);
      expect(declared).toEqual([...methods]);
      expect(tool.description).toContain(`${capability}:`);
      for (const method of methods) {
        expect(readme).toContain(`\`${method}(`);
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
    await run("async function reusableWorkflow({}) { return true; }");
    for (let index = 0; index < 4; index++) {
      const result = await run("async ({ reusableWorkflow }) => reusableWorkflow()");
      expect(result.content[0].text).not.toContain("Promotion suggestion");
    }
    const threshold = await run("async ({ reusableWorkflow }) => reusableWorkflow()");
    expect(threshold.content[0].text).toContain(
      "Promotion suggestion: heavily reused session function reusableWorkflow",
    );
    expect(threshold.content[0].text).toContain("functions.promote(name, summary)");
    const repeated = await run("async ({ reusableWorkflow }) => reusableWorkflow()");
    expect(repeated.content[0].text).not.toContain("Promotion suggestion");
    await value(`async ({ functions: { removeSession } }) => removeSession("reusableWorkflow")`);
  });

  it("automatically saves and invokes named functions", async () => {
    const defined = await run(`async function greet({}, input) {
      return { greeting: "Hello, " + (input?.name ?? "world") + "!" };
    }`);
    expect(defined.details.value).toEqual({ greeting: "Hello, world!" });
    expect(defined.details.functions).toEqual([{ action: "set", name: "greet", replaced: false }]);
    expect(defined.content[0].text).toContain(
      "Inject greet in the first parameter, then call greet(input: unknown)",
    );
    expect(defined.content[0].text).toContain("[Session functions: greet(input: unknown)]");
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        type: "custom",
        customType: "pit-function-definitions",
        data: expect.objectContaining({
          name: "greet",
          source: `async function greet({}, input) {\n  return { greeting: "Hello, " + (input?.name ?? "world") + "!" };\n}`,
        }),
      }),
    );

    const invoked = await run(`async ({ greet }) => greet({ name: "Pi" })`);
    expect(invoked.details.value).toEqual({ greeting: "Hello, Pi!" });
    expect(invoked.details.functions).toEqual([{ action: "run", name: "greet", scope: "session" }]);
    expect(invoked.content[0].text).toContain("[Session functions: greet(input: unknown)]");

    const replaced = await run(`async function greet({}) { return { greeting: "replaced" }; }`);
    expect(replaced.details.functions).toEqual([{ action: "set", name: "greet", replaced: true }]);
    expect(await value("async ({ greet }) => greet()")).toEqual({ greeting: "replaced" });

    await expect(
      run(`async function broken({}) { throw new Error("initial failure"); }`),
    ).rejects.toThrow("initial failure");
    await expect(
      run(`async function greet({}) { throw new Error("replacement failure"); }`),
    ).rejects.toThrow("replacement failure");
    expect(await value("async ({ greet }) => greet()")).toEqual({ greeting: "replaced" });

    const info = await value("async ({ context: { get } }) => get()");
    expect(info.savedFunctions).toEqual(["greet"]);
    expect(branchEntries.some((entry) => entry.data?.name === "broken")).toBe(false);
  }, 15_000);

  it("saves named functions without executing them", async () => {
    const source = `async function deferred({ shell: { execFile } }) {
      return execFile("node", ["--version"]);
    }`;
    const canonicalSource = `async function deferred({ shell: { execFile } }) {
  return execFile("node", ["--version"]);
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
        customType: "pit-function-definitions",
        data: { name: "deferred", source: canonicalSource },
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
        "async function requiredNotice({}, input: { value: string }) { return input.value; }",
      ),
    ).toContain(
      "Inject requiredNotice in the first parameter, then call requiredNotice(input: { value: string })",
    );
    expect(
      await saveOnlyNotice("async function optionalNotice({}, input?: number) { return input; }"),
    ).toContain(
      "Inject optionalNotice in the first parameter, then call optionalNotice(input?: number)",
    );
    expect(await saveOnlyNotice("async function noInputNotice({}) { return null; }")).toContain(
      "Inject noInputNotice in the first parameter, then call noInputNotice()",
    );

    await tool.execute(
      "call-id",
      { code: "async ({ deferred }) => deferred()" },
      undefined,
      undefined,
      context(),
    );
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
          code: "async function withInput({}, input: object) { return input; }",
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
    await run(`async function dependency({}, input: { value: number } = { value: 1 }) {
      return input.value;
    }`);
    await run(`async function dependent({ dependency }) {
      return dependency({ value: 2 });
    }`);
    const entriesBefore = branchEntries.length;

    await expect(
      run(`async function dependency(
        {},
        input: { value: string } = { value: "replacement" },
      ) { return input.value; }`),
    ).rejects.toThrow(/number.*string/);

    expect(await value("async ({ dependency }) => dependency({ value: 3 })")).toBe(3);
    expect(await value("async ({ dependent }) => dependent()")).toBe(2);
    expect(branchEntries).toHaveLength(entriesBefore);
  });

  it("passes and validates top-level params as initial function input", async () => {
    const source =
      "async function inspect({}, input: { path: string }) { return { path: input.path }; }";
    const result = await runWithParams(source, { path: "README.md" });
    expect(result.details.value).toEqual({ path: "README.md" });
    expect(await value(`async ({ inspect }) => inspect({ path: "package.json" })`)).toEqual({
      path: "package.json",
    });

    await expect(
      runWithParams(source.replace("inspect", "invalidInspect"), { path: 42 }),
    ).rejects.toThrow(/number.*string/);
    expect(branchEntries.some((entry) => entry.data?.name === "invalidInspect")).toBe(false);

    const anonymous = await runWithParams(
      "async ({}, input: { value: number }) => ({ doubled: input.value * 2 })",
      { value: 21 },
    );
    expect(anonymous.details.value).toEqual({ doubled: 42 });
    await expect(runWithParams("inspect()", {})).rejects.toThrow(
      "TypeScript programs must be function expressions",
    );
  });

  it("does not render injected saved-function sources", async () => {
    await run("async function baseTask({}) { return { value: 1 }; }");
    await run(
      "async function composedTask({ baseTask }) { const base = await baseTask(); return { value: base.value + 1 }; }",
    );
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const expanded =
      tool
        .renderCall?.({ code: "async ({ composedTask }) => composedTask()" }, theme, {
          expanded: true,
          argsComplete: true,
        })
        .render(240)
        .join("\n") ?? "";

    expect(expanded).toContain("Run composedTask");
    expect(expanded).not.toContain("saved dependency:");
    expect(expanded).not.toContain("saved function:");
    expect(expanded).not.toContain("async function baseTask");
  });

  it("allows saved functions to call one another", async () => {
    await value("async function base({}, input) { return { value: (input?.value ?? 0) * 2 }; }");
    await value(`async function composed({ base }, input) {
      const result = await base(input);
      return { value: result.value + 1 };
    }`);
    expect(await value("async ({ composed }) => composed({ value: 20 })")).toEqual({ value: 41 });
  });

  it("persists named functions on the active session branch", async () => {
    await value("async function persistent({}) { return { ok: true }; }");
    await sessionStart({}, context());
    const reloaded = await run("async ({ persistent }) => persistent()");
    expect(reloaded.details.value).toEqual({ ok: true });
    expect(reloaded.content[0].text).toContain("[Session functions: persistent()]");

    const previousBranch = [...branchEntries];
    setBranchEntries([]);
    sessionTree({}, context());
    await expect(run("async ({ persistent }) => persistent()")).rejects.toThrow(
      /Property 'persistent' does not exist/,
    );

    setBranchEntries(previousBranch);
    sessionTree({}, context());
    const restored = await run("async ({ persistent }) => persistent()");
    expect(restored.details.value).toEqual({ ok: true });
    expect(restored.content[0].text).toContain("[Session functions: persistent()]");
  });

  it("handles empty, missing, non-TUI, and cancelled function management", async () => {
    const nonTui = context();
    await functionsCommand.handler("", nonTui);
    expect(nonTui.ui.notify).toHaveBeenCalledWith(expect.stringContaining("[global]"), "info");
    await functionsCommand.handler("show missing", nonTui);
    expect(nonTui.ui.notify).toHaveBeenCalledWith(`function "missing" is unavailable`, "error");

    const tui = context({ mode: "tui" });
    await functionsCommand.handler("", tui);
    expect(tui.ui.select).toHaveBeenCalledWith(
      "Functions",
      expect.arrayContaining([expect.stringContaining("[global]")]),
    );

    await run("async function solo({}) { return true; }");
    await functionsCommand.handler("show solo", nonTui);
    expect(nonTui.ui.notify).toHaveBeenCalledWith("Function inspection requires TUI mode", "error");

    const entriesBeforeCancellation = branchEntries.length;
    nonTui.ui.confirm = vi.fn(async () => false);
    await functionsCommand.handler("delete solo", nonTui);
    expect((await value("async ({ context: { get } }) => get()")).savedFunctions).toEqual(["solo"]);
    expect(branchEntries).toHaveLength(entriesBeforeCancellation);
    nonTui.ui.confirm = vi.fn(async () => true);
    await functionsCommand.handler("delete solo", nonTui);
    expect((await value("async ({ context: { get } }) => get()")).savedFunctions).toEqual([]);
    expect(nonTui.ui.notify).toHaveBeenCalledWith("Deleted saved function: solo", "info");
  });

  it("lists and deletes saved functions through the /functions command", async () => {
    await run("async function baseTask({}) { return 1; }");
    await run("async function composedTask({ baseTask }) { return (await baseTask()) + 1; }");
    await run(
      "async function transitiveTask({ composedTask }) { return (await composedTask()) + 1; }",
    );
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
        customType: "pit-function-definitions",
        data: { name: "baseTask", deleted: true },
      }),
    );
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        customType: "pit-function-definitions",
        data: { name: "composedTask", deleted: true },
      }),
    );
    expect(branchEntries).toContainEqual(
      expect.objectContaining({
        customType: "pit-function-definitions",
        data: { name: "transitiveTask", deleted: true },
      }),
    );
    expect((await value("async ({ context: { get } }) => get()")).savedFunctions).toEqual([]);

    await functionsCommand.handler("delete missing", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(`Saved function "missing" was not found`, "error");
    await functionsCommand.handler("unknown", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /functions"),
      "error",
    );
  });

  it("inspects saved source and drives the interactive /functions manager", async () => {
    await run(`async function inspectMe({}) {
      /* first
      second */
      return { ok: true };
    }`);
    const ctx = context({ mode: "tui" });
    let rendered = "";
    ctx.ui.custom = vi.fn(async (factory?: any) => {
      if (!factory) {
        return;
      }
      let closed = false;
      const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
      initTheme("dark");
      const component = factory({}, theme, {}, () => {
        closed = true;
      });
      const darkRendered = component.render(120).join("\n");
      initTheme("light");
      component.invalidate();
      rendered = component.render(120).join("\n");
      expect(rendered).not.toBe(darkRendered);
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
    expect(stripTerminalSequences(rendered)).toContain("async function inspectMe");

    const continuedComment = rendered.split("\n").find((line) => line.includes("second */")) ?? "";
    expect(continuedComment.slice(0, continuedComment.indexOf("second */"))).toContain("\u001b[");

    const longSource = Array.from(
      { length: 505 },
      (_, index) => `// viewer line ${index + 1}`,
    ).join("\n");
    await run(`async function longViewer({}) {\n${longSource}\nreturn true;\n}`);
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
      "Functions",
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
    expect((await value("async ({ context: { get } }) => get()")).savedFunctions).toEqual([
      "inspectMe",
    ]);
  });

  it("rejects reserved, oversized, and unknown saved functions", async () => {
    await expect(run("async function Promise({}) { return null; }")).rejects.toThrow(
      "non-reserved TypeScript identifier",
    );
    const oversized = `async function enormous({}) { /*${"x".repeat(100_001)}*/ return null; }`;
    await expect(run(oversized)).rejects.toThrow("saved function source exceeds");
    await expect(run("async ({ missingFunction }) => missingFunction()")).rejects.toThrow(
      /Property 'missingFunction' does not exist/,
    );
    await expect(
      run(`async (dependencies) => (dependencies as any).__pit.savedFunctionRun("missing")`),
    ).rejects.toThrow("object first parameter");
  });
  it("preserves structured context for failed saved functions", async () => {
    await run(`async function failureLeaf({}, input: { fail?: boolean } = {}) {
      if (input.fail) throw new Error("boom");
      return true;
    }`);
    await run(`async function failureOuter({ failureLeaf }, input: { fail?: boolean } = {}) {
      return failureLeaf(input);
    }`);

    await expect(
      tool.execute(
        "failure-id",
        { code: "async ({ failureOuter }) => failureOuter({ fail: true })" },
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

    await value(`async ({ functions: { removeSession } }) => removeSession("failureOuter")`);
    await value(`async ({ functions: { removeSession } }) => removeSession("failureLeaf")`);
  });
});
