import { describe, expect, it } from "vitest";

import type { CapabilityTrace } from "../../src/execution/capability-trace.js";
import { CapabilityDispatcher } from "../../src/sandbox/dispatcher.js";

describe("CapabilityDispatcher", () => {
  it("dispatches bounded calls and reports successful traces", async () => {
    const sent: unknown[] = [];
    const traces: CapabilityTrace[] = [];
    const dispatcher = new CapabilityDispatcher({
      handler: async ({ args }) => ({ echoed: args[0] }),
      signal: new AbortController().signal,
      maximumCalls: 2,
      maximumConcurrentCalls: 2,
      send: (message) => {
        sent.push(message);
        return true;
      },
      parseFunctionContext: () => undefined,
      onTrace: (trace) => traces.push(trace),
    });
    dispatcher.handle({ type: "call", id: 1, capability: "context", method: "get", args: [42] });
    await Promise.all(dispatcher.pending());
    expect(sent).toEqual([{ type: "response", id: 1, value: { echoed: 42 } }]);
    expect(traces.map((trace) => trace.status)).toEqual(["running", "succeeded"]);
  });

  it("rejects calls beyond the total limit", () => {
    const sent: unknown[] = [];
    const dispatcher = new CapabilityDispatcher({
      handler: async () => null,
      signal: new AbortController().signal,
      maximumCalls: 0,
      maximumConcurrentCalls: 1,
      send: (message) => {
        sent.push(message);
        return true;
      },
      parseFunctionContext: () => undefined,
    });
    dispatcher.handle({ type: "call", id: 1, capability: "context", method: "get", args: [] });
    expect(sent).toEqual([{ type: "response", id: 1, error: "RPC call limit exceeded (0)" }]);
  });

  it("rejects calls outside the resolved function grant", () => {
    const sent: unknown[] = [];
    const traces: CapabilityTrace[] = [];
    const dispatcher = new CapabilityDispatcher({
      handler: async () => null,
      signal: new AbortController().signal,
      maximumCalls: 10,
      maximumConcurrentCalls: 2,
      allowedCalls: new Set(["workspace.read"]),
      send: (message) => {
        sent.push(message);
        return true;
      },
      parseFunctionContext: () => undefined,
      onTrace: (trace) => traces.push(trace),
    });

    dispatcher.handle({ type: "call", id: 1, capability: "shell", method: "exec", args: [] });
    expect(sent).toEqual([
      { type: "response", id: 1, error: "Function grant does not allow shell.exec" },
    ]);
    expect(traces.map(({ status }) => status)).toEqual(["running", "rejected"]);
  });
});
