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

  it.each<{ name: string; source: string }>([
    { name: "an empty expression declaration", source: "async ({}, input: number) => input * 2" },
    { name: "an async arrow without parameters", source: "async () => 42" },
    { name: "an arrow without parameters", source: "() => 42" },
    { name: "a declaration without parameters", source: "async function example() {}" },
  ])("accepts $name as no dependencies", ({ source }) => {
    expect(getFunctionDependencies(source)).toEqual({ dependencies: [], usesNext: false });
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
      name: "captured dependency container",
      source: "async function example(dependencies) {}",
      error: 'or ({}) when none are needed; found "dependencies"',
    },
    {
      name: "array dependency pattern",
      source: "async function example([first]) {}",
      error:
        "object first parameter, such as ({ workspace: { read } }), or ({}) when none are needed; found an array pattern",
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
