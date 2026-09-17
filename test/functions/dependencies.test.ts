import { describe, expect, it } from "vitest";

import { getFunctionDependencies } from "../../src/functions/dependencies.js";

describe("getFunctionDependencies", () => {
  it("extracts nested, aliased, and next dependencies", () => {
    expect(
      getFunctionDependencies(`async function validate(
        {
          workspace: { read, search: findText },
          validatePit,
          $next,
        },
        input: { file: string },
      ) { return input.file; }`),
    ).toEqual({
      dependencies: [
        { id: "workspace.read", localName: "read" },
        { id: "workspace.search", localName: "findText" },
        { id: "validatePit", localName: "validatePit" },
      ],
      usesNext: true,
    });
  });

  it("accepts an empty dependency declaration on expressions", () => {
    expect(getFunctionDependencies("async ({}, input: number) => input * 2")).toEqual({
      dependencies: [],
      usesNext: false,
    });
  });

  it("rejects duplicate dependency identifiers", () => {
    expect(() =>
      getFunctionDependencies("async ({ value, value: alias }) => value + alias"),
    ).toThrow('function dependency "value" is declared more than once');
  });

  it.each([
    {
      name: "non-function source",
      source: "42",
      error: "expected a function",
    },
    {
      name: "missing dependency parameter",
      source: "async function example() {}",
      error: "object first parameter",
    },
    {
      name: "captured dependency container",
      source: "async function example(dependencies) {}",
      error: "object first parameter",
    },
    {
      name: "rest binding",
      source: "async function example({ value, ...rest }) {}",
      error: "rest bindings",
    },
    {
      name: "binding default",
      source: "async function example({ value = 1 }) {}",
      error: "default values",
    },
    {
      name: "parameter default",
      source: "async function example({ value } = {}) {}",
      error: "cannot be optional, rest, or defaulted",
    },
    {
      name: "computed dependency",
      source: 'async function example({ ["value"]: value }) {}',
      error: "TypeScript identifiers",
    },
    {
      name: "array binding",
      source: "async function example({ values: [first] }) {}",
      error: "object binding patterns",
    },
    {
      name: "next namespace",
      source: "async function example({ $next: { value } }) {}",
      error: "$next cannot be used as a dependency namespace",
    },
  ])("rejects $name", ({ source, error }) => {
    expect(() => getFunctionDependencies(source)).toThrow(error);
  });
});
