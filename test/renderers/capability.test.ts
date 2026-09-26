import { describe, expect, it } from "vitest";

import { globalFunctionDefinitions } from "../../src/functions/native.js";
import {
  capabilityResultRenderer,
  describeCapabilityCall,
  inferCapabilityCall,
} from "../../src/renderers/capability.js";

describe("capability presentation", () => {
  it("infers the first capability call and resolves its TUI description", () => {
    const call = inferCapabilityCall(
      'async ({ git, workspace }) => ({ status: await git.status(["--short"]), file: await workspace.read("README.md") })',
    );

    expect(call).toEqual({
      capability: "git",
      method: "status",
      qualifiedName: "git.status",
    });
    expect(describeCapabilityCall(call)).toBe("Inspect Git status");
  });

  it("falls back cleanly for missing and unknown presentations", () => {
    expect(inferCapabilityCall("() => 42")).toBeUndefined();
    expect(describeCapabilityCall(undefined)).toBeUndefined();
    expect(capabilityResultRenderer(undefined)).toBeUndefined();

    const unknown = inferCapabilityCall("async ({ git }) => git.futureCommand()");
    expect(unknown?.qualifiedName).toBe("git.futureCommand");
    expect(describeCapabilityCall(unknown)).toBeUndefined();
    expect(capabilityResultRenderer(unknown)).toBeUndefined();
  });

  it("derives labels and renderer routing for every registered method", () => {
    for (const definition of globalFunctionDefinitions()) {
      const call = {
        capability: definition.capability,
        method: definition.method,
        qualifiedName: definition.id,
      };
      expect(describeCapabilityCall(call)).toBe(definition.summary);
      expect(capabilityResultRenderer(call)).toBe(definition.resultRenderer);
    }
  });
});
