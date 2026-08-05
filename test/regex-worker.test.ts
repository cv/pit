import { afterEach, describe, expect, it } from "vitest";

import { InterruptibleRegexMatcher } from "../src/regex-worker.js";

const active: InterruptibleRegexMatcher[] = [];
const matcher = (query: string, caseSensitive = true) => {
  const value = new InterruptibleRegexMatcher(query, caseSensitive);
  active.push(value);
  return value;
};

afterEach(async () => {
  await Promise.all(active.splice(0).map((value) => value.close()));
});

describe("InterruptibleRegexMatcher", () => {
  it("matches lines with limits, case folding, and zero-length progress", async () => {
    const sensitive = matcher("needle");
    await expect(sensitive.match(["needle needle", "NEEDLE"], 1)).resolves.toEqual([
      { lineIndex: 0, column: 0 },
    ]);
    await expect(sensitive.match([], 0)).resolves.toEqual([]);

    const insensitive = matcher("^", false);
    await expect(insensitive.match(["One", "Two"], 10)).resolves.toEqual([
      { lineIndex: 0, column: 0 },
      { lineIndex: 1, column: 0 },
    ]);
  });

  it("rejects invalid worker expressions and calls after close", async () => {
    const invalid = matcher("[");
    await expect(invalid.match(["value"], 1)).rejects.toThrow();

    const closed = matcher("x");
    await closed.close();
    await closed.close();
    await expect(closed.match(["x"], 1)).rejects.toThrow("closed");
  });

  it("rejects pending work on close and ignores stale responses", async () => {
    const value = matcher("^(a+)+$");
    const pending = value.match([`${"a".repeat(30_000)}!`], 1);
    const rejection = expect(pending).rejects.toThrow("closed");
    (value as any).handleMessage({ id: "invalid" });
    (value as any).handleMessage({ id: 999, matches: [] });
    await value.close();
    await rejection;
  });

  it("validates worker responses", async () => {
    const withError = matcher("^(a+)+$");
    const rejected = withError.match([`${"a".repeat(30_000)}!`], 1);
    const workerFailure = expect(rejected).rejects.toThrow("worker failure");
    (withError as any).handleMessage({ id: 1, error: "worker failure" });
    await workerFailure;

    const malformed = matcher("^(a+)+$");
    const invalid = malformed.match([`${"a".repeat(30_000)}!`], 1);
    const invalidResponse = expect(invalid).rejects.toThrow("invalid response");
    (malformed as any).handleMessage({ id: 1, matches: "invalid" });
    await invalidResponse;
  });
});
