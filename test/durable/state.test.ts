import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { conversationCwd } from "../../src/durable/host.js";
import { DurableEntryWrites, DurableFunctionStore } from "../../src/durable/state.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pit-durable-state-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function definition(id: number, name: string) {
  return {
    id,
    kind: "pit-function-definitions",
    data: { name, source: `async function ${name}({}) { return "${name}"; }` },
  };
}

/** A tool API whose conversation history is `pages`, served one page per scan. */
function historyApi(conversationId: number, pages: unknown[][]) {
  const scans: unknown[] = [];
  const commit = vi.fn(async (change: (tx: any) => unknown) =>
    change({
      scanEntries: async (query: unknown, _limit: number, cursor?: number) => {
        scans.push({ query, cursor });
        const index = cursor ?? 0;
        return {
          items: pages[index] ?? [],
          ...(index + 1 < pages.length ? { next: index + 1 } : {}),
        };
      },
    }),
  );
  return { api: { conversationId: conversationId as any, commit: commit as any }, scans, commit };
}

function store() {
  return new DurableFunctionStore({ agentDir: join(root, "agent"), trustProject: false });
}

describe("DurableFunctionStore", () => {
  it("replays session functions from every page of the conversation's history", async () => {
    const { api, scans } = historyApi(1, [
      [definition(1, "first"), { id: 2, kind: "pi.user" }],
      [definition(3, "second")],
    ]);
    const functions = await store().forCall(api, context, root);
    expect([...functions.functionState.session.keys()]).toEqual(["first", "second"]);
    // Each page continues the same ascending scan.
    expect(scans).toEqual([
      { query: { conversationId: 1, order: "ascending" }, cursor: undefined },
      { query: { conversationId: 1, order: "ascending" }, cursor: 1 },
    ]);
  });

  it("replays a conversation once and retries a failed read on the next call", async () => {
    const functions = store();
    const { api, commit } = historyApi(1, [[definition(1, "kept")]]);
    commit.mockRejectedValueOnce(new Error("storage offline"));
    await expect(functions.forCall(api, context, root)).rejects.toThrow("storage offline");
    const loaded = await functions.forCall(api, context, root);
    await functions.forCall(api, context, root);
    expect([...loaded.functionState.session.keys()]).toEqual(["kept"]);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("reloads the least recently used conversation after 64 others", async () => {
    const functions = store();
    const first = historyApi(0, [[definition(1, "early")]]);
    await functions.forCall(first.api, context, root);
    for (let id = 1; id <= 64; id++) {
      await functions.forCall(historyApi(id, [[]]).api, context, root);
    }
    const reloaded = await functions.forCall(first.api, context, root);
    expect(first.commit).toHaveBeenCalledTimes(2);
    expect([...reloaded.functionState.session.keys()]).toEqual(["early"]);
  });
});

describe("DurableEntryWrites", () => {
  it("writes in order and stops after the first failure", async () => {
    const written: string[] = [];
    const writes = new DurableEntryWrites(async (_type, data: any) => {
      if (data.name === "broken") throw new Error("write rejected");
      written.push(data.name);
    });
    writes.append("pit-function-definitions", { name: "one" });
    writes.append("pit-function-definitions", { name: "broken" });
    writes.append("pit-function-definitions", { name: "after" });
    await expect(writes.settle()).rejects.toThrow("write rejected");
    expect(written).toEqual(["one"]);
  });
});

describe("conversationCwd", () => {
  it.each([
    ["the host's override", "/override", { cwd: "/env" }, { cwd: "/agent" }, "/override"],
    ["the execution environment", undefined, { cwd: "/env" }, { cwd: "/agent" }, "/env"],
    ["the agent", undefined, undefined, { cwd: "/agent" }, "/agent"],
    ["the process", undefined, undefined, {}, process.cwd()],
  ])("prefers %s", (_name, override, environment, agent, expected) => {
    expect(conversationCwd(override, environment, agent)).toBe(expected);
  });
});
