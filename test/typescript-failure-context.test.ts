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

  it("strips ANSI-colored stacks and bounds multiline root diagnostics", () => {
    const colored = structureTypeScriptFailure(
      new Error("root failure\n\u001b[31m    at colored (/tmp/file.ts:1:1)\u001b[0m"),
      [],
    );
    expect(colored.rootError).toBe("root failure");

    const multiline = Array.from({ length: 50 }, (_, index) => `diagnostic ${index}`).join("\n");
    const bounded = structureTypeScriptFailure(multiline, []);
    expect(bounded.rootError.split("\n")).toHaveLength(24);
    expect(Buffer.byteLength(bounded.rootError)).toBeLessThanOrEqual(8_000);
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
