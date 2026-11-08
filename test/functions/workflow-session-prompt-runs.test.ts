import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { skipWithoutJq } from "../helpers/jq.js";
import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

const execute = promisify(execFile);
const MARKER = "Review the work completed in this session";
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pit-prompt-runs-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// Runs grep and jq for real, reporting nonzero exits as results the way shell.execFile does.
async function run(program: string, args: string[]) {
  try {
    return processResult(await execute(program, args, { maxBuffer: 1024 * 1024 }));
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return processResult({
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
      code: typeof failed.code === "number" ? failed.code : 1,
    });
  }
}

async function findPromptRuns(input: Record<string, unknown>) {
  const [adapter, finder] = await Promise.all(
    ["jq", "sessions.findPromptRuns"].map(loadWorkflowFunction),
  );
  if (!adapter || !finder) throw new Error("Missing workflow source");
  const shell = { execFile: run };
  return finder(
    {
      context: { get: async () => ({ sessionFile: join(root, "--project-a--", "current.jsonl") }) },
      shell,
      jq: (query: Record<string, unknown>) => adapter({ shell }, query),
    },
    input,
  );
}

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 12, minutes)).toISOString();
const message = (id: string, minutes: number, value: Record<string, unknown>) =>
  JSON.stringify({ type: "message", id, timestamp: at(minutes), message: value });
const user = (id: string, minutes: number, text: string) =>
  message(id, minutes, { role: "user", content: [{ type: "text", text }] });
const assistant = (minutes: number, content: unknown[], cost = 0) =>
  message(`a${minutes}`, minutes, { role: "assistant", content, usage: { cost: { total: cost } } });
const call = (args: Record<string, unknown>) => ({
  type: "toolCall",
  name: "typescript",
  arguments: args,
});

async function session(project: string, name: string, lines: string[]) {
  await mkdir(join(root, project), { recursive: true });
  await writeFile(join(root, project, name), `${lines.join("\n")}\n`);
}

describe.skipIf(skipWithoutJq)("sessions.findPromptRuns with real grep and jq", () => {
  beforeEach(async () => {
    await session("--project-a--", "current.jsonl", [user("now", 50, `${MARKER} now`)]);
    await session("--project-a--", "earlier.jsonl", [
      JSON.stringify({ type: "session", version: 3 }),
      "{not json",
      user("run1", 0, `${MARKER}, focusing on the entire session.`),
      assistant(1, [call({ label: "List functions", code: "" })], 0.5),
      message("r1", 2, {
        role: "toolResult",
        isError: true,
        content: [{ type: "text", text: "boom" }],
      }),
      assistant(
        3,
        [call({ functionId: "a.b", saveOnly: true }), { type: "text", text: "Report one" }],
        0.25,
      ),
      user("next1", 4, "commit"),
      assistant(5, [call({ label: "Commit" })], 1),
    ]);
    await session("--project-b--", "later.jsonl", [
      user("quoted", 10, `Note: ${MARKER} is a template`),
      assistant(11, [{ type: "text", text: "Quoted report" }]),
      user("run2", 20, `${MARKER}, again.`),
      assistant(22, [{ type: "text", text: "Last report" }]),
    ]);
  });

  it("summarizes each run up to the next user message, newest first, excluding the current session", async () => {
    const result = await findPromptRuns({ marker: MARKER });
    expect(result).toMatchObject({ filesMatched: 2, total: 2, omitted: 0, failures: [] });
    expect(result.runs).toEqual([
      expect.objectContaining({
        project: "project-b",
        id: "run2",
        toolCalls: 0,
        report: "Last report",
        next: null,
        minutes: 2,
      }),
      {
        project: "project-a",
        file: "--project-a--/earlier.jsonl",
        id: "run1",
        ts: at(0),
        toolCalls: 2,
        labels: ["List functions", "a.b"],
        savedIds: ["a.b"],
        toolErrors: 1,
        errors: ["boom"],
        cost: 0.75,
        report: "Report one",
        next: "commit",
        minutes: 3,
      },
    ]);
    expect(result.topFollowUps).toEqual(
      expect.arrayContaining([
        { text: "commit", count: 1 },
        { text: "<none>", count: 1 },
      ]),
    );
  });

  it.each([
    { name: "contains matching", input: { match: "contains" }, ids: ["run2", "quoted", "run1"] },
    { name: "the current session", input: { includeCurrent: true }, ids: ["now", "run2", "run1"] },
    { name: "a run limit", input: { limit: 1 }, ids: ["run2"] },
  ])("selects runs with $name", async ({ input, ids }) => {
    const result = await findPromptRuns({ marker: MARKER, ...input });
    expect((result.runs as Array<{ id: string }>).map((entry) => entry.id)).toEqual(ids);
  });

  it("returns no runs when no session matches, and rejects an unbounded marker", async () => {
    await expect(findPromptRuns({ marker: "no session says this" })).resolves.toMatchObject({
      filesMatched: 0,
      total: 0,
      runs: [],
    });
    await expect(findPromptRuns({ marker: "Review" })).rejects.toThrow("at least 12 characters");
    await expect(findPromptRuns({ marker: MARKER, limit: 0 })).rejects.toThrow("limit");
  });
});
