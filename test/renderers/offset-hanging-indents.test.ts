import { describe, expect, it } from "vitest";

import { offsetHangingIndents } from "../../src/renderers/shared.js";

describe("offsetHangingIndents", () => {
  it.each<{
    name: string;
    indents: Record<number, number> | undefined;
    options: Parameters<typeof offsetHangingIndents>[1];
    expected: Record<number, number>;
  }>([
    { name: "no nested indents", indents: undefined, options: { lines: 3 }, expected: {} },
    { name: "an unchanged copy", indents: { 0: 4 }, options: {}, expected: { 0: 4 } },
    {
      name: "nesting under a header and indent",
      indents: { 0: 4, 2: 6 },
      options: { lines: 5, columns: 2 },
      expected: { 5: 6, 7: 8 },
    },
    {
      name: "a detail view without its header",
      indents: { 1: 2, 3: 4 },
      options: { lines: -1 },
      expected: { 0: 2, 2: 4 },
    },
    {
      name: "only the lines shown in a prefix",
      indents: { 0: 2, 1: 3, 2: 4 },
      options: { lines: 10, before: 2 },
      expected: { 10: 2, 11: 3 },
    },
  ])("produces $expected for $name", ({ indents, options, expected }) => {
    expect(offsetHangingIndents(indents, options)).toEqual(expected);
  });

  it("returns a new map without changing the nested one", () => {
    const nested = { 1: 2 };
    const shifted = offsetHangingIndents(nested, { lines: 1 });
    expect(shifted).toEqual({ 2: 2 });
    expect(nested).toEqual({ 1: 2 });
  });
});
