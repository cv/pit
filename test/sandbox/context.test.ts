import { describe, expect, it } from "vitest";

import { parseFunctionExecutionContext } from "../../src/sandbox/executor.js";

describe("function execution wire context", () => {
  it.each(["global", "user", "project", "session"] as const)(
    "accepts bounded %s invocation context",
    (scope) => {
      expect(
        parseFunctionExecutionContext({
          invocationId: 2,
          parentInvocationId: 1,
          name: "nested",
          scope,
          depth: 2,
        }),
      ).toEqual({
        invocationId: 2,
        parentInvocationId: 1,
        name: "nested",
        scope,
        depth: 2,
      });
    },
  );

  it.each([
    undefined,
    null,
    [],
    {},
    { invocationId: 0, name: "x", scope: "project", depth: 1 },
    { invocationId: 1, name: "", scope: "project", depth: 1 },
    { invocationId: 1, name: "x", scope: "other", depth: 1 },
    { invocationId: 1, name: "x", scope: "session", depth: 33 },
    { invocationId: 1, parentInvocationId: 0, name: "x", scope: "session", depth: 1 },
  ])("rejects malformed context %#", (value) => {
    expect(parseFunctionExecutionContext(value)).toBeUndefined();
  });
});
