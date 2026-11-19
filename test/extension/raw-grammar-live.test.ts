import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { expect, it } from "vitest";

interface PiFixtureEvent {
  type: string;
  message?: { role: string; content: unknown };
  isError?: boolean;
  result?: unknown;
}

/** Run real Pi with an isolated offline provider and retain only the relevant lifecycle events. */
async function runFixture(prompt: string): Promise<PiFixtureEvent[]> {
  const root = process.cwd();
  const cwd = await mkdtemp(resolve(tmpdir(), "pit-raw-call-"));
  try {
    return await new Promise<PiFixtureEvent[]>((fulfill, reject) => {
      const child = spawn(
        process.execPath,
        [
          resolve(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
          "--no-session",
          "--no-mcp",
          "-ne",
          "-e",
          resolve(root, "src/index.ts"),
          "-e",
          resolve(root, "test/support/raw-call-provider.js"),
          "--provider",
          "raw-fixture",
          "--model",
          "fixture",
          "--mode",
          "json",
          "-p",
          prompt,
        ],
        {
          cwd,
          env: {
            PATH: process.env.PATH,
            HOME: cwd,
            PI_CODING_AGENT_DIR: resolve(cwd, "agent"),
            PI_AUTO_UPDATE: "0",
            PI_OFFLINE: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let buffer = "";
      let stderr = "";
      let failure: Error | undefined;
      const observed: PiFixtureEvent[] = [];
      let settled = false;
      const timeout = setTimeout(() => {
        failure = new Error(`Pi fixture timed out: ${stderr}`);
        child.kill("SIGKILL");
      }, 15000);
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2000);
      });
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let event: PiFixtureEvent;
          try {
            event = JSON.parse(line) as PiFixtureEvent;
          } catch (error) {
            failure = new Error("Pi fixture emitted invalid JSON", { cause: error });
            child.kill("SIGKILL");
            return;
          }
          if (event.type === "tool_execution_end" || event.type === "message_end")
            observed.push(event);
          if (event.type === "agent_settled") {
            settled = true;
            child.kill("SIGTERM");
          }
        }
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", () => {
        clearTimeout(timeout);
        if (failure) reject(failure);
        else if (settled) fulfill(observed);
        else reject(new Error(`Pi fixture exited early: ${stderr}`));
      });
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function assistantReply(events: PiFixtureEvent[]): unknown {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === "message_end" && event.message?.role === "assistant")
      return event.message.content;
  }
  return undefined;
}

it.each<{ name: string; prompt: string }>([
  { name: "plain source", prompt: "run fixture" },
  { name: "source with @pit options", prompt: "run options fixture" },
])(
  "executes recovered $name once and carries it into the next request",
  async ({ prompt }) => {
    const events = await runFixture(prompt);
    const results = events.filter((event) => event.type === "tool_execution_end");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      isError: false,
      result: { content: [{ type: "text", text: "4" }] },
    });
    expect(assistantReply(events)).toContainEqual({ type: "text", text: "REPLAY_AND_RESULT_OK" });
  },
  30000,
);

it("reports malformed @pit options without executing the program or breaking the next request", async () => {
  const events = await runFixture("run invalid fixture");
  const results = events.filter((event) => event.type === "tool_execution_end");
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    isError: true,
    result: {
      content: [{ type: "text", text: expect.stringContaining("must hold a JSON object") }],
    },
  });
  expect(assistantReply(events)).toContainEqual({ type: "text", text: "INVALID_OPTIONS_REPORTED" });
}, 30000);
