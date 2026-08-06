import { describe, expect, it } from "vitest";

import {
  getNamedFunctionName,
  getProjectFunctionMetadata,
  getSavedFunctionCallSignature,
} from "../../src/functions/source.js";

describe("saved function source", () => {
  it("detects named top-level function expressions", () => {
    expect(getNamedFunctionName("async function runTests() { return null; }")).toBe("runTests");
    expect(getNamedFunctionName("((async function wrapped() { return null; }))")).toBe("wrapped");
    expect(getNamedFunctionName("async function () { return null; }")).toBeUndefined();
    expect(getNamedFunctionName("async () => null")).toBeUndefined();
    expect(getNamedFunctionName("missing()")).toBeUndefined();

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

  it("extracts project function documentation", () => {
    expect(getProjectFunctionMetadata("")).toBeUndefined();
    expect(
      getProjectFunctionMetadata("async function first() {} async function second() {}"),
    ).toBeUndefined();
    expect(
      getProjectFunctionMetadata(`/**
 * Documented helper.
 *
 * Details.
 * @pit project
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
      getProjectFunctionMetadata(`/**
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
