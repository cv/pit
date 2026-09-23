import { describe, expect, it } from "vitest";

import {
  createLayeredFunctionRegistry,
  globalFunctionDefinitions,
} from "../../src/functions/definitions.js";
import {
  resolveFunctionGraph,
  sourceFunctionDefinition,
} from "../../src/functions/resolved-graph.js";

describe("unified function graph", () => {
  it("registers capability methods as global native functions", () => {
    const definitions = globalFunctionDefinitions();
    expect(definitions).toContainEqual(
      expect.objectContaining({
        id: "workspace.read",
        layer: "global",
        kind: "native",
        capability: "workspace",
        method: "read",
        effect: "workspace.read",
      }),
    );
    expect(definitions.find(({ id }) => id === "functions.promote")?.sealed).toBe(true);
  });

  it("resolves explicit roots and private effects", () => {
    const graph = resolveFunctionGraph(
      "async ({ workspace: { read }, git: { status } }) => ({ read, status })",
      createLayeredFunctionRegistry(),
    );

    expect(graph.roots.map(({ id }) => id)).toEqual(["workspace.read", "git.status"]);
    expect(graph.effects).toEqual(["git.status", "workspace.read"]);
  });

  it("resolves virtual dependencies through the active project layer", () => {
    const registry = createLayeredFunctionRegistry([
      sourceFunctionDefinition(
        "validatePit",
        "global",
        "async function validatePit({ npm: { test } }) { return test(); }",
      ),
      sourceFunctionDefinition(
        "npm.test",
        "project",
        "async function test({ $next }, options) { return $next(options); }",
      ),
    ]);

    const graph = resolveFunctionGraph("async ({ validatePit }) => validatePit()", registry);
    const globalValidate = graph.nodes.get("global:validatePit");
    const projectTest = graph.nodes.get("project:npm.test");

    expect(globalValidate?.dependencies).toEqual([
      { id: "npm.test", localName: "test", targetKey: "project:npm.test" },
    ]);
    expect(projectTest?.nextKey).toBe("global:npm.test");
    expect(graph.effects).toEqual(["npm.test"]);
  });

  it.each<{ name: string; source: string; namespace: string; binding: string }>([
    {
      name: "builtin namespace",
      source: "async ({ context }) => context.get()",
      namespace: "context",
      binding: "{ context: { get } }",
    },
    {
      name: "aliased namespace",
      source: "async ({ context: ctx }) => ctx.get()",
      namespace: "context",
      binding: "{ context: { get } }",
    },
    {
      name: "custom namespace",
      source: "async ({ company }) => company.tools.check()",
      namespace: "company",
      binding: "{ company: { tools: { check } } }",
    },
    {
      name: "nested custom namespace",
      source: "async ({ company: { tools } }) => tools.check()",
      namespace: "company.tools",
      binding: "{ company: { tools: { check } } }",
    },
  ])("explains $name capture with a nested binding", ({ source, namespace, binding }) => {
    const registry = createLayeredFunctionRegistry([
      sourceFunctionDefinition("company.tools.check", "project", "async function check({}) {}"),
    ]);
    expect(() => resolveFunctionGraph(source, registry)).toThrow(
      `cannot inject namespace "${namespace}" as a function`,
    );
    expect(() => resolveFunctionGraph(source, registry)).toThrow(binding);
  });

  it("identifies the source function capturing a namespace", () => {
    const registry = createLayeredFunctionRegistry([
      sourceFunctionDefinition(
        "wrapper",
        "project",
        "async function wrapper({ context }) { return context.get(); }",
      ),
    ]);
    expect(() => resolveFunctionGraph("async ({ wrapper }) => wrapper()", registry)).toThrow(
      'function "wrapper" cannot inject namespace "context" as a function',
    );
  });

  it.each<{ name: string; source: string; id: string }>([
    { name: "unknown function", source: "async ({ missing }) => missing()", id: "missing" },
    { name: "partial namespace name", source: "async ({ work }) => work()", id: "work" },
    {
      name: "unknown leaf",
      source: "async ({ workspace: { missing } }) => missing()",
      id: "workspace.missing",
    },
  ])("retains the missing-function diagnostic for $name", ({ source, id }) => {
    expect(() => resolveFunctionGraph(source, createLayeredFunctionRegistry())).toThrow(
      new Error(`submitted program requires unavailable function "${id}"`),
    );
  });

  it("preserves invalid-definition diagnostics ahead of namespace guidance", () => {
    expect(() =>
      resolveFunctionGraph(
        "async ({ context }) => context.get()",
        createLayeredFunctionRegistry(),
        {
          invalidDefinitions: new Map([["context", "invalid persisted definition"]]),
        },
      ),
    ).toThrow(new Error('Function "context" is unavailable: invalid persisted definition'));
  });

  it("rejects missing dependencies and invalid next declarations", () => {
    expect(() =>
      resolveFunctionGraph("async ({ missing }) => missing()", createLayeredFunctionRegistry()),
    ).toThrow('unavailable function "missing"');

    expect(() =>
      resolveFunctionGraph(
        "async ({ custom }) => custom()",
        createLayeredFunctionRegistry([
          sourceFunctionDefinition(
            "custom",
            "project",
            "async function custom({ $next }) { return $next(); }",
          ),
        ]),
      ),
    ).toThrow("declares $next without a lower definition");
  });

  it("rejects multi-function dependency cycles", () => {
    const registry = createLayeredFunctionRegistry([
      sourceFunctionDefinition("first", "project", "async function first({ second }) {}"),
      sourceFunctionDefinition("second", "project", "async function second({ first }) {}"),
    ]);

    expect(() => resolveFunctionGraph("async ({ first }) => first()", registry)).toThrow(
      "function dependency cycle: first -> second -> first",
    );
  });

  it("reuses a shared resolved dependency node", () => {
    const registry = createLayeredFunctionRegistry([
      sourceFunctionDefinition(
        "first",
        "project",
        "async function first({ workspace: { read } }) { return read('a'); }",
      ),
      sourceFunctionDefinition(
        "second",
        "project",
        "async function second({ workspace: { read } }) { return read('b'); }",
      ),
    ]);
    const graph = resolveFunctionGraph(
      "async ({ first, second }) => Promise.all([first(), second()])",
      registry,
    );

    expect(graph.nodes.has("global:workspace.read")).toBe(true);
    expect([...graph.nodes.keys()].filter((key) => key === "global:workspace.read")).toHaveLength(
      1,
    );
  });

  it("rejects unavailable source dependencies and next on global definitions", () => {
    expect(() =>
      resolveFunctionGraph(
        "async ({ wrapper }) => wrapper()",
        createLayeredFunctionRegistry([
          sourceFunctionDefinition("wrapper", "project", "async function wrapper({ missing }) {}"),
        ]),
      ),
    ).toThrow('function "wrapper" requires unavailable dependency "missing"');

    expect(() =>
      resolveFunctionGraph(
        "async ({ custom }) => custom()",
        createLayeredFunctionRegistry([
          sourceFunctionDefinition("custom", "global", "async function custom({ $next }) {}"),
        ]),
      ),
    ).toThrow('global function "custom" cannot declare $next');
  });

  it("rejects next on submitted programs", () => {
    expect(() =>
      resolveFunctionGraph("async ({ $next }) => $next()", createLayeredFunctionRegistry()),
    ).toThrow("submitted programs cannot declare $next");
  });
});
