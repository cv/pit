import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getNamedFunctionName } from "../../src/functions/source.js";
import { prepareSandboxProgram } from "../../src/sandbox/program.js";
import { cleanupHarness, setupHarness, tool } from "../support/extension-fixture.js";
import { measurePrompt, schemaDescriptions } from "../support/prompt-metadata.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("emitted Pit prompt", () => {
  it("registers the required input and timeout bounds", () => {
    expect(tool.parameters).toMatchObject({
      required: ["code"],
      properties: { timeoutMs: { minimum: 1, maximum: 300_000 } },
    });
  });

  it("budgets all fixed prose without adding the schema twice", () => {
    const size = measurePrompt(tool);
    expect(size.fixed.characters).toBeLessThanOrEqual(6_000);
    expect(size.fixed.bytes).toBeGreaterThanOrEqual(size.fixed.characters);
    expect(
      measurePrompt({
        ...tool,
        parameters: { ...tool.parameters, nested: { anyOf: [{ description: "new field" }] } },
      }).fixed.characters,
    ).toBe(size.fixed.characters + "new field".length);
  });

  it("type-checks every TypeScript example advertised by the registered tool", async () => {
    const examples = [...tool.description.matchAll(/```ts\n([\s\S]*?)```/g)].map(
      (match) => match[1] as string,
    );
    expect(examples.length).toBeGreaterThan(0);
    const namedExamples = new Map<string, string>();
    for (const source of examples) {
      const name = getNamedFunctionName(source);
      if (name) namedExamples.set(name, source);
    }
    // This documented invocation assumes an already-saved namespaced helper.
    namedExamples.set("company.check", "async function check({}) { return true; }");
    for (const source of examples) {
      const name = getNamedFunctionName(source);
      const program = await prepareSandboxProgram(source, {
        sessionFunctions: namedExamples,
        ...(name ? { definition: { id: name, layer: "session" as const } } : {}),
      });
      expect(program.compiled.length).toBeGreaterThan(0);
    }
  });

  it.each<{ name: string; source: string }>([
    {
      name: "filtered pagination",
      source: `async ({ functions: { listAll } }) => {
        const page = await listAll({ scope: "session", allDefinitions: true, offset: 0, limit: 20 });
        return { names: page.functions.map(entry => entry.name), total: page.total, offset: page.offset, nextOffset: page.nextOffset };
      }`,
    },
    {
      name: "native/source inspection",
      source: `async ({ functions: { getSaved } }) => {
        const definition = await getSaved("workspace.read", "global");
        return { kind: definition.kind, signature: definition.signature, next: definition.next, effects: definition.effects,
          sourceLines: definition.kind === "source" ? definition.source.split("\\n").length : 0 };
      }`,
    },
    {
      name: "explicit user promotion",
      source:
        'async ({ functions: { promote } }) => promote("workflow", "Reusable workflow", { to: "user" })',
    },
  ])("accepts typed $name calls without executing host effects", async ({ source }) => {
    expect((await prepareSandboxProgram(source, {})).compiled.length).toBeGreaterThan(0);
  });
});

describe("prompt accounting", () => {
  it.each<{ name: string; schema: unknown; expected: string[] }>([
    { name: "undefined", schema: undefined, expected: [] },
    { name: "null", schema: null, expected: [] },
    { name: "primitive", schema: "ignored", expected: [] },
    { name: "non-description strings", schema: { title: "ignored", description: 5 }, expected: [] },
    {
      name: "nested schemas and combinators",
      schema: {
        description: "root",
        properties: {
          value: { anyOf: [{ description: "é" }, { items: { description: "child" } }] },
        },
      },
      expected: ["root", "é", "child"],
    },
  ])("counts descriptions in $name", ({ schema, expected }) => {
    expect(schemaDescriptions(schema)).toEqual(expected);
  });

  it("distinguishes UTF-8 bytes from characters and handles absent optional prose", () => {
    expect(measurePrompt({ description: "é", parameters: {} })).toEqual({
      parts: {
        description: { characters: 1, bytes: 2 },
        guidelines: { characters: 0, bytes: 0 },
        snippet: { characters: 0, bytes: 0 },
        parameterDescriptions: { characters: 0, bytes: 0 },
      },
      fixed: { characters: 1, bytes: 2 },
      serializedSchema: { characters: 2, bytes: 2 },
    });
  });
});
