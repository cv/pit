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
      promotionSuggestions: [],
    });
    expect(
      await handler({
        capability: "context",
        method: "get",
        args: [],
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
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
      promotionSuggestions: [],
    });
    expect(() =>
      handler({
        capability: "missing",
        method: "method",
        args: [],
        signal: new AbortController().signal,
      }),
    ).toThrow("Unknown capability or method");
  });

  it("suggests promotion once for durable session reuse", async () => {
    const functionState = createFunctionState();
    for (const name of ["reusableWorkflow", "releaseSmoke", "overrideWorkflow"]) {
      functionState.session.set(name, `async function ${name}() { return true; }`);
    }
    functionState.project.set(
      "projectWorkflow",
      "async function projectWorkflow() { return true; }",
    );
    functionState.project.set(
      "overrideWorkflow",
      "async function overrideWorkflow() { return false; }",
    );
    functionState.effective = new Map([...functionState.project, ...functionState.session]);
    const promotionSuggestions: string[] = [];
    const handler = createCapabilities({
      pi: {} as any,
      ctx: {} as any,
      functionState,
      commitFunctionState: createFunctionStateCommitQueue(),
      activity: [],
      promotionSuggestions,
    });
    const run = (name: string) =>
      handler({
        capability: "__pit",
        method: "savedFunctionRun",
        args: [name],
        signal: new AbortController().signal,
      });

    for (let index = 0; index < 6; index++) {
      await run("reusableWorkflow");
      await run("releaseSmoke");
      await run("projectWorkflow");
      await run("overrideWorkflow");
    }

    expect(promotionSuggestions).toEqual(["reusableWorkflow"]);
    expect(functionState.sessionRunCounts).toEqual(new Map([["reusableWorkflow", 6]]));
    expect(functionState.promotionSuggested).toEqual(new Set(["reusableWorkflow"]));
  });
});
