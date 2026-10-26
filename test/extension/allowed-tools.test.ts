import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ToolLoadout } from "@earendil-works/pi-coding-agent";
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
import { toolLoadout, type LoadoutTool } from "../support/tool-loadout.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

async function configure(config: unknown, directory = join(cwd, ".pi")): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "pit.json"), JSON.stringify(config));
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

/** A session's active tools as Pi hands them to `prepareLoadout()`. */
function loadout(tools: LoadoutTool[]): ToolLoadout {
  return toolLoadout(tools);
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

  it.each<{
    name: string;
    config?: unknown;
    userConfig?: unknown;
    trusted?: boolean;
    warnings?: string[];
    expected: string[];
  }>([
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
    {
      name: "user defaults without a project file",
      userConfig: { allowedTools: ["goal_*"] },
      expected: ["goal_complete", "goal_blocked", "goal_wait"],
    },
    {
      name: "omitted project key inherits user defaults",
      config: {},
      userConfig: { allowedTools: ["goal_*"] },
      expected: ["goal_complete", "goal_blocked", "goal_wait"],
    },
    {
      name: "project list replaces rather than merges user defaults",
      config: { allowedTools: ["goal_complete"] },
      userConfig: { allowedTools: ["subagent"] },
      expected: ["goal_complete"],
    },
    {
      name: "empty project list clears user defaults",
      config: { allowedTools: [] },
      userConfig: { allowedTools: ["goal_*"] },
      expected: [],
    },
    {
      name: "user defaults apply in untrusted projects",
      config: { allowedTools: ["*"] },
      userConfig: { allowedTools: ["subagent"] },
      trusted: false,
      expected: ["subagent"],
    },
    {
      name: "invalid project does not fall back to user defaults",
      config: null,
      userConfig: { allowedTools: ["goal_*"] },
      warnings: [".pi/pit.json"],
      expected: [],
    },
    {
      name: "invalid user config grants no defaults",
      userConfig: { allowedTools: "goal_*" },
      warnings: ["agent/pit.json"],
      expected: [],
    },
    {
      name: "valid project list survives invalid user config",
      config: { allowedTools: ["goal_complete"] },
      userConfig: [],
      warnings: ["agent/pit.json"],
      expected: ["goal_complete"],
    },
    {
      name: "both invalid files are identified",
      config: { allowedTools: false },
      userConfig: { allowedTools: null },
      warnings: ["agent/pit.json", ".pi/pit.json"],
      expected: [],
    },
    {
      name: "user paths are ignored without discarding user defaults",
      userConfig: { allowedTools: ["goal_*"], paths: { user: 1 } },
      warnings: ["Ignored paths in", "agent/pit.json"],
      expected: ["goal_complete", "goal_blocked", "goal_wait"],
    },
  ])(
    "activates and declares configured exceptions: $name",
    async ({ config, userConfig, trusted = true, warnings = [], expected }) => {
      if (config !== undefined) await configure(config);
      if (userConfig !== undefined) await configure(userConfig, join(cwd, "agent"));
      const ctx = context({ isProjectTrusted: () => trusted });
      await sessionStart({}, ctx);
      expect(setActiveTools).toHaveBeenLastCalledWith(["typescript", ...expected]);
      expect(
        tool.prepareLoadout?.(loadout(available.map((name) => ({ name, exposure: "direct" }))))
          ?.hiddenDeclarations,
      ).toEqual(available.filter((name) => name !== "typescript" && !expected.includes(name)));
      for (const path of warnings) {
        expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(path), "warning");
      }
    },
  );

  it.each<{
    name: string;
    unreadable: string;
    config?: unknown;
    userConfig?: unknown;
    expected: string[];
  }>([
    {
      name: "user file keeps a valid project list",
      unreadable: "agent",
      config: { allowedTools: ["goal_complete"] },
      expected: ["goal_complete"],
    },
    {
      name: "project file grants no exceptions",
      unreadable: ".pi",
      userConfig: { allowedTools: ["goal_*"] },
      expected: [],
    },
  ])(
    "warns about an unreadable configuration file: $name",
    async ({ unreadable, config, userConfig, expected }) => {
      if (config !== undefined) await configure(config);
      if (userConfig !== undefined) await configure(userConfig, join(cwd, "agent"));
      await mkdir(join(cwd, unreadable, "pit.json"), { recursive: true });
      const ctx = context();
      await sessionStart({}, ctx);
      expect(setActiveTools).toHaveBeenLastCalledWith(["typescript", ...expected]);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining(`Cannot read ${join(cwd, unreadable, "pit.json")}`),
        "warning",
      );
    },
  );

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
    await configure({ allowedTools: ["goal_*"] }, join(cwd, "agent"));
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
      // typescript's description is covered by pi-tools.test.ts.
      expect(tool.prepareLoadout?.(loadout(declaredTools))?.hiddenDeclarations).toEqual(hidden);
    },
  );

  it("re-reads user exceptions at session startup and hides revoked exceptions", async () => {
    await configure({ allowedTools: ["goal_*"] }, join(cwd, "agent"));
    await sessionStart({}, context());
    const goal = loadout([{ name: "goal_complete", exposure: "direct" }]);
    expect(tool.prepareLoadout?.(goal)).toEqual({ hiddenDeclarations: [] });
    await configure({ allowedTools: [] }, join(cwd, "agent"));
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
