import { readFile } from "node:fs/promises";

import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getNamedFunctionName } from "../../src/functions/source.js";
import { prepareSandboxProgram } from "../../src/sandbox/program.js";
import { createToolDescription } from "../../src/tool/metadata.js";
import { cleanupHarness, setupHarness, tool } from "../support/extension-fixture.js";
import { measurePrompt, schemaDescriptions, textSize } from "../support/prompt-metadata.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

const description = createToolDescription(DEFAULT_MAX_BYTES);
const examples = [...description.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => ({
  name: (match[1] as string).split("\n")[0],
  source: match[1] as string,
}));
const namedExamples = new Map<string, string>();
for (const { source } of examples) {
  const name = getNamedFunctionName(source);
  if (name) namedExamples.set(name, source);
}
namedExamples.set("company.check", "async function check({}) { return true; }");

const invariants: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "method-level injection",
    pattern: /Inject every direct dependency in the first parameter, not whole namespaces/,
  },
  { name: "typed workflows", pattern: /Prefer typed Git\/npm\/GitHub functions/ },
  {
    name: "shell escape hatches",
    pattern: /shell.execFile for unsupported commands, shell.exec only for shell syntax/,
  },
  {
    name: "independent batching",
    pattern: /one invocation with Promise.all; Promise.allSettled for optional probes/,
  },
  { name: "mutation sequencing", pattern: /Sequence dependent work and conflicting mutations/ },
  { name: "reuse before new helpers", pattern: /Reuse, extend, or compose existing helpers/ },
  {
    name: "one parameterized intent",
    pattern: /one named, parameterized function per recurring intent/,
  },
  {
    name: "fresh anchors",
    pattern: /fresh read\/search revisions and anchors; never guess or reuse stale/,
  },
  { name: "invalidation", pattern: /re-read after edits, formatting, or mismatches/ },
  { name: "same-file serialization", pattern: /Never mutate one file concurrently/ },
  { name: "bounded work", pattern: /Request only needed fields and limits/ },
  {
    name: "bounded results",
    pattern: /bounded excerpts, not whole corpora. Narrow truncated queries/,
  },
  { name: "minimal probes", pattern: /Probe unfamiliar APIs before fan-out/ },
  { name: "syntax recovery", pattern: /After a malformed submission, simplify/ },
  {
    name: "repeated failure recovery",
    pattern: /after two similar failures, inspect the contract\/state/,
  },
  { name: "portable authoring constraints", pattern: /no imports or Node globals/ },
  { name: "async injection", pattern: /Injected functions are async/ },
  {
    name: "session commit semantics",
    pattern: /save to session after successful execution or saveOnly/,
  },
  { name: "namespaced identity", pattern: /functionId: "company.check" names a declaration check/ },
  { name: "layer order", pattern: /session > project > user > global/ },
  { name: "virtual dependency resolution", pattern: /dependencies resolve virtually/ },
  {
    name: "persistence gates",
    pattern: /User functions auto-load; projects need trust\/enablement/,
  },
  {
    name: "read-only versus sealed",
    pattern: /Read-only package globals allow overrides unless sealed; functions.\* is sealed/,
  },
  { name: "signature compatibility", pattern: /Preserve lower public signatures/ },
  {
    name: "definition-relative next",
    pattern: /Inject \$next for the same ID's next lower layer, not prior same-layer versions/,
  },
  {
    name: "promotion rebinding",
    pattern: /Promotion rebinds \$next and validates at the destination before writing/,
  },
  { name: "user method names", pattern: /listUser\/getUser\/removeUser: user/ },
  {
    name: "paginated shape",
    pattern:
      /listAll\(\{scope\?, allDefinitions\?, offset\?, limit\?\}\?\) -> \{functions, total, offset, nextOffset\?\}/,
  },
  { name: "page bounds", pattern: /limit 1–200, default 50/ },
  {
    name: "shadowed layer inspection",
    pattern: /Effective by default; scope includes shadowed entries; allDefinitions: every layer/,
  },
  {
    name: "native/source discriminator",
    pattern: /native\/source\/invalid.*source only for kind: "source"/,
  },
  {
    name: "explicit user promotion",
    pattern:
      /promote\(name, summary, \{to: "user"\}\).*after confirmation; default target: project/,
  },
  { name: "removal planning", pattern: /planRemoval\(name, scope\?\) previews blockers/ },
  {
    name: "explicit cascade",
    pattern: /removeSession\(name, \{cascade: true\}\) explicitly removes dependents/,
  },
  { name: "file creation", pattern: /revision: null with replaceFile/ },
  {
    name: "sparse read defaults",
    pattern: /Absent metadata: offset=1, totalLines=lines, hasMore\/truncated=false/,
  },
  { name: "unique edit targets", pattern: /Edit batches require unique files/ },
  { name: "homogeneous batches", pattern: /workspace.batch uses homogeneous reads/ },
];

describe("emitted Pit prompt", () => {
  it.each(invariants)("explains $name", ({ pattern }) => {
    const emitted = [tool.description, ...(tool.promptGuidelines ?? [])].join("\n");
    expect(emitted).toMatch(pattern);
  });

  it("describes the callable contract without execution-engine branding", () => {
    const emitted = [
      tool.description,
      tool.promptSnippet ?? "",
      ...(tool.promptGuidelines ?? []),
      ...schemaDescriptions(tool.parameters),
    ].join("\n");
    expect(emitted).not.toMatch(/wasmtime|quickjs/i);
  });

  it("registers the measured description and keeps schema constraints", () => {
    expect(tool.description).toBe(description);
    expect(tool.parameters).toMatchObject({
      required: ["code"],
      properties: { timeoutMs: { minimum: 1, maximum: 300_000 } },
    });
    expect(tool.parameters.properties.label.description).toContain("not a hard limit");
    expect(tool.parameters.properties.code.description).toContain("or undefined");
    expect(tool.parameters.properties.params.description).toContain("annotate its type");
    expect(tool.parameters.properties.functionId.description).toContain("not valid for anonymous");
    expect(tool.parameters.properties.saveOnly.description).toContain("cannot combine with params");
    expect(tool.parameters.properties.timeoutMs.description).toContain("default 30000");
  });

  it("budgets all fixed prose without adding the schema twice", () => {
    const size = measurePrompt(tool);
    expect(size.fixed.characters).toBeLessThanOrEqual(6_000);
    expect(size.fixed.bytes).toBeGreaterThanOrEqual(size.fixed.characters);
    expect(size.fixed.characters).toBe(
      Object.values(size.parts).reduce((total, part) => total + part.characters, 0),
    );
    expect(size.serializedSchema).toEqual(textSize(JSON.stringify(tool.parameters)));
    expect(schemaDescriptions(tool.parameters)).toEqual(
      expect.arrayContaining(
        Object.values(tool.parameters.properties).map((parameter) => parameter.description),
      ),
    );
    expect(
      measurePrompt({
        ...tool,
        parameters: { ...tool.parameters, nested: { anyOf: [{ description: "new field" }] } },
      }).fixed.characters,
    ).toBe(size.fixed.characters + "new field".length);
  });

  it("finds executable prompt examples instead of maintaining untested copies", () => {
    expect(examples.length).toBeGreaterThan(0);
    expect(namedExamples.has("runTests")).toBe(true);
  });

  it.each(examples)("compiles emitted example $name without host effects", async ({ source }) => {
    const name = getNamedFunctionName(source);
    const program = await prepareSandboxProgram(source, {
      sessionFunctions: namedExamples,
      ...(name ? { definition: { id: name, layer: "session" as const } } : {}),
    });
    expect(program.compiled.length).toBeGreaterThan(0);
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
  ])("validates $name guidance without executing host effects", async ({ source }) => {
    expect((await prepareSandboxProgram(source, {})).compiled.length).toBeGreaterThan(0);
  });

  it("keeps reflection guidance aligned with registry and promotion APIs", async () => {
    const reflection = await readFile("prompts/pit-reflect.md", "utf8");
    for (const phrase of ["nextOffset", 'kind: "source"', '{ to: "user" }', "saveOnly: true"])
      expect(reflection).toContain(phrase);
    expect(reflection).toContain("native globals are read-only");
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
