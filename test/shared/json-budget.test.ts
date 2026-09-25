import { describe, expect, it } from "vitest";

import { LIMITS, sliceText } from "../../src/shared/bounds.js";
import { fitValue } from "../../src/shared/json-budget.js";

const budget = LIMITS.result;
const withinBudget = (text: string) => {
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(budget.maxBytes);
  expect(text.split("\n").length).toBeLessThanOrEqual(budget.maxLines);
};

describe("fitValue", () => {
  it("keeps a capability-bounded process result as valid JSON with every field", () => {
    const output = Array.from({ length: 3_000 }, (_, index) => `line ${index} ${"x".repeat(20)}`);
    // The capability already kept the 50 KB tail; the result must not collapse to "{".
    const stdout = sliceText(output.join("\n"), LIMITS.processStream, "tail").text;
    const fitted = fitValue({ stdout, stderr: "boom", code: 3, truncated: true }, budget);
    const parsed = JSON.parse(fitted.text);

    withinBudget(fitted.text);
    expect(fitted.truncated).toBe(true);
    expect(parsed).toEqual(fitted.value);
    expect(parsed).toMatchObject({ stderr: "boom", code: 3, truncated: true });
    expect(parsed.stdout).toMatch(/\n… \d+ lines omitted …\n/);
    expect(parsed.stdout.endsWith("line 2999 xxxxxxxxxxxxxxxxxxxx")).toBe(true);
  });

  it("marks an enclosing truncated flag when a nested string was shortened", () => {
    const fitted = fitValue(
      { label: "build", result: { stdout: "y".repeat(200_000), truncated: false } },
      budget,
    );
    expect(fitted.value).toMatchObject({ label: "build", result: { truncated: true } });
  });

  it("keeps both ends of an oversized top-level string", () => {
    const fitted = fitValue(`${"a".repeat(100_000)}${"z".repeat(100_000)}`, budget);
    const [head, marker, tail] = fitted.text.split("\n");

    withinBudget(fitted.text);
    expect(fitted).toMatchObject({ truncated: true, value: fitted.text });
    expect(head).toMatch(/^a+$/);
    expect(marker).toMatch(/^… \d+ bytes omitted …$/);
    expect(tail).toMatch(/^z+$/);
  });

  it("keeps both ends of arrays that exceed the line budget", () => {
    const items = Array.from({ length: 3_000 }, (_, index) => index);
    const fitted = fitValue({ items, count: items.length }, budget);
    const parsed = JSON.parse(fitted.text);
    const marker = parsed.items.find((item: unknown) => typeof item === "string");
    const kept = parsed.items.filter((item: unknown) => typeof item === "number");

    withinBudget(fitted.text);
    expect(parsed.count).toBe(3_000);
    expect([kept[0], kept.at(-1)]).toEqual([0, 2_999]);
    expect(marker).toBe(`… ${3_000 - kept.length} items omitted …`);
  });

  it("returns values within budget unchanged", () => {
    const value = { ok: true, list: [1, 2, 3] };
    expect(fitValue(value, budget)).toEqual({
      text: JSON.stringify(value, null, 2),
      value,
      truncated: false,
    });
  });

  it("falls back to marked text when nesting alone exceeds the budget", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 1_500; depth++) nested = [nested];
    const fitted = fitValue(nested, budget);

    withinBudget(fitted.text);
    expect(fitted).toMatchObject({ value: undefined, truncated: true });
    expect(fitted.text).toMatch(/… \d+ lines omitted …/);
  });
});
