import { describe, expect, it } from "vitest";

import {
  processOutputLines,
  parseProcessResult,
  sanitizeProcessText,
  semanticOutcome,
} from "../../src/process/results.js";

const processResult = (code = 0) => ({ stdout: "ok", stderr: "", code, truncated: false });

describe("process results", () => {
  it("recognizes only canonical process result shapes", () => {
    expect(parseProcessResult(processResult())).toEqual(processResult());
    expect(parseProcessResult(null)).toBeUndefined();
    expect(parseProcessResult({ ...processResult(), extra: true })).toBeUndefined();
    expect(parseProcessResult({ ...processResult(), code: "0" })).toBeUndefined();
  });

  it("sanitizes returned streams once for display", () => {
    const result = parseProcessResult({
      stdout: "\u001b]0;title\u0007\u001b[31mred\u001b[39m\r\nnext\r\n",
      stderr: "\u0007warn\u0000\n",
      code: 0,
      truncated: false,
    });
    expect(result).toEqual({
      stdout: "\u001b[31mred\u001b[39m\nnext\n",
      stderr: "warn\n",
      code: 0,
      truncated: false,
    });
    expect(result && processOutputLines(result.stdout)).toEqual([
      "\u001b[31mred\u001b[39m",
      "next",
    ]);
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
    expect(processOutputLines(sanitizeProcessText("one  \n\ntwo\n"))).toEqual(["one  ", "", "two"]);
  });
});
