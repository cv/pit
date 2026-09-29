import { describe, expect, it } from "vitest";

import { createFunctionState, createFunctionStateCommitQueue } from "../../src/functions/state.js";
import { createHostDispatcher } from "../../src/host/dispatcher.js";

describe("host namespace router", () => {
  it.each<{ name: string; namespace: string; method: string }>([
    { name: "unknown function", namespace: "missing", method: "method" },
    { name: "Git source wrapper", namespace: "git", method: "status" },
    { name: "npm source wrapper", namespace: "npm", method: "test" },
    { name: "GitHub source wrapper", namespace: "gh", method: "api" },
  ])("rejects direct host dispatch to $name", ({ namespace, method }) => {
    const handler = createHostDispatcher({
      pi: {} as any,
      ctx: {} as any,
      functionState: createFunctionState(),
      commitFunctionState: createFunctionStateCommitQueue(),
      activity: [],
      promotionSuggestions: [],
      imageAttachments: [],
      imageMetadata: [],
    });
    expect(() =>
      handler({
        namespace,
        method,
        args: [],
        signal: new AbortController().signal,
      }),
    ).toThrow("Unknown host function");
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
    const handler = createHostDispatcher({
      pi: {} as any,
      ctx: {} as any,
      functionState,
      commitFunctionState: createFunctionStateCommitQueue(),
      activity: [],
      promotionSuggestions,
      imageAttachments: [],
      imageMetadata: [],
    });
    const run = (name: string) =>
      handler({
        namespace: "__pit",
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
