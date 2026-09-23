import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupHarness,
  context,
  cwd,
  getAllTools,
  sessionStart,
  setActiveTools,
  setupHarness,
} from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

async function configure(config: unknown): Promise<void> {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi/pit.json"), JSON.stringify(config));
}

const available = [
  "typescript",
  "read",
  "bash",
  "goal_complete",
  "goal_blocked",
  "goal_wait",
  "subagent",
  "not_goal_complete",
  "goal.[x]+?",
];

beforeEach(() => {
  getAllTools.mockReturnValue(available.map((name) => ({ name })));
});

describe("allowed tool exceptions", () => {
  it.each<{ name: string; config: unknown; expected: string[] }>([
    { name: "omitted", config: {}, expected: [] },
    { name: "empty", config: { allowedTools: [] }, expected: [] },
    { name: "exact", config: { allowedTools: ["goal_complete"] }, expected: ["goal_complete"] },
    {
      name: "prefix wildcard without project functions enabled",
      config: { allowedTools: ["goal_*"] },
      expected: ["goal_complete", "goal_blocked", "goal_wait"],
    },
    {
      name: "overlapping patterns do not duplicate tools",
      config: { allowedTools: ["typescript", "goal_*", "goal_complete", "goal_*"] },
      expected: ["goal_complete", "goal_blocked", "goal_wait"],
    },
    {
      name: "unavailable or Pi-excluded tool",
      config: { allowedTools: ["goal_missing"] },
      expected: [],
    },
    { name: "case sensitive", config: { allowedTools: ["GOAL_*"] }, expected: [] },
    { name: "whole name", config: { allowedTools: ["goal"] }, expected: [] },
    {
      name: "literal regex punctuation",
      config: { allowedTools: ["goal.[x]+?"] },
      expected: ["goal.[x]+?"],
    },
    { name: "explicit builtin exception", config: { allowedTools: ["read"] }, expected: ["read"] },
    {
      name: "explicit wildcard for all tools",
      config: { allowedTools: ["*"] },
      expected: available.slice(1),
    },
  ])("selects only configured exceptions: $name", async ({ config, expected }) => {
    await configure(config);
    await sessionStart({}, context());
    expect(setActiveTools).toHaveBeenLastCalledWith(["typescript", ...expected]);
  });

  it.each<{ name: string; allowedTools: unknown }>([
    { name: "string", allowedTools: "goal_*" },
    { name: "null", allowedTools: null },
    { name: "boolean", allowedTools: true },
    { name: "object", allowedTools: {} },
    { name: "non-string member", allowedTools: ["goal_*", 1] },
    { name: "empty pattern", allowedTools: [""] },
    { name: "blank pattern", allowedTools: [" "] },
  ])("fails closed for invalid configuration: $name", async ({ allowedTools }) => {
    await configure({ allowedTools });
    const ctx = context();
    await sessionStart({}, ctx);
    expect(setActiveTools).toHaveBeenLastCalledWith(["typescript"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("allowedTools must be"),
      "warning",
    );
  });

  it("ignores exceptions in untrusted projects", async () => {
    await configure({ allowedTools: ["*"] });
    await sessionStart({}, context({ isProjectTrusted: () => false }));
    expect(setActiveTools).toHaveBeenLastCalledWith(["typescript"]);
    expect(getAllTools).not.toHaveBeenCalled();
  });

  it("re-reads exceptions at session startup and removes revoked exceptions", async () => {
    await configure({ allowedTools: ["goal_*"] });
    await sessionStart({}, context());
    expect(setActiveTools).toHaveBeenLastCalledWith([
      "typescript",
      "goal_complete",
      "goal_blocked",
      "goal_wait",
    ]);
    await configure({ allowedTools: [] });
    await sessionStart({}, context());
    expect(setActiveTools).toHaveBeenLastCalledWith(["typescript"]);
  });
});
