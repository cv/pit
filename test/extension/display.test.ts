import { describe, expect, it } from "vitest";

import { display } from "../../src/tool/typescript.js";

describe("display", () => {
  it("falls back when a value cannot be stringified", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(display(circular)).toBe("[object Object]");
  });
});
