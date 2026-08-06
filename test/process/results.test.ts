import { describe, expect, it } from "vitest";

import { nonemptyLines, parseProcessResult, semanticOutcome } from "../../src/process/results.js";

const processResult = (code = 0) => ({ stdout: "ok", stderr: "", code, truncated: false });

describe("process results", () => {
  it("recognizes only canonical process result shapes", () => {
    expect(parseProcessResult(processResult())).toEqual(processResult());
    expect(parseProcessResult(null)).toBeUndefined();
    expect(parseProcessResult({ ...processResult(), extra: true })).toBeUndefined();
    expect(parseProcessResult({ ...processResult(), code: "0" })).toBeUndefined();
  });

  it("keeps process failures separate from domain warnings", () => {
    expect(semanticOutcome(processResult())).toBe("success");
    expect(semanticOutcome(processResult(), { domainOutcome: "warning" })).toBe("warning");
    expect(semanticOutcome(processResult(1))).toBe("error");
    expect(semanticOutcome(processResult(1), { domainOutcome: "warning" })).toBe("error");
    expect(
      semanticOutcome(processResult(1), {
        domainOutcome: "warning",
        acceptedExitCodes: [1],
      }),
    ).toBe("warning");
    expect(nonemptyLines("one  \n\ntwo\n")).toEqual(["one", "two"]);
  });
});
