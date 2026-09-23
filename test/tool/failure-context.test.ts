import { describe, expect, it } from "vitest";

import {
  captureTypeScriptFailure,
  registerTypeScriptFailureEnrichment,
  structureTypeScriptFailure,
} from "../../src/tool/failure-context.js";

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

  it.each<{
    name: string;
    message: string;
    errorName?: string;
    kind: "cancelled" | "timeout" | "capability" | "user";
  }>([
    {
      name: "timeoutMs in a validation excerpt",
      message: "TypeScript validation failed:\ninput.timeoutMs.toUpperCase()",
      kind: "user",
    },
    {
      name: "AbortSignal in a validation excerpt",
      message: "TypeScript validation failed:\nAbortSignal is not defined",
      kind: "user",
    },
    {
      name: "timeout/cancel words in command arguments and stderr",
      message: "Command failed with exit code 1: node timeout-worker.js\nCould not read cancel.txt",
      kind: "capability",
    },
    {
      name: "timeout in a stack frame",
      message: "permission denied\n    at timeout (/tmp/abort.ts:1)",
      kind: "user",
    },
    { name: "timeout filename", message: "timeout.ts: unknown symbol", kind: "user" },
    { name: "aborted filename", message: "aborted.ts: unknown symbol", kind: "user" },
    {
      name: "undefined TimeoutError reference",
      message: "TimeoutError is not defined",
      kind: "user",
    },
    { name: "undefined AbortError reference", message: "AbortError is not defined", kind: "user" },
    {
      name: "subprocess deadline exit",
      message: "Command failed with exit code 124: node cancel.ts",
      kind: "timeout",
    },
    {
      name: "subprocess cancellation exit",
      message: "Command failed with exit code 130: node timeout.ts",
      kind: "cancelled",
    },
    {
      name: "tool deadline",
      message: "TypeScript execution timed out after 100ms",
      kind: "timeout",
    },
    { name: "tool cancellation", message: "TypeScript execution cancelled", kind: "cancelled" },
    {
      name: "cancelled removal",
      message: "User function removal was cancelled",
      kind: "cancelled",
    },
    {
      name: "cancelled model refresh",
      message: "Model catalog refresh was cancelled",
      kind: "cancelled",
    },
    {
      name: "typed timeout takes priority over abort wording",
      errorName: "TimeoutError",
      message: "The operation was aborted",
      kind: "timeout",
    },
    {
      name: "typed cancellation",
      errorName: "AbortError",
      message: "Request stopped",
      kind: "cancelled",
    },
    { name: "serialized timeout", message: "TimeoutError: request stopped", kind: "timeout" },
    { name: "serialized cancellation", message: "AbortError: request stopped", kind: "cancelled" },
    {
      name: "timeout cause survives an RPC error wrapper",
      message: "The operation was aborted due to timeout",
      kind: "timeout",
    },
  ])("classifies $name without scanning unrelated text", ({ message, errorName, kind }) => {
    const error = Object.assign(new Error(message), { name: errorName ?? "Error" });
    expect(structureTypeScriptFailure(error, [])).toMatchObject({ kind, rootError: message });
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

  it("sanitizes supplied stacks and bounds diagnostics with explicit head/tail retention", () => {
    const colored = structureTypeScriptFailure(
      new Error("root failure\n\u001b[31m    at colored (/tmp/file.ts:1:1)\u001b[0m"),
      [],
    );
    expect(colored.rootError).toBe("root failure\n    at colored (/tmp/file.ts:1:1)");

    const multiline = Array.from({ length: 50 }, (_, index) => `diagnostic ${index}`).join("\n");
    const bounded = structureTypeScriptFailure(multiline, []);
    expect(bounded.rootError.split("\n").length).toBeLessThanOrEqual(24);
    expect(bounded.rootError).toContain("diagnostic 49");
    expect(bounded.rootError).toContain("not retained");
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
