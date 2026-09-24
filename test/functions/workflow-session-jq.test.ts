import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { skipWithoutJq } from "../helpers/jq.js";
import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

const execute = promisify(execFile);
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pit-jq-[session]-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function workflows() {
  const [adapter, reader, analyzer] = await Promise.all(
    ["jq", "readPitSessionEvents", "analyzePitSession"].map(loadWorkflowFunction),
  );
  if (!adapter || !reader || !analyzer) throw new Error("Missing workflow source");
  const query = (input: Record<string, unknown>) =>
    adapter(
      {
        shell: {
          execFile: async (program: string, args: string[]) => {
            const result = await execute(program, args, {
              cwd: directory,
              timeout: 30000,
              maxBuffer: 1024 * 1024,
            });
            return processResult(result);
          },
        },
      },
      input,
    );
  const events = (input: Record<string, unknown>) => reader({ jq: query }, input);
  return {
    query,
    events,
    analyze: (input: Record<string, unknown>) =>
      analyzer({ context: { get: async () => ({}) }, readPitSessionEvents: events }, input),
  };
}

const message = (value: Record<string, unknown>) =>
  JSON.stringify({ type: "message", message: value });
const toolCall = (id: string, label = "Edit file", code = "") => ({
  type: "toolCall",
  id,
  arguments: { label, code },
});

describe.skipIf(skipWithoutJq)("session queries with real jq", () => {
  it("preserves the established audit of the 8 MB recorded case-study session", async () => {
    const { analyze } = await workflows();
    const result = await analyze({ file: resolve("docs/case_study/session.jsonl"), examples: 2 });
    expect(result).toMatchObject({
      toolCalls: 498,
      failures: 26,
      failureRatePercent: 5.2,
      workflowFailures: 26,
      workflowFailureRatePercent: 5.2,
      gateFailures: 0,
      expectedFailures: 0,
      categories: { logic: 17, typescript: 7, command: 2 },
      execFilePrograms: {
        osascript: 157,
        date: 4,
        find: 3,
        "/usr/bin/log": 2,
        "/bin/date": 17,
        mkdir: 4,
        sdef: 1,
        open: 37,
        pgrep: 4,
        git: 5,
        "/usr/bin/python3": 25,
        "/usr/sbin/screencapture": 1,
        swift: 1,
        wc: 1,
        cp: 4,
        mv: 3,
        cmp: 2,
        pi: 3,
      },
      shellExecCalls: 18,
      promiseAllCalls: 93,
      workspaceBatchCalls: 3,
      repeatedWorkflowFailureLabels: [
        ["Query Apple Music tracks played today", 1],
        ["Scan Apple Music library for today’s plays", 1],
      ],
      recentFailureExamples: [
        {
          category: "logic",
          label: "Create Jorge Ben Jor connections playlist",
          error: "TypeScript execution timed out after 300000ms",
          functionPath: ["populateAppleMusicCatalogPlaylist"],
          failureKind: "timeout",
        },
        {
          category: "logic",
          label: "Complete Jorge Ben Jor connections playlist",
          error: "Catalog track not found in album 1440512849: Mais Que Nada",
          functionPath: ["populateAppleMusicCatalogPlaylist"],
          failureKind: "user",
        },
      ],
    });
  }, 15000);

  it("handles literal filenames, variable bindings, and an empty result stream", async () => {
    const { query } = await workflows();
    await writeFile(join(directory, "-"), '{"value":1}\n');
    expect(
      await query({ file: "-", filter: ".value + $increment", variables: { increment: 2 } }),
    ).toEqual({ values: [3] });
    const file = "quotes ' and\nspaces.jsonl";
    await writeFile(join(directory, file), "{}\n");
    const literal = '"; $(touch should-not-exist)';
    expect(await query({ file, filter: "$literal", variables: { literal } })).toEqual({
      values: [literal],
    });
    expect(await query({ file, filter: "empty" })).toEqual({ values: [] });
  });

  it("pages physical lines, skips malformed data, and projects away bulky content", async () => {
    const { events } = await workflows();
    const file = join(directory, "data.jsonl");
    const code =
      'shell.execFile("git", []); shell.exec("echo hi"); Promise.all([]); workspace.batch([]);' +
      " ".repeat(100000);
    const lines = [
      JSON.stringify({ type: "session", version: 3 }),
      message({ role: "user", content: "plain string, not an array" }),
      "malformed JSON",
      message({
        role: "assistant",
        content: [
          toolCall("one", "Edit file", code),
          toolCall("two"),
          { type: "image", data: "x".repeat(100000) },
        ],
      }),
      message({
        role: "toolResult",
        toolCallId: "two",
        content: [{ type: "text", text: "success".repeat(20000) }],
        isError: false,
      }),
      message({
        role: "toolResult",
        toolCallId: "one",
        content: [{ type: "text", text: "Error: wrapper" }],
        isError: true,
        details: {
          failure: {
            rootError: "Anchor mismatch",
            functionPath: ["outer", "inner"],
            kind: "logic",
          },
        },
      }),
      "null",
      "",
      '{"unfinished":',
    ];
    await writeFile(file, lines.join("\n") + "\n");
    expect(await events({ file, limit: 3 })).toEqual({ hasMore: true, nextLine: 3, events: [] });
    const second = await events({ file, limit: 3, afterLine: 3 });
    expect(second).toMatchObject({
      hasMore: true,
      nextLine: 6,
      events: [
        {
          calls: [
            {
              id: "one",
              programs: ["git"],
              shellExec: true,
              promiseAll: true,
              workspaceBatch: true,
            },
            { id: "two" },
          ],
          failure: null,
        },
        {
          calls: [],
          failure: {
            id: "one",
            error: "Anchor mismatch",
            functionPath: ["outer", "inner"],
            failureKind: "logic",
          },
        },
      ],
    });
    expect(JSON.stringify(second).length).toBeLessThan(2000);
    expect(await events({ file, limit: 3, afterLine: 6 })).toEqual({
      hasMore: false,
      nextLine: 9,
      events: [],
    });
    expect(await events({ file, limit: 3, afterLine: 9 })).toEqual({
      hasMore: false,
      nextLine: 9,
      events: [],
    });
  });

  it("correlates multiple calls on a page boundary through the complete injected pipeline", async () => {
    const { analyze } = await workflows();
    const file = join(directory, "boundary.jsonl");
    const lines = [
      ...Array.from({ length: 499 }, () => "{}"),
      message({ role: "assistant", content: [toolCall("one"), toolCall("two")] }),
      message({
        role: "toolResult",
        toolCallId: "one",
        content: [{ type: "text", text: "Error: Anchor mismatch" }],
      }),
      message({
        role: "toolResult",
        toolCallId: "two",
        content: [{ type: "text", text: "TypeScript validation failed: detail" }],
      }),
    ];
    await writeFile(file, lines.join("\n") + "\n");
    expect(await analyze({ file, examples: 1 })).toMatchObject({
      toolCalls: 2,
      failures: 2,
      workflowFailures: 2,
      failureRatePercent: 100,
      categories: { anchor: 1, typescript: 1 },
      recentFailureExamples: [{ category: "typescript" }],
    });
  });

  it("ends dense pages at the byte budget without losing or duplicating calls", async () => {
    const { events } = await workflows();
    const file = join(directory, "dense.jsonl");
    const lines = Array.from({ length: 400 }, (_, index) =>
      message({
        role: "assistant",
        content: [toolCall(`call-${index}`, `${"label ".repeat(60)}${index}`)],
      }),
    );
    await writeFile(file, lines.join("\n") + "\n");
    const ids: string[] = [];
    const pageBytes: number[] = [];
    for (let afterLine = 0, hasMore = true; hasMore;) {
      const page = (await events({ file, afterLine, limit: 500 })) as {
        hasMore: boolean;
        nextLine: number;
        events: Array<{ calls: Array<{ id: string; label: string }> }>;
      };
      pageBytes.push(Buffer.byteLength(JSON.stringify(page)));
      for (const event of page.events) {
        for (const call of event.calls) {
          expect(call.label).toHaveLength(200);
          ids.push(call.id);
        }
      }
      expect(page.nextLine).toBeGreaterThan(afterLine);
      ({ hasMore } = page);
      afterLine = page.nextLine;
    }
    expect(ids).toEqual(Array.from({ length: 400 }, (_, index) => `call-${index}`));
    expect(pageBytes.length).toBeGreaterThan(1);
    for (const bytes of pageBytes) expect(bytes).toBeLessThan(50_000);
  });

  it("clips unbounded failure text and function paths", async () => {
    const { events } = await workflows();
    const file = join(directory, "failure.jsonl");
    await writeFile(
      file,
      message({
        role: "toolResult",
        toolCallId: "one",
        content: [{ type: "text", text: "Error: wrapper" }],
        isError: true,
        details: {
          failure: {
            rootError: "e".repeat(10_000),
            functionPath: Array.from({ length: 40 }, () => "f".repeat(1000)),
          },
        },
      }) + "\n",
    );
    const page = (await events({ file })) as {
      events: Array<{ failure: { error: string; functionPath: string[] } }>;
    };
    const failure = page.events[0]?.failure;
    expect(failure?.error).toHaveLength(500);
    expect(failure?.functionPath).toEqual(Array.from({ length: 16 }, () => "f".repeat(200)));
  });

  it.each<{ name: string; input: Record<string, unknown> }>([
    { name: "negative cursor", input: { afterLine: -1 } },
    { name: "fractional page size", input: { limit: 1.5 } },
    { name: "oversized page", input: { limit: 501 } },
  ])("rejects $name without invoking jq", async ({ input }) => {
    const reader = await loadWorkflowFunction("readPitSessionEvents");
    await expect(reader({}, { file: "unused", ...input })).rejects.toThrow("Session page requires");
  });
});
