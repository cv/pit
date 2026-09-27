import { describe, expect, it } from "vitest";

import { globalFunctionDefinitions } from "../../src/functions/globals.js";
import {
  functionResultRenderer,
  describeFunctionCall,
  inferFunctionCall,
} from "../../src/renderers/function-call.js";

describe("namespace presentation", () => {
  it("infers the first host call and resolves its TUI description", () => {
    const call = inferFunctionCall(
      'async ({ git, workspace }) => ({ status: await git.status(["--short"]), file: await workspace.read("README.md") })',
    );

    expect(call).toEqual({
      namespace: "git",
      method: "status",
      qualifiedName: "git.status",
    });
    expect(describeFunctionCall(call)).toBe("Inspect Git status");
  });

  it("falls back cleanly for missing and unknown presentations", () => {
    expect(inferFunctionCall("() => 42")).toBeUndefined();
    expect(describeFunctionCall(undefined)).toBeUndefined();
    expect(functionResultRenderer(undefined)).toBeUndefined();

    const unknown = inferFunctionCall("async ({ git }) => git.futureCommand()");
    expect(unknown?.qualifiedName).toBe("git.futureCommand");
    expect(describeFunctionCall(unknown)).toBeUndefined();
    expect(functionResultRenderer(unknown)).toBeUndefined();
  });

  it("derives labels and renderer routing for every registered method", () => {
    for (const definition of globalFunctionDefinitions()) {
      const call = {
        namespace: definition.namespace,
        method: definition.method,
        qualifiedName: definition.id,
      };
      expect(describeFunctionCall(call)).toBe(definition.summary);
      expect(functionResultRenderer(call)).toBe(definition.resultRenderer);
    }
  });
});
