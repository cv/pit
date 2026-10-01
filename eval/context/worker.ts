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
  type ExtensionAPI,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { CONDITIONS, type ConditionId } from "./conditions.js";
import { createFeed } from "./feed.js";
import { createPressure } from "./pressure.js";
import { repoDriver } from "./repo/driver.js";
import { type Score, scoreTask } from "./score.js";
import { estimateTokens, generateTask, type Task, type TaskKind, type TaskSize } from "./tasks.js";
import { auditSession, type SessionAudit } from "./telemetry.js";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

/** files: the model may keep data in workspace files. context: it is asked to keep everything in the conversation. */
export const MEMORY_MODES = ["files", "context"] as const;
export type Memory = (typeof MEMORY_MODES)[number];

/** The realistic long task: a repository maintained through a sequence of tickets. */
export const REPO_TASK = "repo";
export type TaskId = TaskKind | typeof REPO_TASK;

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
  task: TaskId;
  seed: number;
  size: TaskSize;
  /** The evaluation model's reduced context window, in tokens. */
  contextWindow: number;
  /** Condition E's absolute notice levels, in tokens. */
  noticeTokens: number[];
  /** Absolute results directory. */
  outDir: string;
  /** Continue prompts after an early stop: per run for feed tasks, per ticket for the repository. */
  maxNudges: number;
  /** Where the model may keep data in feed tasks. The default is files. */
  memory?: Memory;
  timeoutMs: number;
}

export interface RunResult {
  id: string;
  spec: RunSpec;
  startedAt: string;
  wallMs: number;
  /** complete: the task finished. incomplete: the model stopped or a limit ended the run. */
  status: "complete" | "incomplete" | "error";
  error: string | null;
  /** The last assistant message's stop reason and error, when the provider reported one. */
  stopReason: string | null;
  providerError: string | null;
  nudges: number;
  turns: number;
  /** Task-specific progress, such as chunks delivered or tickets done. */
  progress: Record<string, unknown>;
  /** Successful compact_context calls (condition B). */
  compactToolCalls: number;
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

/** The next user message once the agent is idle. */
export interface Step {
  text: string;
  /** Whether it only asks the model to continue. */
  nudge: boolean;
}

/** A task's tools, prompts, and scoring; the worker owns the session. */
export interface Driver {
  extension: (pi: ExtensionAPI) => void;
  /** Tool name patterns Pit should expose directly (.pi/pit.json allowedTools). */
  allowedTools: string[];
  prepare(workspace: string): Promise<void>;
  firstPrompt: string;
  turnLimit: number;
  /** The next message, or null when the run is over. */
  next(workspace: string): Promise<Step | null>;
  /** The message that continues after a provider refusal. */
  resume(): string;
  complete(): boolean;
  progress(): Record<string, unknown>;
  score(workspace: string): Promise<Score>;
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
 * Claude models on Bedrock refused requests intermittently when the feed's filler was random
 * word salad; grammatical filler stopped that in testing. A run still continues after a refusal at
 * most this many more times beyond Pi's own retries; the count is reported, and the run fails if
 * refusals persist.
 */
export const REFUSAL_RETRIES = 10;
const REFUSAL = /refused/i;

export const NUDGE =
  "Continue the test: call feed_next, or feed_answer for pending questions, until feed_answer reports that the test is complete.";

function feedDriver(spec: RunSpec, kind: TaskKind): Driver {
  const task = generateTask(kind, spec.seed, spec.size);
  const feed = createFeed({ task });
  let nudges = 0;
  return {
    extension: feed.extension,
    allowedTools: ["feed_*"],
    prepare: async () => {},
    firstPrompt: taskPrompt(task, spec.contextWindow, spec.memory),
    turnLimit: task.chunks.length * 4 + 40,
    async next() {
      if (feed.state.complete || nudges >= spec.maxNudges) return null;
      nudges++;
      return { text: NUDGE, nudge: true };
    },
    resume: () => NUDGE,
    complete: () => feed.state.complete,
    progress: () => ({
      delivered: feed.state.delivered,
      total: task.chunks.length,
      rejectedCalls: feed.state.rejectedCalls,
    }),
    score: async () => scoreTask(task, feed.state.answers),
  };
}

interface Observed {
  turns: number;
  stopReason: string | null;
  providerError: string | null;
  error: string | null;
  basePromptTokens: number;
  externalWrites: number;
  refusals: number;
}

function observe(
  session: Awaited<ReturnType<typeof createSession>>,
  state: Observed,
  turnLimit: number,
) {
  return session.subscribe((event) => {
    if (event.type === "turn_end" && ++state.turns > turnLimit && !state.error) {
      state.error = `Stopped after ${turnLimit} turns`;
      void session.abort();
    }
    if (event.type !== "message_end" || !("role" in event.message)) return;
    const message = event.message as {
      role: string;
      stopReason?: string;
      errorMessage?: string;
      usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
      content?: unknown;
    };
    if (message.role !== "assistant") return;
    state.stopReason = message.stopReason ?? null;
    state.providerError = message.errorMessage?.split("\n")[0] ?? null;
    const usage = message.usage;
    state.basePromptTokens ||=
      (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
    state.externalWrites += externalWriteCalls(message.content);
    if (REFUSAL.test(message.errorMessage ?? "")) state.refusals++;
  });
}

/**
 * Prompts until the driver is done. It resumes after a model-requested compaction, which ends the
 * turn, and after refusals, but not after other provider failures.
 */
async function drive(
  session: Awaited<ReturnType<typeof createSession>>,
  driver: Driver,
  state: Observed,
  options: { workspace: string; settle: () => Promise<boolean> },
): Promise<number> {
  let nudges = 0;
  let refusalRetries = 0;
  await session.prompt(driver.firstPrompt);
  while (!state.error) {
    let text: string;
    if (await options.settle()) {
      // The compaction aborted the turn that requested it; that stop is not a provider failure.
      state.stopReason = null;
      text = driver.resume();
    } else if (state.stopReason === "error") {
      const refused = REFUSAL.test(state.providerError ?? "");
      if (driver.complete() || !refused || refusalRetries >= REFUSAL_RETRIES) break;
      refusalRetries++;
      text = driver.resume();
    } else {
      const step = await driver.next(options.workspace);
      if (!step) break;
      if (step.nudge) nudges++;
      text = step.text;
    }
    await session.prompt(text);
  }
  if (state.stopReason === "error" && !driver.complete()) {
    state.error ??= `Provider error: ${state.providerError ?? "unknown"}`;
  }
  return nudges;
}

export async function runOne(spec: RunSpec): Promise<RunResult> {
  const condition = CONDITIONS[spec.condition];
  const driver = spec.task === REPO_TASK ? repoDriver(spec) : feedDriver(spec, spec.task);
  const pressure = createPressure({
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
  const state: Observed = {
    turns: 0,
    stopReason: null,
    providerError: null,
    error: null,
    basePromptTokens: 0,
    externalWrites: 0,
    refusals: 0,
  };
  let nudges = 0;
  let sessionFile: string | null = null;
  let score: Score | null = null;
  try {
    await mkdir(join(workspace, ".pi"), { recursive: true });
    await writeFile(
      join(workspace, ".pi", "pit.json"),
      JSON.stringify({ allowedTools: [...driver.allowedTools, "compact_context"] }, null, 2),
    );
    await driver.prepare(workspace);
    const session = await createSession({
      spec,
      userAgentDir,
      agentDir,
      workspace,
      sessionDir,
      extensions: [driver.extension, pressure.extension],
    });
    const unsubscribe = observe(session, state, driver.turnLimit);
    const timer = setTimeout(() => {
      state.error ??= `Timed out after ${Math.round(spec.timeoutMs / 60_000)} minutes`;
      void session.abort();
    }, spec.timeoutMs);
    try {
      nudges = await drive(session, driver, state, { workspace, settle: pressure.settle });
    } finally {
      clearTimeout(timer);
      unsubscribe();
      sessionFile = session.sessionFile ?? null;
      session.dispose();
    }
  } catch (failure) {
    state.error ??= failure instanceof Error ? failure.message : String(failure);
  } finally {
    try {
      score = await driver.score(workspace);
    } catch (failure) {
      state.error ??= `Scoring failed: ${failure instanceof Error ? failure.message : String(failure)}`;
    }
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
      state.error ??= `Session audit failed: ${failure instanceof Error ? failure.message : String(failure)}`;
    }
  }
  return {
    id: spec.id,
    spec,
    startedAt: startedAt.toISOString(),
    wallMs: Date.now() - startedAt.getTime(),
    status: driver.complete() ? "complete" : state.error ? "error" : "incomplete",
    error: state.error,
    stopReason: state.stopReason,
    providerError: state.providerError,
    nudges,
    turns: state.turns,
    progress: driver.progress(),
    compactToolCalls: pressure.state.compactions,
    score: score ?? { correct: 0, total: 0, accuracy: 0, answers: [] },
    basePromptTokens: state.basePromptTokens,
    externalWrites: state.externalWrites,
    refusals: state.refusals,
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
  extensions: Array<(pi: ExtensionAPI) => void>;
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
    extensionFactories: input.extensions,
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
