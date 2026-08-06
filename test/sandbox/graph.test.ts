import { describe, expect, it } from "vitest";

import {
  getSavedFunctionDependencyGraph,
  resolveSavedFunctionReferences,
} from "../../src/sandbox/run.js";

describe("saved function references", () => {
  it("resolves direct and transitive references in dependency order", () => {
    const saved = new Map([
      ["base", "async function base() { return 1; }"],
      ["composed", "async function composed() { return base() + 1; }"],
      ["unrelated", "async function unrelated() { return 0; }"],
    ]);
    expect(resolveSavedFunctionReferences("composed()", saved)).toEqual([
      { name: "base", source: saved.get("base"), direct: false },
      { name: "composed", source: saved.get("composed"), direct: true },
    ]);
    expect(resolveSavedFunctionReferences("({ base: 1 }).base", saved)).toEqual([]);
    expect(
      resolveSavedFunctionReferences(
        `
      const base = 1;
      function local(base) { return 1; }
      const object = { base: 1, base() { return 1; } };
      const { base: renamed } = object;
      try { throw new Error(); } catch (base) { void base; }
      class base { value = renamed; }
      type Named = base;
      type Queried = typeof base;
    `,
        saved,
      ),
    ).toEqual([]);

    expect(resolveSavedFunctionReferences("composed() + base()", saved)).toEqual([
      { name: "base", source: saved.get("base"), direct: true },
      { name: "composed", source: saved.get("composed"), direct: true },
    ]);

    const directPromotion = new Map([
      ["aComposed", "async function aComposed() { return zBase(); }"],
      ["zBase", "async function zBase() { return 1; }"],
    ]);
    expect(resolveSavedFunctionReferences("aComposed() + zBase()", directPromotion)).toEqual([
      { name: "zBase", source: directPromotion.get("zBase"), direct: true },
      { name: "aComposed", source: directPromotion.get("aComposed"), direct: true },
    ]);
  });

  it("reports direct and transitive reverse dependencies", () => {
    const graph = getSavedFunctionDependencyGraph(
      new Map([
        ["base", "async function base() { return 1; }"],
        ["middle", "async function middle() { return base(); }"],
        ["sibling", "async function sibling() { return base(); }"],
        ["leafA", "async function leafA() { return middle(); }"],
        ["leafB", "async function leafB() { return middle(); }"],
      ]),
    );

    expect(graph.directDependencies("missing")).toEqual([]);
    expect(graph.dependents("base")).toEqual({
      direct: ["middle", "sibling"],
      transitive: ["leafA", "leafB"],
    });
    expect(graph.cycles()).toEqual([]);
  });

  it("handles and orders cyclic saved references without duplication", () => {
    const saved = new Map([
      ["first", "async function first() { return second(); }"],
      ["second", "async function second() { return first(); }"],
      ["alpha", "async function alpha() { return beta(); }"],
      ["beta", "async function beta() { return alpha(); }"],
    ]);
    const graph = getSavedFunctionDependencyGraph(saved);
    const references = graph.resolve("first()");
    expect(references.map((reference) => reference.name).sort()).toEqual(["first", "second"]);
    expect(graph.cycles()).toEqual([
      ["alpha", "beta"],
      ["first", "second"],
    ]);
    expect(graph.dependents("first")).toEqual({ direct: ["second"], transitive: [] });
  });
});
