/**
 * Runs the repository task in a session: writes the generated repository, sends tickets one at a
 * time as user messages, and scores the result.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { Driver, RunSpec } from "../worker.js";
import { generateRepo } from "./generate.js";
import { RULES_TICKET, type Ticket } from "./model.js";
import { exportsOf, readTree, scoreRepo } from "./score.js";

const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

function git(args: string[], cwd: string): Promise<void> {
  const identity = [
    "-c",
    "user.name=Shopline Maintainers",
    "-c",
    "user.email=maintainers@shopline.invalid",
    "-c",
    "commit.gpgsign=false",
  ];
  const date = "2026-09-28T09:00:00Z";
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...identity, ...args],
      { cwd, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

export async function writeRepo(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

export const ticketMessage = (ticket: Ticket) => `Ticket ${ticket.id}: ${ticket.text}`;

export function repoPrompt(contextWindow: number, first: Ticket): string {
  return [
    `You are maintaining shopline, the Node.js library in the current directory. It has no dependencies; run its tests with \`node --test\`. I will give you tickets one at a time. Work on each until it is done, then call ticket_done with its number and a one-line summary, and I will send the next one. Your context window is about ${Math.round(contextWindow / 1000)}K tokens.`,
    "Work autonomously; do not ask for confirmation.",
    ticketMessage(first),
  ].join("\n\n");
}

export function repoDriver(spec: RunSpec): Driver {
  const task = generateRepo(spec.seed);
  const [first] = task.tickets;
  if (!first) throw new Error("The repository task has no tickets");
  const last = task.tickets.length;
  const done = new Map<number, string>();
  const skipped: number[] = [];
  let current = 1;
  let ticketNudges = 0;
  let rejected = 0;
  let baseline: string[] | null = null;
  const extension = (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "ticket_done",
      label: "Ticket done",
      description:
        "Reports that the current ticket is finished, with a one-line summary. The next ticket arrives as a new message.",
      parameters: Type.Object({
        ticket: Type.Integer({ minimum: 1, description: "The current ticket's number" }),
        summary: Type.String(),
      }),
      async execute(_id, params) {
        if (params.ticket !== current) {
          rejected++;
          throw new Error(`Ticket ${current} is the current ticket.`);
        }
        done.set(current, params.summary);
        return reply(
          current === last
            ? "Recorded. That was the last ticket."
            : "Recorded. The next ticket will arrive in a new message; end your turn now.",
        );
      },
    });
  };
  const continueText = () =>
    `Continue with ticket ${current}, and call ticket_done when it is finished.`;
  return {
    extension,
    allowedTools: ["ticket_done"],
    async prepare(workspace) {
      await writeRepo(workspace, task.files);
      await git(["init", "-q", "-b", "main"], workspace);
      await git(["add", "-A"], workspace);
      await git(["commit", "-qm", "shopline 2.3.1"], workspace);
    },
    firstPrompt: repoPrompt(spec.contextWindow, first),
    turnLimit: 600,
    async next(workspace) {
      if (!done.has(current) && ticketNudges < spec.maxNudges) {
        ticketNudges++;
        return { text: continueText(), nudge: true };
      }
      // A ticket the model never reported done is skipped, as a user would move on.
      if (!done.has(current)) skipped.push(current);
      if (current >= last) return null;
      current++;
      ticketNudges = 0;
      if (current === RULES_TICKET) baseline = exportsOf(await readTree(workspace));
      const ticket = task.tickets[current - 1];
      return ticket ? { text: ticketMessage(ticket), nudge: false } : null;
    },
    resume: continueText,
    complete: () => current === last && (done.has(last) || skipped.includes(last)),
    progress: () => ({
      tickets: last,
      current,
      done: [...done.keys()],
      skipped,
      rejectedCalls: rejected,
      summaries: Object.fromEntries(done),
    }),
    score: async (workspace) => (await scoreRepo(task, workspace, baseline)).score,
  };
}
