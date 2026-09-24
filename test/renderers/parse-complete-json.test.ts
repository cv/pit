import { describe, expect, it } from "vitest";

import { parseCompleteJson } from "../../src/renderers/shared.js";

describe("parseCompleteJson", () => {
  it.each<{
    name: string;
    text: string;
    truncated: boolean;
    requireContainer?: boolean;
    expected: unknown;
  }>([
    { name: "a complete object", text: '{"a":[1,2]}', truncated: false, expected: { a: [1, 2] } },
    {
      name: "a padded array",
      text: "\n  [true]\n",
      truncated: false,
      requireContainer: true,
      expected: [true],
    },
    { name: "a scalar when containers are optional", text: "42", truncated: false, expected: 42 },
    {
      name: "a parsed null, distinct from unavailable",
      text: "null",
      truncated: false,
      expected: null,
    },
    {
      name: "truncated text that happens to parse",
      text: '{"a":1}',
      truncated: true,
      expected: undefined,
    },
    {
      name: "a scalar when a container is required",
      text: "42",
      truncated: false,
      requireContainer: true,
      expected: undefined,
    },
    { name: "malformed JSON", text: '{"a":', truncated: false, expected: undefined },
    { name: "plain text", text: "not json", truncated: false, expected: undefined },
  ])("returns $expected for $name", ({ text, truncated, requireContainer, expected }) => {
    expect(
      parseCompleteJson(text, { truncated, ...(requireContainer ? { requireContainer } : {}) }),
    ).toEqual(expected);
  });
});
