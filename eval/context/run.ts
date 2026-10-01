/**
 * Runs the context-management evaluation matrix (#205): models × conditions × tasks × seeds.
 * Each run is a worker process. Finished runs are skipped on a rerun with the same --out, so an
 * interrupted evaluation resumes. See eval/context/README.md.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { CONDITION_IDS, type ConditionId, isConditionId } from "./conditions.js";
import { writeReport } from "./report.js";
import { DEFAULT_SIZE, estimateTokens, generateTask, TASK_KINDS, type TaskKind } from "./tasks.js";
import {
  type Memory,
  MEMORY_MODES,
  ROOT,
  resultPath,
  type RunSpec,
  type Thinking,
  THINKING_LEVELS,
} from "./worker.js";

const USAGE = `Usage: npm run eval:context -- --models <provider/model,...> [options]

  --models           Comma-separated provider/model IDs (required)
  --conditions       Subset of ${CONDITION_IDS.join(",")} (default: all)
  --tasks            Subset of ${TASK_KINDS.join(",")} (default: all)
  --seeds            Comma-separated integers (default: 1,2,3)
  --window           Evaluation context window in tokens (default: 32000)
  --chunks           Chunks per task (default: ${DEFAULT_SIZE.chunks})
  --chunk-tokens     Tokens per chunk (default: ${DEFAULT_SIZE.chunkTokens})
  --notice-tokens    Condition E's extra notice levels in tokens (default: 20% of --window)
  --thinking         ${THINKING_LEVELS.join("|")} (default: off)
  --memory           files: workspace files allowed; context: keep everything in the conversation (default: files)
  --concurrency      Parallel runs (default: 2)
  --max-nudges       Continue prompts after an early stop (default: 3)
  --timeout-minutes  Per-run limit (default: 45)
  --out              Results directory (default: eval/context/results/<timestamp>)
  --dry-run          Print the matrix without calling a model
`;

function integers(value: string, name: string, min: number, max: number): number[] {
  const values = value.split(",").map((item) => Number(item.trim()));
  if (
    values.length === 0 ||
    values.some((item) => !Number.isInteger(item) || item < min || item > max)
  ) {
    throw new Error(`--${name} needs integers from ${min} to ${max}`);
  }
  return values;
}

function integer(value: string, name: string, min: number, max: number): number {
  const [parsed] = integers(value, name, min, max);
  if (parsed === undefined || value.includes(",")) throw new Error(`--${name} needs one integer`);
  return parsed;
}

function list<T extends string>(
  value: string,
  name: string,
  allowed: (item: string) => item is T,
): T[] {
  const items = value.split(",").map((item) => item.trim());
  const unknown = items.filter((item) => !allowed(item));
  if (unknown.length > 0) throw new Error(`Unknown --${name}: ${unknown.join(", ")}`);
  return items as T[];
}

const isTaskKind = (value: string): value is TaskKind =>
  (TASK_KINDS as readonly string[]).includes(value);
const isMemory = (value: string): value is Memory =>
  (MEMORY_MODES as readonly string[]).includes(value);
const isThinking = (value: string): value is Thinking =>
  (THINKING_LEVELS as readonly string[]).includes(value);
const slug = (value: string) => value.replace(/[^a-zA-Z0-9.]+/g, "-").replace(/^-|-$/g, "");

export function parseRun(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      models: { type: "string" },
      conditions: { type: "string", default: CONDITION_IDS.join(",") },
      tasks: { type: "string", default: TASK_KINDS.join(",") },
      seeds: { type: "string", default: "1,2,3" },
      window: { type: "string", default: "32000" },
      chunks: { type: "string", default: String(DEFAULT_SIZE.chunks) },
      "chunk-tokens": { type: "string", default: String(DEFAULT_SIZE.chunkTokens) },
      "notice-tokens": { type: "string" },
      thinking: { type: "string", default: "off" },
      memory: { type: "string", default: "files" },
      concurrency: { type: "string", default: "2" },
      "max-nudges": { type: "string", default: "3" },
      "timeout-minutes": { type: "string", default: "45" },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.models) return null;
  const models = values.models.split(",").map((value) => {
    const slash = value.indexOf("/");
    if (slash < 1 || slash === value.length - 1)
      throw new Error(`--models needs provider/model, not ${value}`);
    return { provider: value.slice(0, slash).trim(), model: value.slice(slash + 1).trim() };
  });
  const thinking = values.thinking;
  const memory = values.memory;
  if (!isMemory(memory)) throw new Error(`--memory must be one of ${MEMORY_MODES.join(", ")}`);
  if (!isThinking(thinking))
    throw new Error(`--thinking must be one of ${THINKING_LEVELS.join(", ")}`);
  const contextWindow = integer(values.window, "window", 8000, 2_000_000);
  const size = {
    chunks: integer(values.chunks, "chunks", 4, 400),
    chunkTokens: integer(values["chunk-tokens"], "chunk-tokens", 500, 50_000),
  };
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    models,
    conditions: list<ConditionId>(values.conditions, "conditions", isConditionId),
    tasks: list<TaskKind>(values.tasks, "tasks", isTaskKind),
    seeds: integers(values.seeds, "seeds", 0, 1_000_000),
    contextWindow,
    size,
    noticeTokens: values["notice-tokens"]
      ? integers(values["notice-tokens"], "notice-tokens", 1000, contextWindow)
      : [Math.round(contextWindow * 0.2)],
    thinking,
    memory,
    concurrency: integer(values.concurrency, "concurrency", 1, 16),
    maxNudges: integer(values["max-nudges"], "max-nudges", 0, 20),
    timeoutMs: integer(values["timeout-minutes"], "timeout-minutes", 1, 600) * 60_000,
    outDir: resolve(values.out ?? join(ROOT, "eval", "context", "results", timestamp)),
    dryRun: values["dry-run"],
  };
}

export type RunOptions = NonNullable<ReturnType<typeof parseRun>>;

/** Seeds outermost and conditions innermost, so a partial evaluation stays balanced. */
export function matrix(options: RunOptions): RunSpec[] {
  const specs: RunSpec[] = [];
  for (const seed of options.seeds) {
    for (const task of options.tasks) {
      for (const { provider, model } of options.models) {
        for (const condition of options.conditions) {
          specs.push({
            id: [
              slug(`${provider}-${model}`),
              condition,
              task,
              `s${seed}`,
              ...(options.memory === "files" ? [] : [options.memory]),
            ].join("--"),
            provider,
            model,
            thinking: options.thinking,
            memory: options.memory,
            condition,
            task,
            seed,
            size: options.size,
            contextWindow: options.contextWindow,
            noticeTokens: options.noticeTokens,
            outDir: options.outDir,
            maxNudges: options.maxNudges,
            timeoutMs: options.timeoutMs,
          });
        }
      }
    }
  }
  return specs;
}

async function runWorker(spec: RunSpec): Promise<void> {
  const specFile = join(spec.outDir, "specs", `${spec.id}.json`);
  await writeFile(specFile, `${JSON.stringify(spec, null, 2)}\n`);
  const log = createWriteStream(join(spec.outDir, "logs", `${spec.id}.log`));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(ROOT, "eval", "context", "worker.ts"), specFile],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (data: Buffer) => {
    log.write(data);
    process.stdout.write(data);
  });
  child.stderr.pipe(log);
  const code = await new Promise<number | null>((done) => child.on("close", done));
  log.end();
  if (code !== 0) console.error(`${spec.id}: worker exited with ${code}; see logs/${spec.id}.log`);
}

async function main() {
  const options = parseRun(process.argv.slice(2));
  if (!options) {
    console.log(USAGE);
    return;
  }
  const specs = matrix(options);
  const pending = specs.filter((spec) => !existsSync(resultPath(spec.outDir, spec.id)));
  const streamed = options.tasks.map((task) => {
    const generated = generateTask(task, options.seeds[0] ?? 1, options.size);
    const tokens = generated.chunks.reduce((sum, chunk) => sum + estimateTokens(chunk.text), 0);
    const questions = generated.chunks.reduce((sum, chunk) => sum + chunk.questions.length, 0);
    return `${task} ~${Math.round(tokens / 1000)}K tokens, ${questions} questions`;
  });
  console.log(
    `${specs.length} runs (${pending.length} pending) in ${options.outDir}\nwindow ${options.contextWindow} tokens; ${streamed.join("; ")}`,
  );
  if (options.dryRun) {
    for (const spec of pending) console.log(`  ${spec.id}`);
    return;
  }
  await Promise.all(
    ["runs", "specs", "logs", "sessions"].map((name) =>
      mkdir(join(options.outDir, name), { recursive: true }),
    ),
  );
  const queue = [...pending];
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, queue.length) }, async () => {
      for (let spec = queue.shift(); spec; spec = queue.shift()) await runWorker(spec);
    }),
  );
  console.log(`Summary: ${await writeReport(options.outDir)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(ROOT, "eval", "context", "run.ts")) {
  main().catch((failure: unknown) => {
    console.error(failure instanceof Error ? failure.message : failure);
    process.exitCode = 1;
  });
}
