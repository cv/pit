import { describe, expect, it } from "vitest";
import {
  createFunctionState,
  createFunctionStateCommitQueue,
  effectiveRegistry,
  refreshEffectiveFunctions,
  resetFunctionUsage,
} from "../src/function-state.js";

describe("function state service", () => {
  it("creates isolated state and applies session precedence", () => {
    const state = createFunctionState();
    state.project.set("shared", "project");
    state.project.set("projectOnly", "project");
    state.session.set("shared", "session");
    refreshEffectiveFunctions(state);
    expect([...state.effective]).toEqual([
      ["shared", "session"],
      ["projectOnly", "project"],
    ]);
    expect(effectiveRegistry(state.project, state.session).get("shared")).toBe("session");
  });

  it("serializes async state transitions after failures", async () => {
    const commit = createFunctionStateCommitQueue();
    const order: string[] = [];
    const first = commit(async () => {
      order.push("first:start");
      await Promise.resolve();
      order.push("first:end");
      throw new Error("expected");
    });
    const second = commit(() => order.push("second"));
    await expect(first).rejects.toThrow("expected");
    await second;
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("resets in-memory usage state for reload and branch navigation", () => {
    const state = createFunctionState();
    state.sessionRunCounts.set("reusable", 4);
    state.promotionSuggested.add("suggested");

    resetFunctionUsage(state);

    expect(state.sessionRunCounts).toHaveLength(0);
    expect(state.promotionSuggested).toHaveLength(0);
  });
});
