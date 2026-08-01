import { describe, expect, it } from "vitest";
import {
  boundedIntegerValue,
  nonemptyLines,
  outcomeColor,
  parseProcessResult,
  recordValue,
  semanticOutcome,
  stringArrayValue,
  stringValue,
} from "../src/cli.js";

const processResult = (code = 0) => ({ stdout: "ok", stderr: "", code, truncated: false });

describe("CLI contracts", () => {
  it("validates argument shapes", () => {
    expect(recordValue({ cwd: "/tmp" })).toEqual({ cwd: "/tmp" });
    expect(() => recordValue([])).toThrow("must be an object");
    expect(stringValue("git", "program")).toBe("git");
    expect(() => stringValue(1, "program")).toThrow("must be a string");
    expect(stringArrayValue(["status"], "args")).toEqual(["status"]);
    expect(() => stringArrayValue([1], "args")).toThrow("array of strings");
    expect(boundedIntegerValue(undefined, "limit", 10, 5)).toBe(5);
    expect(() => boundedIntegerValue(11, "limit", 10, 5)).toThrow("between 1 and 10");
  });

  it("recognizes only canonical process result shapes", () => {
    expect(parseProcessResult(processResult())).toEqual(processResult());
    expect(parseProcessResult(null)).toBeUndefined();
    expect(parseProcessResult({ ...processResult(), extra: true })).toBeUndefined();
    expect(parseProcessResult({ ...processResult(), code: "0" })).toBeUndefined();
  });

  it("keeps process failures separate from domain warnings", () => {
    expect(semanticOutcome(processResult())).toBe("success");
    expect(semanticOutcome(processResult(), "warning")).toBe("warning");
    expect(semanticOutcome(processResult(1))).toBe("error");
    expect(semanticOutcome(processResult(1), "warning")).toBe("warning");
    expect(outcomeColor("warning")).toBe("warning");
    expect(nonemptyLines("one  \n\ntwo\n")).toEqual(["one", "two"]);
  });
});
