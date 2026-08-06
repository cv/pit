import { describe, expect, it } from "vitest";

import {
  boundedIntegerValue,
  recordValue,
  stringArrayValue,
  stringValue,
} from "../../src/shared/argument-values.js";

describe("argument values", () => {
  it("validates supported argument shapes", () => {
    expect(recordValue({ cwd: "/tmp" })).toEqual({ cwd: "/tmp" });
    expect(() => recordValue([])).toThrow("must be an object");
    expect(stringValue("git", "program")).toBe("git");
    expect(() => stringValue(1, "program")).toThrow("must be a string");
    expect(stringArrayValue(["status"], "args")).toEqual(["status"]);
    expect(() => stringArrayValue([1], "args")).toThrow("array of strings");
    expect(boundedIntegerValue(undefined, "limit", 10, 5)).toBe(5);
    expect(() => boundedIntegerValue(11, "limit", 10, 5)).toThrow("between 1 and 10");
  });
});
