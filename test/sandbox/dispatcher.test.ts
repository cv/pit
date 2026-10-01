import { describe, expect, it } from "vitest";

import type { HostCallTrace } from "../../src/execution/host-call-trace.js";
import { HostCallDispatcher } from "../../src/sandbox/dispatcher.js";
import { terminationError } from "../../src/shared/termination-errors.js";

describe("HostCallDispatcher", () => {
  it("dispatches bounded calls and reports successful traces", async () => {
    const sent: unknown[] = [];
    const traces: HostCallTrace[] = [];
    const dispatcher = new HostCallDispatcher({
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
    dispatcher.handle({ type: "call", id: 1, namespace: "context", method: "get", args: [42] });
    await Promise.all(dispatcher.pending());
    expect(sent).toEqual([{ type: "response", id: 1, value: { echoed: 42 } }]);
    expect(traces.map((trace) => trace.status)).toEqual(["running", "succeeded"]);
  });

  it("rejects calls beyond the total limit", () => {
    const sent: unknown[] = [];
    const dispatcher = new HostCallDispatcher({
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
    dispatcher.handle({ type: "call", id: 1, namespace: "context", method: "get", args: [] });
    expect(sent).toEqual([{ type: "response", id: 1, error: "RPC call limit exceeded (0)" }]);
  });

  it("rejects calls outside the resolved function grant", () => {
    const sent: unknown[] = [];
    const traces: HostCallTrace[] = [];
    const dispatcher = new HostCallDispatcher({
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

    dispatcher.handle({ type: "call", id: 1, namespace: "shell", method: "exec", args: [] });
    expect(sent).toEqual([
      { type: "response", id: 1, error: "Function grant does not allow shell.exec" },
    ]);
    expect(traces.map(({ status }) => status)).toEqual(["running", "rejected"]);
  });

  it.each<{ name: string; error: unknown; response: Record<string, unknown> }>([
    {
      name: "a Pit termination",
      error: terminationError("timeout", "deadline reached"),
      response: { error: "deadline reached", errorName: "TimeoutError" },
    },
    {
      name: "a platform abort",
      error: new DOMException("This operation was aborted", "AbortError"),
      response: { error: "This operation was aborted", errorName: "AbortError" },
    },
    {
      name: "a plain error",
      error: new Error("permission denied"),
      response: { error: "permission denied" },
    },
    { name: "a non-Error value", error: "raw failure", response: { error: "raw failure" } },
  ])("returns $name to the guest with its non-default name", async ({ error, response }) => {
    const sent: unknown[] = [];
    const dispatcher = new HostCallDispatcher({
      handler: async () => {
        throw error;
      },
      signal: new AbortController().signal,
      maximumCalls: 1,
      maximumConcurrentCalls: 1,
      send: (message) => {
        sent.push(message);
        return true;
      },
      parseFunctionContext: () => undefined,
    });
    dispatcher.handle({ type: "call", id: 1, namespace: "context", method: "get", args: [] });
    await Promise.all(dispatcher.pending());
    expect(sent).toEqual([{ type: "response", id: 1, ...response }]);
  });

  it.each<{ name: string; end: "cancel" | "timeout" | null; status: HostCallTrace["status"] }>([
    { name: "cancelling the program", end: "cancel", status: "cancelled" },
    { name: "the program's timeout", end: "timeout", status: "timed out" },
    { name: "its own timeout while the program runs", end: null, status: "failed" },
  ])("records a call rejected by $name as $status", async ({ end, status }) => {
    const controller = new AbortController();
    const traces: HostCallTrace[] = [];
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const dispatcher = new HostCallDispatcher({
      handler: ({ signal }) => {
        started();
        return end === null
          ? Promise.reject(terminationError("timeout", "request timed out"))
          : new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
      },
      signal: controller.signal,
      maximumCalls: 1,
      maximumConcurrentCalls: 1,
      send: () => true,
      parseFunctionContext: () => undefined,
      onTrace: (trace) => traces.push(trace),
    });
    dispatcher.handle({ type: "call", id: 1, namespace: "tools", method: "slow", args: [] });
    await running;
    if (end === "cancel") controller.abort();
    if (end === "timeout")
      controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    await Promise.all(dispatcher.pending());
    expect(traces.map((trace) => trace.status)).toEqual(["running", status]);
  });
});
