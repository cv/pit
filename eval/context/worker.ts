/**
 * Runs one evaluation: a task, a condition, a model, and a seed, in this process. The runner
 * (run.ts) starts one worker process per run so environment changes and Pit's module state never
 * leak between runs.
 *
 * Usage: node --import tsx eval/context/worker.ts <spec.json>
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { CONDITIONS, type ConditionId } from "./conditions.js";
import { createFeed } from "./feed.js";
import { type Score, scoreTask } from "./score.js";
import { estimateTokens, generateTask, type Task, type TaskKind, type TaskSize } from "./tasks.js";
import { auditSession, type SessionAudit } from "./telemetry.js";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

/** files: the model may keep data in workspace files. context: it is asked to keep everything in the conversation. */
export const MEMORY_MODES = ["files", "context"] as const;
export type Memory = (typeof MEMORY_MODES)[number];

export const CONTEXT_ONLY =
  "Keep everything you need in this conversation: do not write files, run shell commands, or store data anywhere else. Your context is your only memory.";

const SHELL = /\b(shell|exec|execFile)\b/;
const WORKSPACE_WRITE = /\bworkspace\b[\s\S]*\b(edit|batch)\b/;

/**
 * Tool calls in an assistant message that could store data outside the conversation: Pi's bash,
 * write, and edit tools, and Pit programs that use the shell or edit workspace files.
 */
export function externalWriteCalls(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block of content as Array<{
    type?: string;
    name?: string;
    arguments?: { code?: unknown };
  }>) {
    if (block.type !== "toolCall") continue;
    const code = typeof block.arguments?.code === "string" ? block.arguments.code : "";
    if (
      ["bash", "write", "edit"].includes(block.name ?? "") ||
      (block.name === "typescript" && (SHELL.test(code) || WORKSPACE_WRITE.test(code)))
    ) {
      count++;
    }
  }
  return count;
}

export interface RunSpec {
  id: string;
  provider: string;
  model: string;
  thinking: Thinking;
  condition: ConditionId;
  task: TaskKind;
  seed: number;
  size: TaskSize;
  /** The evaluation model's reduced context window, in tokens. */
  contextWindow: number;
  /** Condition E's absolute notice levels, in tokens. */
  noticeTokens: number[];
  /** Absolute results directory. */
  outDir: string;
  maxNudges: number;
  /** Where the model may keep data. The default is files. */
  memory?: Memory;
  timeoutMs: number;
}

export interface RunResult {
  id: string;
  spec: RunSpec;
  startedAt: string;
  wallMs: number;
  /** complete: every question answered. incomplete: the model stopped or a limit ended the run. */
  status: "complete" | "incomplete" | "error";
  error: string | null;
  /** The last assistant message's stop reason and error, when the provider reported one. */
  stopReason: string | null;
  providerError: string | null;
  nudges: number;
  turns: number;
  feed: { delivered: number; total: number; rejectedCalls: number; compactToolCalls: number };
  score: Score;
  /**
   * Prompt tokens of the first provider request: system prompt, tool definitions, and the task
   * prompt. The fixed overhead a condition adds to every request.
   */
  basePromptTokens: number;
  /** Tool calls that could store data outside the conversation; see externalWriteCalls. */
  externalWrites: number;
  /** Assistant messages the provider ended as refusals; see REFUSAL_RETRIES. */
  refusals: number;
  telemetry: SessionAudit | null;
  sessionFile: string | null;
}

export function taskPrompt(task: Task, contextWindow: number, memory: Memory = "files"): string {
  const chunks = task.chunks.length;
  const tokens = task.chunks.reduce((sum, chunk) => sum + estimateTokens(chunk.text), 0);
  return [
    `You are taking a long-context retention test. A feed delivers ${chunks} chunks through the feed_next tool, about ${Math.round(tokens / 1000)}K tokens in total, more than your ${Math.round(contextWindow / 1000)}K-token context window holds at once. Read every chunk in order. Some chunks end with questions: answer them with feed_answer before calling feed_next again. Questions can ask about anything earlier in the feed, and the feed cannot be replayed.`,
    task.description,
    ...(memory === "context" ? [CONTEXT_ONLY] : []),
    "Work autonomously until feed_answer reports that the test is complete. Do not ask for confirmation.",
  ].join("\n\n");
}

/**
 * Claude models on Bedrock sometimes refuse benign evaluation context, intermittently and most often
 * right after a compaction. A run continues after a refusal at most this many times; the count is
 * reported, and the run fails if refusals persist.
 */
export const REFUSAL_RETRIES = 3;
const REFUSAL = /refused/i;

export const NUDGE =
  "Continue the test: call feed_next, or feed_answer for pending questions, until feed_answer reports that the test is complete.";

export async function runOne(spec: RunSpec): Promise<RunResult> {
  const condition = CONDITIONS[spec.condition];
  const task = generateTask(spec.task, spec.seed, spec.size);
  const feed = createFeed({
    task,
    compactTool: condition.compactTool,
    noticeTokens: condition.extraNotices ? spec.noticeTokens : [],
  });
  const startedAt = new Date();
  // Credentials and model definitions come from the user's agent directory, read-only. Everything
  // else, including Pit's user and global functions, comes from an empty one.
  const userAgentDir = getAgentDir();
  const agentDir = await mkdtemp(join(tmpdir(), "pit-eval-agent-"));
  const workspace = await mkdtemp(join(tmpdir(), "pit-eval-workspace-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const sessionDir = join(spec.outDir, "sessions", spec.id);
  let turns = 0;
  let nudges = 0;
  let stopReason: string | null = null;
  let providerError: string | null = null;
  let error: string | null = null;
  let basePromptTokens = 0;
  let externalWrites = 0;
  let refusals = 0;
  let sessionFile: string | null = null;
  try {
    await mkdir(join(workspace, ".pi"), { recursive: true });
    await writeFile(
      join(workspace, ".pi", "pit.json"),
      JSON.stringify({ allowedTools: ["feed_*", "compact_context"] }, null, 2),
    );
    const session = await createSession({
      spec,
      userAgentDir,
      agentDir,
      workspace,
      sessionDir,
      extension: feed.extension,
    });
    const turnLimit = task.chunks.length * 4 + 40;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_end" && ++turns > turnLimit && !error) {
        error = `Stopped after ${turnLimit} turns`;
        void session.abort();
      }
      if (event.type === "message_end" && "role" in event.message) {
        const message = event.message as {
          role: string;
          stopReason?: string;
          errorMessage?: string;
          usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
          content?: unknown;
        };
        if (message.role === "assistant") {
          stopReason = message.stopReason ?? null;
          providerError = message.errorMessage?.split("\n")[0] ?? null;
          const usage = message.usage;
          basePromptTokens ||=
            (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
          externalWrites += externalWriteCalls(message.content);
          if (REFUSAL.test(message.errorMessage ?? "")) refusals++;
        }
      }
    });
    const timer = setTimeout(() => {
      error ??= `Timed out after ${Math.round(spec.timeoutMs / 60_000)} minutes`;
      void session.abort();
    }, spec.timeoutMs);
    try {
      await session.prompt(taskPrompt(task, spec.contextWindow, spec.memory));
      // Continue after an early stop or a refusal, but not after another provider failure. The
      // subscription updates these between prompts.
      let refusalRetries = 0;
      const next = (): "nudge" | "refusal" | null => {
        if (feed.state.complete || error) return null;
        if (stopReason === "error") {
          return REFUSAL.test(providerError ?? "") && refusalRetries < REFUSAL_RETRIES
            ? "refusal"
            : null;
        }
        return nudges < spec.maxNudges ? "nudge" : null;
      };
      for (let step = next(); step; step = next()) {
        if (step === "refusal") refusalRetries++;
        else nudges++;
        await session.prompt(NUDGE);
      }
      if (stopReason === "error" && !feed.state.complete) {
        error ??= `Provider error: ${providerError ?? "unknown"}`;
      }
    } finally {
      clearTimeout(timer);
      unsubscribe();
      sessionFile = session.sessionFile ?? null;
      session.dispose();
    }
  } catch (failure) {
    error ??= failure instanceof Error ? failure.message : String(failure);
  } finally {
    await Promise.all([
      rm(agentDir, { recursive: true, force: true }),
      rm(workspace, { recursive: true, force: true }),
    ]);
  }
  let telemetry: SessionAudit | null = null;
  if (sessionFile) {
    try {
      telemetry = await auditSession(ROOT, sessionFile);
    } catch (failure) {
      error ??= `Session audit failed: ${failure instanceof Error ? failure.message : String(failure)}`;
    }
  }
  return {
    id: spec.id,
    spec,
    startedAt: startedAt.toISOString(),
    wallMs: Date.now() - startedAt.getTime(),
    status: feed.state.complete ? "complete" : error ? "error" : "incomplete",
    error,
    stopReason,
    providerError,
    nudges,
    turns,
    feed: {
      delivered: feed.state.delivered,
      total: task.chunks.length,
      rejectedCalls: feed.state.rejectedCalls,
      compactToolCalls: feed.state.compactions,
    },
    score: scoreTask(task, feed.state.answers),
    basePromptTokens,
    externalWrites,
    refusals,
    telemetry,
    sessionFile,
  };
}

export async function createSession(input: {
  spec: RunSpec;
  userAgentDir: string;
  agentDir: string;
  workspace: string;
  sessionDir: string;
  extension: ReturnType<typeof createFeed>["extension"];
}) {
  const { spec, agentDir, workspace } = input;
  const condition = CONDITIONS[spec.condition];
  const modelRuntime = await ModelRuntime.create({
    authPath: join(input.userAgentDir, "auth.json"),
    modelsPath: join(input.userAgentDir, "models.json"),
    modelsStorePath: join(input.userAgentDir, "models-store.json"),
  });
  // An explicit key for this process only, for providers whose stored key needs an interactive
  // helper such as a password manager.
  const apiKey = process.env.PIT_EVAL_API_KEY;
  if (apiKey) await modelRuntime.setRuntimeApiKey(spec.provider, apiKey);
  const base = modelRuntime.getModel(spec.provider, spec.model);
  if (!base) throw new Error(`Unknown model ${spec.provider}/${spec.model}`);
  const reserve = Math.round(spec.contextWindow / 4);
  const settingsManager = SettingsManager.inMemory(
    { compaction: { enabled: true, reserveTokens: reserve, keepRecentTokens: reserve } },
    { projectTrusted: true },
  );
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: condition.pit ? [join(ROOT, "src", "index.ts")] : [],
    additionalSkillPaths: condition.skill
      ? [join(ROOT, "eval", "context", "skills", "pit-context")]
      : [],
    extensionFactories: [input.extension],
  });
  await resourceLoader.reload();
  await mkdir(input.sessionDir, { recursive: true });
  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir,
    modelRuntime,
    model: { ...base, contextWindow: spec.contextWindow },
    thinkingLevel: spec.thinking,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.create(workspace, input.sessionDir),
  });
  // SDK sessions emit session_start only here. Pit resolves allowedTools, loads functions, and
  // restores notes on it, as it does in Pi's own modes.
  await session.bindExtensions({});
  return session;
}

export function resultPath(outDir: string, id: string): string {
  return join(outDir, "runs", `${id}.json`);
}

async function main() {
  const specFile = process.argv[2];
  if (!specFile) throw new Error("Usage: node --import tsx eval/context/worker.ts <spec.json>");
  const spec = JSON.parse(await readFile(specFile, "utf8")) as RunSpec;
  const result = await runOne(spec);
  const file = resultPath(spec.outDir, spec.id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `${spec.id}: ${result.status}, ${result.score.correct}/${result.score.total} correct, ${result.turns} turns, ${Math.round(result.wallMs / 1000)}s${result.error ? `, ${result.error}` : ""}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((failure: unknown) => {
    console.error(failure);
    process.exitCode = 1;
  });
}
