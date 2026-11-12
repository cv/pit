import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPitDurableExtension, type PitDurableOptions } from "../../src/durable/index.js";
import { DurableTestHost } from "../support/durable-harness.js";

let root: string;
let cwd: string;
let agentDir: string;
let warnings: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pit-durable-loadout-"));
  cwd = join(root, "project");
  agentDir = join(root, "agent");
  warnings = [];
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const log = {
  info: () => undefined,
  warning: (message: string) => {
    warnings.push(message);
  },
};

/** pi-action's order: pi-durable's coding tools first, then Pit, then anything else. */
function host(
  options: PitDurableOptions = {},
  extensions: Extension[] = [],
  agent: ConstructorParameters<typeof DurableTestHost>[0]["agent"] = {},
): DurableTestHost {
  return new DurableTestHost({
    extension: CodingTools,
    extensions: [createPitDurableExtension({ agentDir, log, ...options }), ...extensions],
    env: true,
    cwd,
    agent,
  });
}

const ALL = ["bash", "edit", "read", "typescript", "write"];

describe("the tools a pi-durable host offers the model", () => {
  it.each<{
    name: string;
    options?: PitDurableOptions;
    user?: string;
    project?: string;
    offered: string[];
    warnings?: RegExp[];
  }>([
    { name: "hides the coding tools by default", offered: ["typescript"] },
    {
      name: "offers the user's allowedTools",
      user: '{ "allowedTools": ["bash"] }',
      offered: ["bash", "typescript"],
    },
    {
      name: "lets a trusted project's list replace the user's",
      options: { trustProject: true },
      user: '{ "allowedTools": ["bash"] }',
      project: '{ "allowedTools": ["read"] }',
      offered: ["read", "typescript"],
    },
    {
      name: "lets a trusted project clear the user's list",
      options: { trustProject: true },
      user: '{ "allowedTools": ["bash"] }',
      project: '{ "allowedTools": [] }',
      offered: ["typescript"],
    },
    {
      name: "grants no exceptions for an invalid project file",
      options: { trustProject: true },
      user: '{ "allowedTools": ["bash"] }',
      project: "{",
      offered: ["typescript"],
      warnings: [/^Invalid .*\.pi\/pit\.json/],
    },
    {
      name: "ignores an untrusted project's file",
      project: '{ "allowedTools": ["bash"] }',
      offered: ["typescript"],
    },
    { name: "hides nothing when opted out", options: { hideTools: false }, offered: ALL },
    {
      name: "hides only an explicit list",
      options: { hideTools: ["bash"] },
      offered: ["edit", "read", "typescript", "write"],
    },
    { name: "offers glob allowedTools matches", user: '{ "allowedTools": ["*"] }', offered: ALL },
    {
      name: "never hides typescript",
      options: { hideTools: ["typescript", "bash"] },
      offered: ["edit", "read", "typescript", "write"],
    },
  ])("$name", async ({ options = {}, user, project, offered, warnings: expected = [] }) => {
    if (user !== undefined) await writeFile(join(agentDir, "pit.json"), user);
    if (project !== undefined) await writeFile(join(cwd, ".pi", "pit.json"), project);
    const run = await host({ cwd, ...options }).run([]);
    expect(run.offered).toEqual(offered);
    expect(warnings).toEqual(expected.map((pattern) => expect.stringMatching(pattern)));
  });

  it("reads only the user's pit.json and warns when a trusted project has no cwd", async () => {
    await writeFile(join(agentDir, "pit.json"), '{ "allowedTools": ["bash"] }');
    await writeFile(join(cwd, ".pi", "pit.json"), '{ "allowedTools": ["read"] }');
    const run = await host({ trustProject: true }).run([]);
    expect(run.offered).toEqual(["bash", "typescript"]);
    expect(warnings).toEqual([expect.stringMatching(/needs the cwd option/)]);
  });

  it("leaves Pit's workspace and shell as the one way to the host's files and commands", async () => {
    await writeFile(join(cwd, "notes.txt"), "notes\n");
    const echo: ToolRegistration = {
      name: "echo",
      description: "Echoes text.",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      execute: async (args: any) => ({ output: [{ type: "text", text: `echo: ${args.text}` }] }),
    };
    const { results, sections } = await host({ cwd }, [{ name: "extra", tools: [echo] }]).run([
      {
        code: `async ({ workspace: { read }, shell: { exec }, tools: { echo } }) => ({
  read: (await read("notes.txt", { format: "raw" })).content,
  shell: (await exec("echo ran")).stdout,
  echo: await echo({ text: "hi" }),
})`,
      },
      { code: "async ({ tools: { bash } }) => bash({ command: 'echo duplicate' })" },
    ]);
    expect(results[0]?.details.value).toEqual({
      read: "notes\n",
      shell: "ran\n",
      echo: "echo: hi",
    });
    expect(results[1]?.isError).toBe(true);
    expect(results[1]?.text).toMatch(/\bbash\b/);
    expect(sections.pit_tools).toMatch(/injectable from `tools`: echo\./);
  });

  it("keeps hidden tools callable by other tools", async () => {
    const relay: ToolRegistration = {
      name: "relay",
      description: "Runs a command through the host's bash tool.",
      parameters: { type: "object", properties: {} },
      execute: async (_args, api, context) => {
        const result = await api.executeTool("bash", { command: "echo relayed" }, context);
        return { output: [{ type: "text", text: JSON.stringify(result.structuredOutput) }] };
      },
    };
    const { results } = await host({ cwd }, [{ name: "relay", tools: [relay] }]).run([
      { code: "async ({ tools: { relay } }) => relay()" },
    ]);
    expect(results[0]?.isError).toBe(false);
    expect(results[0]?.details.value).toContain("relayed");
  });

  it("hides a bash that an extension installed later replaces", async () => {
    const bash: ToolRegistration = {
      name: "bash",
      description: "A replacement bash.",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ output: [{ type: "text", text: "replaced" }] }),
    };
    const run = await host({ cwd }, [{ name: "replacement", tools: [bash] }]).run([]);
    expect(run.offered).toEqual(["typescript"]);
  });

  it("leaves model-only and deferred tools named in hideTools as they are", async () => {
    const tool = (name: string, extra: Partial<ToolRegistration>): ToolRegistration => ({
      name,
      description: `The ${name} tool.`,
      parameters: { type: "object", properties: {} },
      execute: async () => ({ output: [{ type: "text", text: name } as const] }),
      ...extra,
    });
    const lazy = tool("lazy", { deferred: true });
    const run = await host(
      { cwd, hideTools: ["solo", "lazy"] },
      [{ name: "extra", tools: [tool("solo", { callers: ["model"] }), lazy] }],
      { modelTools: { add: [lazy] } },
    ).run([]);
    expect(run.offered).toEqual(["bash", "edit", "lazy", "read", "solo", "typescript", "write"]);
  });
});
