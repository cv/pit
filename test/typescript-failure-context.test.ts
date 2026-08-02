import { describe, expect, it } from "vitest";
import {
  captureTypeScriptFailure,
  registerTypeScriptFailureEnrichment,
  structureTypeScriptFailure,
} from "../src/typescript-failure-context.js";

describe("TypeScript failure context", () => {
  it.each([
    ["operation cancelled", "cancelled"],
    ["sandbox timed out after 10ms", "timeout"],
    ["Command failed with exit code 1", "capability"],
    ["plain user error", "user"],
  ] as const)("classifies %s", (message, kind) => {
    expect(structureTypeScriptFailure(new Error(message), [])).toMatchObject({
      functionPath: [],
      rootError: message,
      kind,
    });
  });

  it("uses bounded activity names without retaining arguments or results", () => {
    const activity = Array.from({ length: 40 }, (_, index) => ({
      action: "run" as const,
      name: `function${index}`,
      scope: "session" as const,
    }));
    const failure = structureTypeScriptFailure("failed", activity);
    expect(failure.functionPath).toHaveLength(32);
    expect(JSON.stringify(failure)).not.toContain("arguments");
    expect(JSON.stringify(failure)).not.toContain("results");
  });

  it("ignores unrelated and missing tool result contexts", () => {
    let handler: ((event: any) => unknown) | undefined;
    registerTypeScriptFailureEnrichment(
      {
        on: (_event: string, callback: (event: any) => unknown) => {
          handler = callback;
        },
      } as any,
      new Map(),
    );
    expect(handler?.({ toolName: "other", isError: true, toolCallId: "x" })).toBeUndefined();
    expect(handler?.({ toolName: "typescript", isError: true, toolCallId: "x" })).toBeUndefined();

    const pending = new Map([["x", captureTypeScriptFailure(new Error("boom"), [], {})]]);
    registerTypeScriptFailureEnrichment(
      {
        on: (_event: string, callback: (event: any) => unknown) => {
          handler = callback;
        },
      } as any,
      pending,
    );
    expect(handler?.({ toolName: "typescript", isError: true, toolCallId: "x" })).toMatchObject({
      details: { failure: { rootError: "boom" } },
    });
    expect(pending).toHaveLength(0);
  });
});
