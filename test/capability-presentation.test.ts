import { describe, expect, it } from "vitest";
import {
  capabilityResultRenderer,
  describeCapabilityCall,
  inferCapabilityCall,
} from "../src/capability-presentation.js";
import { CAPABILITY_REGISTRY } from "../src/capability-registry.js";

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
    for (const [capability, definition] of Object.entries(CAPABILITY_REGISTRY)) {
      for (const [method, methodDefinition] of Object.entries(definition.methods)) {
        const call = {
          capability,
          method,
          qualifiedName: `${capability}.${method}`,
        };
        expect(describeCapabilityCall(call), call.qualifiedName).toBe(
          methodDefinition.callDescription,
        );
        expect(capabilityResultRenderer(call), call.qualifiedName).toBe(
          "resultRenderer" in methodDefinition ? methodDefinition.resultRenderer : undefined,
        );
      }
    }
  });
});
