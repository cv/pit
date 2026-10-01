/**
 * Summarizes evaluation results as Markdown tables: means with sample standard deviations over
 * seeds, by model, condition, and task.
 *
 * Usage: node --import tsx eval/context/report.ts <results-directory>
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CONDITIONS, type ConditionId } from "./conditions.js";
import type { Usage } from "./telemetry.js";
import type { RunResult } from "./worker.js";

export async function loadResults(outDir: string): Promise<RunResult[]> {
  const directory = join(outDir, "runs");
  const files = (await readdir(directory).catch(() => [])).filter((file) => file.endsWith(".json"));
  return Promise.all(
    files
      .sort()
      .map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8")) as RunResult),
  );
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Sample standard deviation; zero for fewer than two values. */
export function deviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1),
  );
}

/** `mean ± sd` with the given scale and digits; one value prints alone. */
export function spread(values: readonly number[], scale = 1, digits = 1): string {
  if (values.length === 0) return "–";
  const average = (mean(values) / scale).toFixed(digits);
  return values.length < 2
    ? average
    : `${average} ± ${(deviation(values) / scale).toFixed(digits)}`;
}

const promptTokens = (usage: Usage | undefined) =>
  usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;

/** Prompt-side tokens of every provider request, including compaction summaries. */
export function inputTokens(result: RunResult): number {
  const context = result.telemetry?.context;
  return promptTokens(context?.usage) + promptTokens(context?.compactions.usage);
}

/**
 * Relative token prices for comparing conditions when a provider reports no cost: uncached input
 * 1, cache reads 0.1, cache writes 1.25, and output 5, Anthropic's published ratios. Cache writes
 * matter because every context edit re-writes the cache from its earliest target onward.
 */
export const PRICE_RATIOS = { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 } as const;

const weighted = (usage: Usage | undefined) =>
  usage
    ? usage.input * PRICE_RATIOS.input +
      usage.cacheRead * PRICE_RATIOS.cacheRead +
      usage.cacheWrite * PRICE_RATIOS.cacheWrite +
      usage.output * PRICE_RATIOS.output
    : 0;

/** Input-token equivalents of every request, including compaction summaries. */
export function weightedTokens(result: RunResult): number {
  const context = result.telemetry?.context;
  return weighted(context?.usage) + weighted(context?.compactions.usage);
}

function cacheReads(result: RunResult): number {
  const context = result.telemetry?.context;
  return (context?.usage.cacheRead ?? 0) + (context?.compactions.usage.cacheRead ?? 0);
}

function cost(result: RunResult): number {
  const context = result.telemetry?.context;
  return (context?.usage.cost ?? 0) + (context?.compactions.usage.cost ?? 0);
}

/** Compactions the model asked for: Pit's session.compact() calls and condition B's tool calls. */
const modelCompactions = (run: RunResult) =>
  (run.telemetry?.context.compactions.modelRequested ?? 0) + (run.compactToolCalls ?? 0);

const operation = (result: RunResult, name: string) =>
  result.telemetry?.context.edits.byOperation[name] ?? 0;

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }
  return groups;
}

/** A model and memory mode; results without one predate the context mode and allowed files. */
const modelName = (result: RunResult) =>
  `${result.spec.provider}/${result.spec.model}, memory: ${result.spec.memory ?? "files"}`;
const conditionOrder = (a: string, b: string) => a.localeCompare(b);

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

const DISTANCES = [
  { label: "0–3", min: 0, max: 3 },
  { label: "4–11", min: 4, max: 11 },
  { label: "12+", min: 12, max: Number.POSITIVE_INFINITY },
];

function behaviorTable(byCondition: ReadonlyArray<[string, RunResult[]]>): string {
  const sum = (group: RunResult[], value: (run: RunResult) => number) =>
    group.reduce((total, run) => total + value(run), 0);
  return table(
    [
      "Condition",
      "Elide",
      "Summarize",
      "Note",
      "Freed K",
      "Reprefill K",
      "Notices",
      "Followed",
      "Elided re-reads",
      "Re-edited",
      "Nudges",
      "External writes",
      "Refusals",
    ],
    byCondition.map(([condition, group]) => {
      const shown = sum(group, (run) => run.telemetry?.context.notices.shown ?? 0);
      const followed = sum(group, (run) => run.telemetry?.context.notices.followed ?? 0);
      return [
        condition,
        spread(group.map((run) => operation(run, "elide"))),
        spread(group.map((run) => operation(run, "summarize"))),
        spread(group.map((run) => operation(run, "note"))),
        spread(
          group.map((run) => run.telemetry?.context.edits.tokensFreed ?? 0),
          1000,
        ),
        spread(
          group.map((run) => run.telemetry?.context.edits.reprefillTokens ?? 0),
          1000,
        ),
        spread(group.map((run) => run.telemetry?.context.notices.shown ?? 0)),
        shown === 0 ? "–" : `${followed}/${shown}`,
        spread(group.map((run) => run.telemetry?.context.churn.inspectedRemovedEntries ?? 0)),
        spread(group.map((run) => run.telemetry?.context.churn.reeditedEntries ?? 0)),
        spread(group.map((run) => run.nudges)),
        spread(group.map((run) => run.externalWrites ?? 0)),
        spread(group.map((run) => run.refusals ?? 0)),
      ];
    }),
  );
}

export function summarize(results: readonly RunResult[]): string {
  const sections: string[] = [];
  const scored = results.filter((result) => result.status !== "error");
  sections.push(
    `${results.length} runs: ${results.filter((r) => r.status === "complete").length} complete, ${results.filter((r) => r.status === "incomplete").length} incomplete, ${results.length - scored.length} errors. Errors are excluded below; incomplete runs score their unanswered questions as wrong. Values are mean ± sample standard deviation over runs.`,
  );
  for (const [model, runs] of groupBy(scored, modelName)) {
    const byCondition = [...groupBy(runs, (run) => run.spec.condition)].sort(([a], [b]) =>
      conditionOrder(a, b),
    );
    sections.push(`## ${model}`);
    sections.push(
      table(
        [
          "Condition",
          "Runs",
          "Accuracy %",
          "Input K",
          "Cache read K",
          "Weighted K",
          "Cost $",
          "Wall s",
          "Base prompt K",
          "Compactions (auto + model)",
        ],
        byCondition.map(([condition, group]) => [
          `${condition}: ${CONDITIONS[condition as ConditionId].label}`,
          String(group.length),
          spread(group.map((run) => 100 * run.score.accuracy)),
          spread(group.map(inputTokens), 1000, 0),
          spread(group.map(cacheReads), 1000, 0),
          spread(group.map(weightedTokens), 1000, 0),
          spread(group.map(cost), 1, 3),
          spread(
            group.map((run) => run.wallMs),
            1000,
            0,
          ),
          spread(
            group.map((run) => run.basePromptTokens),
            1000,
            1,
          ),
          `${spread(group.map((run) => (run.telemetry?.context.compactions.total ?? 0) - modelCompactions(run)))} + ${spread(group.map(modelCompactions))}`,
        ]),
      ),
    );
    sections.push("### Accuracy % by task");
    const tasks = [...new Set(runs.map((run) => run.spec.task))].sort();
    sections.push(
      table(
        ["Condition", ...tasks],
        byCondition.map(([condition, group]) => [
          condition,
          ...tasks.map((task) =>
            spread(
              group.filter((run) => run.spec.task === task).map((run) => 100 * run.score.accuracy),
            ),
          ),
        ]),
      ),
    );
    sections.push("### Weighted tokens (K) by task");
    sections.push(
      table(
        ["Condition", ...tasks],
        byCondition.map(([condition, group]) => [
          condition,
          ...tasks.map((task) =>
            spread(group.filter((run) => run.spec.task === task).map(weightedTokens), 1000, 0),
          ),
        ]),
      ),
    );
    sections.push("### Accuracy % by question distance in chunks");
    sections.push(
      table(
        ["Condition", ...DISTANCES.map((bucket) => bucket.label)],
        byCondition.map(([condition, group]) => [
          condition,
          ...DISTANCES.map((bucket) => {
            const answers = group.flatMap((run) =>
              run.score.answers.filter(
                (answer) => answer.distance >= bucket.min && answer.distance <= bucket.max,
              ),
            );
            if (answers.length === 0) return "–";
            const correct = answers.filter((answer) => answer.correct).length;
            return `${((100 * correct) / answers.length).toFixed(1)} (n=${answers.length})`;
          }),
        ]),
      ),
    );
    sections.push("### Context-editing behavior per run");
    sections.push(behaviorTable(byCondition));
  }
  const failed = results.filter((result) => result.status === "error");
  if (failed.length > 0) {
    sections.push("## Errors");
    sections.push(
      failed.map((result) => `- ${result.id}: ${result.error ?? "unknown"}`).join("\n"),
    );
  }
  return `${sections.join("\n\n")}\n`;
}

export async function writeReport(outDir: string): Promise<string> {
  const file = join(outDir, "summary.md");
  await writeFile(file, summarize(await loadResults(outDir)));
  return file;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("Usage: node --import tsx eval/context/report.ts <results-directory>");
    process.exitCode = 1;
  } else {
    writeReport(resolve(outDir)).then(
      (file) => console.log(file),
      (failure: unknown) => {
        console.error(failure);
        process.exitCode = 1;
      },
    );
  }
}
