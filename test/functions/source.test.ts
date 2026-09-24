import { describe, expect, it } from "vitest";

import {
  getNamedFunctionName,
  getPersistentFunctionMetadata,
  getSavedFunctionCallSignature,
  withPersistentSummary,
} from "../../src/functions/source.js";

describe("saved function source", () => {
  it("detects named top-level function expressions", () => {
    expect(getNamedFunctionName("async function runTests() { return null; }")).toBe("runTests");
    expect(getNamedFunctionName("((async function wrapped() { return null; }))")).toBe("wrapped");
    expect(getNamedFunctionName("async function () { return null; }")).toBeUndefined();
    expect(getNamedFunctionName("async () => null")).toBeUndefined();
    expect(getNamedFunctionName("missing()")).toBeUndefined();

    expect(getNamedFunctionName("}")).toBeUndefined();

    expect(getSavedFunctionCallSignature("async function runTests() { return null; }")).toBe(
      "runTests()",
    );
    expect(
      getSavedFunctionCallSignature(
        "async function inspect(_capabilities, input: { file: string } = { file: 'README.md' }) { return input; }",
      ),
    ).toBe("inspect(input?: { file: string })");
    expect(
      getSavedFunctionCallSignature(
        "async function required(_capabilities, input: string) { return input; }",
      ),
    ).toBe("required(input: string)");
    expect(getSavedFunctionCallSignature("async () => null")).toBeUndefined();
  });

  it("extracts persistent function documentation without requiring scope markers", () => {
    expect(getPersistentFunctionMetadata("")).toBeUndefined();
    expect(
      getPersistentFunctionMetadata("async function first() {} async function second() {}"),
    ).toBeUndefined();

    expect(getPersistentFunctionMetadata("const value = true;")).toBeUndefined();
    expect(() =>
      getPersistentFunctionMetadata("async function undocumented() { return true; }"),
    ).toThrow("persistent functions require a JSDoc summary");
    expect(
      getPersistentFunctionMetadata(`/**
 * Documented helper.
 *
 * Details.
 * @param input.raw
 */
async function documented(_capabilities, input) { return input; }`),
    ).toEqual({
      name: "documented",
      signature: "documented(input: unknown)",
      summary: "Documented helper.",
      parameters: [{ name: "input.raw" }],
    });
    expect(
      getPersistentFunctionMetadata(`/**
 * Uses {@link documented} metadata.
 * @pit project
 * @param input.raw - See {@link documented}.
 */
async function linked(_capabilities, input) { return input; }`),
    ).toEqual({
      name: "linked",
      signature: "linked(input: unknown)",
      summary: "Uses {@link documented} metadata.",
      parameters: [{ name: "input.raw", description: "See {@link documented}." }],
    });
  });
});

const body = "async function addOne({}, input: { value: number }) { return input.value + 1; }";

describe("withPersistentSummary", () => {
  it.each<{ name: string; source: string; expected: string }>([
    { name: "an undocumented definition", source: body, expected: `/** Adds one. */\n${body}` },
    { name: "an empty block", source: `/** */ ${body}`, expected: `/** Adds one. */ ${body}` },
    {
      name: "a different one-line summary",
      source: `/** Old. */ ${body}`,
      expected: `/** Adds one. */ ${body}`,
    },
    {
      name: "a one-line summary with an inline tag",
      source: `/** Old. @deprecated */ ${body}`,
      expected: `/** Adds one. @deprecated */ ${body}`,
    },
    {
      name: "a matching multi-line summary",
      source: `/**\n * Adds one.\n *\n * @param input.value - Value.\n */\n${body}`,
      expected: `/**\n * Adds one.\n *\n * @param input.value - Value.\n */\n${body}`,
    },
    {
      name: "a multi-line summary before details and tags",
      source: `/**\n * Old summary\n * over two lines.\n *\n * Details stay.\n *\n * @param input.value - Value.\n */\n${body}`,
      expected: `/**\n * Adds one.\n *\n * Details stay.\n *\n * @param input.value - Value.\n */\n${body}`,
    },
    {
      name: "a block with only tags",
      source: `/**\n * @param input.value - Value.\n */\n${body}`,
      expected: `/**\n * Adds one.\n *\n * @param input.value - Value.\n */\n${body}`,
    },
    {
      name: "a tag on the opening line",
      source: `/** @param input.value - Value.\n */\n${body}`,
      expected: `/**\n * Adds one.\n *\n * @param input.value - Value.\n */\n${body}`,
    },
    {
      name: "a summary on the opening line",
      source: `/** Old\n * continued.\n */\n${body}`,
      expected: `/** Adds one.\n */\n${body}`,
    },
  ])("writes one documentation block for $name", ({ source, expected }) => {
    const promoted = withPersistentSummary(source, "Adds one.");
    expect(promoted).toBe(expected);
    expect(promoted.match(/\/\*\*/g)).toHaveLength(1);
    expect(getPersistentFunctionMetadata(promoted)?.summary).toBe("Adds one.");
  });

  it("keeps parameter documentation that follows the summary", () => {
    const promoted = withPersistentSummary(
      `/**\n * Old.\n *\n * @param input.value - Number to increment.\n */\n${body}`,
      "Adds one.",
    );
    expect(getPersistentFunctionMetadata(promoted)?.parameters).toEqual([
      { name: "input.value", description: "Number to increment." },
    ]);
  });
});
