import { describe, expect, it } from "vitest";
import { createFunctionState, createFunctionStateCommitQueue } from "../src/function-state.js";
import { createCapabilities } from "../src/host-capabilities.js";

describe("host capability router", () => {
  it("serves runtime context from explicit services", async () => {
    const functionState = createFunctionState();
    functionState.projectEnabled = true;
    functionState.project.set("projectFn", "source");
    functionState.session.set("sessionFn", "source");
    functionState.effective = new Map([...functionState.project, ...functionState.session]);
    const handler = createCapabilities({
      pi: {} as any,
      ctx: {
        cwd: "/project",
        mode: "tui",
        model: { provider: "test", id: "model" },
        thinkingLevel: "medium",
        sessionManager: { getSessionFile: () => "/session.jsonl" },
      } as any,
      functionState,
      commitFunctionState: createFunctionStateCommitQueue(),
      activity: [],
    });
    expect(await handler("context", "get", [], new AbortController().signal)).toMatchObject({
      cwd: "/project",
      savedFunctions: ["projectFn", "sessionFn"],
      projectFunctions: ["projectFn"],
      sessionFunctions: ["sessionFn"],
      projectFunctionsEnabled: true,
    });
  });

  it("rejects unknown calls before routing", () => {
    const handler = createCapabilities({
      pi: {} as any,
      ctx: {} as any,
      functionState: createFunctionState(),
      commitFunctionState: createFunctionStateCommitQueue(),
      activity: [],
    });
    expect(() => handler("missing", "method", [], new AbortController().signal)).toThrow(
      "Unknown capability or method",
    );
  });
});
