import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ToolExposure, ToolLoadout } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupHarness,
  context,
  cwd,
  getActiveTools,
  getAllTools,
  sessionStart,
  sessionTree,
  setActiveTools,
  setupHarness,
  tool,
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
  getAllTools.mockReturnValue(available.map((name) => ({ name, exposure: "direct" })));
});

interface LoadoutTool {
  name: string;
  exposure: ToolExposure;
  namespace?: string;
}

/** A session's active tools as Pi hands them to `prepareLoadout()`. */
function loadout(tools: LoadoutTool[]): ToolLoadout {
  const byName = new Map(tools.map((entry) => [entry.name, entry]));
  const agentTools = tools.map(({ name }) => ({ name })) as unknown as ToolLoadout["declared"];
  return {
    declared: agentTools,
    callable: agentTools,
    registered: agentTools,
    getExposure: (name) => byName.get(name)?.exposure ?? "direct",
    getNamespace: (name) => {
      const namespace = byName.get(name)?.namespace;
      return namespace ? { name: namespace } : undefined;
    },
  };
}

const declaredTools: LoadoutTool[] = [
  { name: "typescript", exposure: "model-only" },
  { name: "read", exposure: "direct" },
  { name: "goal_complete", exposure: "direct" },
  { name: "codemode", exposure: "model-only" },
  { name: "tool_search", exposure: "model-only" },
  { name: "mcp__docs__search", exposure: "direct", namespace: "mcp__docs" },
  { name: "mcp__docs__loaded", exposure: "deferred", namespace: "mcp__docs" },
  { name: "mcp__docs__listed", exposure: "codemode", namespace: "mcp__docs" },
  { name: "helper", exposure: "direct", namespace: "helpers" },
];

describe("allowed tool exceptions", () => {
  it("registers typescript as an orchestrator that other tools cannot call", () => {
    expect(tool.exposure).toBe("model-only");
  });

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
  ])("activates only configured exceptions: $name", async ({ config, expected }) => {
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
    expect(tool.prepareLoadout?.(loadout([{ name: "goal_complete", exposure: "direct" }]))).toEqual(
      { hiddenDeclarations: ["goal_complete"] },
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("allowedTools must be"),
      "warning",
    );
  });

  it("ignores exceptions in untrusted projects", async () => {
    await configure({ allowedTools: ["*"] });
    await sessionStart({}, context({ isProjectTrusted: () => false }));
    expect(setActiveTools).toHaveBeenLastCalledWith(["typescript"]);
    expect(tool.prepareLoadout?.(loadout([{ name: "read", exposure: "direct" }]))).toEqual({
      hiddenDeclarations: ["read"],
    });
  });

  it.each<{ name: string; tools: object[]; warns: boolean }>([
    { name: "Pi without loadouts", tools: [{ name: "read" }], warns: true },
    { name: "Pi 0.99", tools: [{ name: "read", exposure: "direct" }], warns: false },
  ])("warns once at startup when hiding is unsupported: $name", async ({ tools, warns }) => {
    getAllTools.mockReturnValue(tools);
    const ctx = context();
    await sessionStart({}, ctx);
    const warned = ctx.ui.notify.mock.calls.some(([message]) =>
      String(message).includes("requires Pi 0.99"),
    );
    expect(warned).toBe(warns);
  });

  it("keeps tools other extensions activated active and callable", async () => {
    getActiveTools.mockReturnValue(["read", "codemode", "mcp__docs__search"]);
    await sessionStart({}, context());
    expect(setActiveTools).toHaveBeenLastCalledWith([
      "typescript",
      "read",
      "codemode",
      "mcp__docs__search",
    ]);
  });

  it.each<{ name: string; config: unknown; hidden: string[] }>([
    {
      name: "default policy",
      config: {},
      hidden: ["read", "goal_complete", "codemode", "tool_search", "helper"],
    },
    {
      name: "allowedTools declares matches directly",
      config: { allowedTools: ["goal_*", "codemode"] },
      hidden: ["read", "tool_search", "helper"],
    },
  ])(
    "declares typescript, exceptions, direct MCP tools, and loaded tools: $name",
    async ({ config, hidden }) => {
      await configure(config);
      await sessionStart({}, context());
      expect(tool.prepareLoadout?.(loadout(declaredTools))).toEqual({ hiddenDeclarations: hidden });
    },
  );

  it("re-reads exceptions at session startup and hides revoked exceptions", async () => {
    await configure({ allowedTools: ["goal_*"] });
    await sessionStart({}, context());
    const goal = loadout([{ name: "goal_complete", exposure: "direct" }]);
    expect(tool.prepareLoadout?.(goal)).toEqual({ hiddenDeclarations: [] });
    await configure({ allowedTools: [] });
    await sessionStart({}, context());
    expect(tool.prepareLoadout?.(goal)).toEqual({ hiddenDeclarations: ["goal_complete"] });
  });

  it("adds the startup selection back after tree navigation without dropping restored tools", async () => {
    await configure({ allowedTools: ["goal_*"] });
    await sessionStart({}, context());
    // Pi restores the destination branch's recorded tools before session_tree. The selection
    // resolved at startup still applies; configuration edits wait for /reload.
    setActiveTools.mockClear();
    getActiveTools.mockReturnValue(["read", "codemode", "mcp__docs__loaded"]);
    await configure({ allowedTools: [] });
    sessionTree({}, context());
    expect(setActiveTools).toHaveBeenCalledExactlyOnceWith([
      "typescript",
      "read",
      "codemode",
      "mcp__docs__loaded",
      "goal_complete",
      "goal_blocked",
      "goal_wait",
    ]);
  });
});
