import { describe, expect, it } from "vitest";

import {
  getSavedFunctionDependencyGraph,
  resolveSavedFunctionReferences,
} from "../../src/functions/graph.js";

describe("explicit function dependencies", () => {
  it("resolves direct and transitive references in dependency order", () => {
    const saved = new Map([
      ["base", "async function base({}) { return 1; }"],
      ["composed", "async function composed({ base }) { return base() + 1; }"],
      ["unrelated", "async function unrelated({}) { return 0; }"],
    ]);
    expect(resolveSavedFunctionReferences("async ({ composed }) => composed()", saved)).toEqual([
      { name: "base", source: saved.get("base"), direct: false },
      { name: "composed", source: saved.get("composed"), direct: true },
    ]);
    expect(resolveSavedFunctionReferences("async ({}) => ({ base: 1 }).base", saved)).toEqual([]);
    expect(
      resolveSavedFunctionReferences("async ({ composed, base }) => composed() + base()", saved),
    ).toEqual([
      { name: "base", source: saved.get("base"), direct: true },
      { name: "composed", source: saved.get("composed"), direct: true },
    ]);

    const directPromotion = new Map([
      ["aComposed", "async function aComposed({ zBase }) { return zBase(); }"],
      ["zBase", "async function zBase({}) { return 1; }"],
    ]);
    expect(
      resolveSavedFunctionReferences(
        "async ({ aComposed, zBase }) => aComposed() + zBase()",
        directPromotion,
      ),
    ).toEqual([
      { name: "zBase", source: directPromotion.get("zBase"), direct: true },
      { name: "aComposed", source: directPromotion.get("aComposed"), direct: true },
    ]);
  });

  it("reports direct and transitive reverse dependencies", () => {
    const graph = getSavedFunctionDependencyGraph(
      new Map([
        ["base", "async function base({}) { return 1; }"],
        ["middle", "async function middle({ base }) { return base(); }"],
        ["sibling", "async function sibling({ base }) { return base(); }"],
        ["leafA", "async function leafA({ middle }) { return middle(); }"],
        ["leafB", "async function leafB({ middle }) { return middle(); }"],
      ]),
    );

    expect(graph.directDependencies("missing")).toEqual([]);
    expect(graph.dependents("base")).toEqual({
      direct: ["middle", "sibling"],
      transitive: ["leafA", "leafB"],
    });
    expect(graph.cycles()).toEqual([]);
  });

  it("detects and orders explicit dependency cycles", () => {
    const saved = new Map([
      ["first", "async function first({ second }) { return second(); }"],
      ["second", "async function second({ first }) { return first(); }"],
      ["alpha", "async function alpha({ beta }) { return beta(); }"],
      ["beta", "async function beta({ alpha }) { return alpha(); }"],
    ]);
    const graph = getSavedFunctionDependencyGraph(saved);
    const references = graph.resolve("async ({ first }) => first()");
    expect(references.map((reference) => reference.name).sort()).toEqual(["first", "second"]);
    expect(graph.cycles()).toEqual([
      ["alpha", "beta"],
      ["first", "second"],
    ]);
    expect(graph.dependents("first")).toEqual({ direct: ["second"], transitive: [] });
  });
});
