import { describe, expect, it } from "vitest";

import { resolveToolInput } from "../../src/tool/input.js";

const encoded = JSON.stringify({ value: 21 });

describe("resolveToolInput", () => {
  it.each<{ name: string; source: string; params: unknown; expected: unknown }>([
    {
      name: "an object input given a JSON object string",
      source: "async ({}, input: { value: number }) => input.value",
      params: encoded,
      expected: { value: 21 },
    },
    {
      name: "an array input given a JSON array string",
      source: "async ({}, input: number[]) => input.length",
      params: " [1, 2, 3] ",
      expected: [1, 2, 3],
    },
    {
      name: "a named definition with a record input",
      source: "async function inspect({}, input: Record<string, number>) { return input; }",
      params: encoded,
      expected: { value: 21 },
    },
    {
      name: "a string input",
      source: "async ({}, input: string) => input",
      params: encoded,
      expected: encoded,
    },
    {
      name: "a union that admits strings",
      source: "async ({}, input: { value: number } | string) => input",
      params: encoded,
      expected: encoded,
    },
    {
      name: "a string literal input",
      source: 'async ({}, input: "{}" | "[]") => input',
      params: "{}",
      expected: "{}",
    },
    {
      name: "an unknown input",
      source: "async ({}, input: unknown) => input",
      params: encoded,
      expected: encoded,
    },
    {
      name: "an unannotated input",
      source: "async ({}, input) => input",
      params: encoded,
      expected: encoded,
    },
    {
      name: "a string that is not JSON",
      source: "async ({}, input: { value: number }) => input",
      params: "{ value: 21 }",
      expected: "{ value: 21 }",
    },
    {
      name: "a JSON primitive string",
      source: "async ({}, input: number) => input",
      params: "42",
      expected: "42",
    },
    {
      name: "an already decoded object",
      source: "async ({}, input: { value: number }) => input",
      params: { value: 21 },
      expected: { value: 21 },
    },
  ])("resolves $name", ({ source, params, expected }) => {
    expect(resolveToolInput(source, params)).toEqual(expected);
  });
});
