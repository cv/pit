import { describe, expect, it, vi } from "vitest";

import { generateCapabilityContract } from "../../src/capabilities/registry.js";
import { createLayeredFunctionRegistry } from "../../src/functions/definitions.js";
import { sourceFunctionDefinition } from "../../src/functions/resolved-graph.js";
import { functionTypeModel } from "../../src/sandbox/function-types.js";
import { prepareSandboxProgram } from "../../src/sandbox/program.js";
import { runWithFunctionExecutor } from "../../src/sandbox/run.js";
import { validateTypeScript } from "../../src/sandbox/validation.js";
import { configuredFunctionExecutor } from "../../src/sandbox/wasmtime-loader.js";
import { terminationError } from "../../src/shared/termination-errors.js";
import { structureTypeScriptFailure } from "../../src/tool/failure-context.js";
import { typeDiagnostics } from "../helpers/type-contract.js";
import { runInSandbox } from "../support/sandbox.js";

const base = "async function calculate({}, value: number): Promise<number> { return value + 1; }";

describe("layered override contracts", () => {
  it.each<{ name: string; source: string }>([
    {
      name: "broader arguments",
      source:
        "async function calculate({}, value: number | string): Promise<number> { return Number(value); }",
    },
    {
      name: "fewer arguments",
      source: "async function calculate({}): Promise<number> { return 1; }",
    },
    {
      name: "typed next",
      source:
        "async function calculate({ $next }, value: number) { return (await $next(value)) * 2; }",
    },
  ])("accepts $name", ({ source }) => {
    expect(() =>
      validateTypeScript(source, new Map(), undefined, {
        environment: {
          userFunctions: new Map([["calculate", base]]),
          sessionFunctions: new Map([["calculate", source]]),
        },
        definition: { id: "calculate", layer: "session" },
      }),
    ).not.toThrow();
  });

  it.each<{ name: string; source: string }>([
    {
      name: "narrow arguments",
      source: "async function calculate({}, value: 1): Promise<number> { return value; }",
    },
    {
      name: "extra required argument",
      source:
        "async function calculate({}, value: number, required: string): Promise<number> { return value + required.length; }",
    },
    {
      name: "incompatible result",
      source:
        "async function calculate({}, value: number): Promise<string> { return String(value); }",
    },
    {
      name: "wrong next input",
      source: "async function calculate({ $next }, value: number) { return $next(String(value)); }",
    },
  ])("rejects $name", ({ source }) => {
    expect(() =>
      validateTypeScript(source, new Map(), undefined, {
        environment: {
          userFunctions: new Map([["calculate", base]]),
          sessionFunctions: new Map([["calculate", source]]),
        },
        definition: { id: "calculate", layer: "session" },
      }),
    ).toThrow("TypeScript validation failed");
  });

  it("executes all lower layers when a named root declares next", async () => {
    const project =
      "async function calculate({ $next }, value: number) { return (await $next(value)) * 2; }";
    const session =
      "async function calculate({ $next }, value: number) { return (await $next(value)) + 3; }";
    const options = {
      userFunctions: new Map([["calculate", base]]),
      projectFunctions: new Map([["calculate", project]]),
      sessionFunctions: new Map([["calculate", session]]),
    };
    await expect(
      runInSandbox(session, async () => null, {
        ...options,
        definition: { id: "calculate", layer: "session" },
        input: 4,
      }),
    ).resolves.toBe(13);
    await expect(
      runInSandbox("async ({ calculate }) => calculate(4)", async () => null, options),
    ).resolves.toBe(13);
  });

  it("types and runs an override of a native global function", async () => {
    const source =
      'async function get({ $next }) { const context = await $next(); return { ...context, cwd: context.cwd + "/wrapped" }; }';
    const result = await runInSandbox(
      "async ({ context: { get } }) => (await get()).cwd",
      async ({ capability }) => (capability === "context" ? { cwd: "/base" } : null),
      { userFunctions: new Map([["context.get", source]]) },
    );
    expect(result).toBe("/base/wrapped");
    await expect(
      prepareSandboxProgram("async ({ context: { get } }) => get()", {
        userFunctions: new Map([["context.get", "async function get({}) { return 1; }"]]),
      }),
    ).rejects.toThrow("TypeScript validation failed");
  });

  it("keeps type-only lower effects outside the execution grant", async () => {
    const lower = 'async function action({ shell: { exec } }) { await exec("true"); return 1; }';
    const upper = "async function action({}) { return 2; }";
    const prepared = await prepareSandboxProgram("async ({ action }) => action()", {
      userFunctions: new Map([["action", lower]]),
      sessionFunctions: new Map([["action", upper]]),
    });
    expect(prepared.effects).toEqual([]);
    expect(prepared.compiled).not.toContain('exec("true")');
  });

  it("changes the grant when next reaches a lower effect", async () => {
    const source =
      'async function get({ $next, shell: { exec } }) { await exec("true"); return $next(); }';
    const prepared = await prepareSandboxProgram("async ({ context: { get } }) => get()", {
      sessionFunctions: new Map([["context.get", source]]),
    });
    expect(prepared.effects).toEqual(["context.get", "shell.exec"]);
  });

  it("rejects missing next and forged root definitions before execution", async () => {
    const handler = vi.fn();
    const source = "async function calculate({ $next }, value: number) { return $next(value); }";
    await expect(
      runInSandbox(source, handler, {
        sessionFunctions: new Map([["calculate", source]]),
        definition: { id: "calculate", layer: "session" },
      }),
    ).rejects.toThrow("without a lower definition");
    await expect(
      runInSandbox("async function calculate({}) { return 1; }", handler, {
        definition: { id: "calculate", layer: "session" },
      }),
    ).rejects.toThrow("does not match");
    expect(handler).not.toHaveBeenCalled();
  });

  it("preserves generic argument/result relationships through next", async () => {
    const lower =
      "async function identity<T extends string | number>({}, value: T): Promise<T> { return value; }";
    const upper =
      "async function identity<T extends string | number>({ $next }, value: T): Promise<T> { return $next(value); }";
    const options = {
      userFunctions: new Map([["identity", lower]]),
      projectFunctions: new Map([["identity", upper]]),
    };
    await expect(
      runInSandbox(
        'async ({ identity }) => { const value: "literal" = await identity("literal" as const); return value; }',
        async () => null,
        options,
      ),
    ).resolves.toBe("literal");
    await expect(
      prepareSandboxProgram('async ({ identity }) => identity("text")', {
        ...options,
        projectFunctions: new Map([
          ["identity", "async function identity({}, value: string | number) { return value; }"],
        ]),
      }),
    ).rejects.toThrow("TypeScript validation failed");
  });

  it.each<{ name: string; lower: string; upper: string }>([
    {
      name: "optional argument",
      lower: "async function calculate({}, value?: number) { return value ?? 0; }",
      upper: "async function calculate({}, value: number) { return value; }",
    },
    {
      name: "rest argument",
      lower: "async function calculate({}, ...values: number[]) { return values.length; }",
      upper: "async function calculate({}, value: number) { return value; }",
    },
  ])("does not turn a lower $name into a required argument", async ({ lower, upper }) => {
    await expect(
      prepareSandboxProgram("async ({ calculate }) => calculate(1)", {
        userFunctions: new Map([["calculate", lower]]),
        sessionFunctions: new Map([["calculate", upper]]),
      }),
    ).rejects.toThrow("TypeScript validation failed");
  });

  it("executes named next chains in Wasmtime with one event per lower invocation", async () => {
    const project =
      "async function calculate({ $next }, value: number) { return (await $next(value)) * 2; }";
    const session =
      "async function calculate({ $next }, value: number) { return (await $next(value)) + 3; }";
    const handler = vi.fn(async () => null);
    const result = await runWithFunctionExecutor(
      session,
      handler,
      {
        userFunctions: new Map([["calculate", base]]),
        projectFunctions: new Map([["calculate", project]]),
        sessionFunctions: new Map([["calculate", session]]),
        definition: { id: "calculate", layer: "session" },
        input: 4,
        timeoutMs: 5000,
      },
      configuredFunctionExecutor(),
    );
    expect(result).toBe(13);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        functionContext: expect.objectContaining({ scope: "project", depth: 2 }),
      }),
    );
    expect(handler).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        functionContext: expect.objectContaining({ scope: "user", depth: 3 }),
      }),
    );
  });

  it("keeps a capability termination name through saved-function wrappers in Wasmtime", async () => {
    const user =
      "async function calculate({ context: { get } }, value: number): Promise<number> { await get(); return value + 1; }";
    const session =
      "async function calculate({ $next }, value: number) { return (await $next(value)) + 3; }";
    const failure = await runWithFunctionExecutor(
      session,
      async ({ capability }) => {
        if (capability === "context") throw terminationError("timeout", "deadline reached");
        return null;
      },
      {
        userFunctions: new Map([["calculate", user]]),
        sessionFunctions: new Map([["calculate", session]]),
        definition: { id: "calculate", layer: "session" },
        input: 4,
        timeoutMs: 5000,
      },
      configuredFunctionExecutor(),
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ name: "TimeoutError" });
    expect(structureTypeScriptFailure(failure, [])).toMatchObject({
      functionPath: ["calculate"],
      kind: "timeout",
      rootError: expect.stringMatching(/^deadline reached(?:\n|$)/),
    });
  });

  it("does not compile an unavailable effective global through a fallback", async () => {
    await expect(
      prepareSandboxProgram("async ({ context: { get } }) => get()", {
        invalidDefinitions: new Map([["context.get", "invalid persisted override"]]),
      }),
    ).rejects.toThrow('Function "context.get" is unavailable');
  });

  it("rejects a root source that differs from the registered definition", async () => {
    await expect(
      prepareSandboxProgram("async function calculate({}) { return 1; }", {
        sessionFunctions: new Map([["calculate", "async function calculate({}) { return 2; }"]]),
        definition: { id: "calculate", layer: "session" },
      }),
    ).rejects.toThrow("does not match");
  });

  it.each([
    { name: "compatible next argument", argument: "value", accepted: true },
    { name: "incompatible next argument", argument: "String(value)", accepted: false },
  ])("type-checks $name against source-backed globals", ({ argument, accepted }) => {
    const upper = `async function calculate({ $next }, value: number) { return $next(${argument}); }`;
    const registry = createLayeredFunctionRegistry([
      sourceFunctionDefinition("calculate", "global", base),
      sourceFunctionDefinition("calculate", "user", upper),
    ]);
    const model = functionTypeModel(upper, registry, {
      definition: { id: "calculate", layer: "user" },
      checkAll: true,
      checkCompatibility: true,
    });
    const consumer = `${generateCapabilityContract().replaceAll("PitCapabilities", "PitBuiltinCapabilities")}\n${model.declarations}\n${model.signatures}\nconst root = (${upper}) satisfies PitSourceProgram<${model.rootDependencies}>;`;
    expect(typeDiagnostics(consumer).length === 0).toBe(accepted);
  });
});
