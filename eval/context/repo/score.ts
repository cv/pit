/**
 * Scores a finished repository task: hidden tests per ticket, the standing rules, the changelog,
 * and the visible suite, in a temporary copy of the workspace.
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import type { Score } from "../score.js";
import { type RepoTask, RULES_TICKET } from "./model.js";

export interface RepoCheck {
  id: string;
  /** The ticket that introduced the check, starting at 1. */
  ticket: number;
  passed: boolean;
  detail: string;
}

const SKIP = new Set([".git", "node_modules", ".pi"]);

/** Relative paths of the repository's files, without Git, dependencies, or Pi state. */
export async function readTree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files[relative(root, path)] = await readFile(path, "utf8");
    }
  };
  await walk(root);
  return files;
}

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

const EXPORT =
  /export\s+(?:async\s+)?function\s*\*?\s*(\w+)|export\s+(?:const|let|var|class)\s+(\w+)|export\s*\{([^}]*)\}/g;

/** `file:name` for every named export under src/. */
export function exportsOf(files: Readonly<Record<string, string>>): string[] {
  const names: string[] = [];
  for (const [file, source] of Object.entries(files)) {
    if (!file.startsWith("src/") || !file.endsWith(".js")) continue;
    for (const match of stripComments(source).matchAll(EXPORT)) {
      const listed = match[3]?.split(",").map(
        (item) =>
          item
            .trim()
            .split(/\s+as\s+/)
            .at(-1) ?? "",
      );
      for (const name of listed ?? [match[1] ?? match[2] ?? ""])
        if (name) names.push(`${file}:${name}`);
    }
  }
  return names;
}

/** Whether the declaration that defines an export has a JSDoc block with `@since 2.4`. */
function documented(source: string, name: string): boolean {
  const declaration = new RegExp(
    `(?:export\\s+)?(?:(?:async\\s+)?function\\s*\\*?\\s*${name}\\b|(?:const|let|var|class)\\s+${name}\\b)`,
  ).exec(source);
  if (!declaration) return false;
  const before = source.slice(0, declaration.index).trimEnd();
  if (!before.endsWith("*/")) return false;
  const block = before.slice(before.lastIndexOf("/**"));
  return /@since\s+2\.4\b/.test(block);
}

function run(args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      {
        cwd,
        timeout: 180_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, NODE_OPTIONS: "" },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
        resolve({ code, output: `${stdout}${stderr}` });
      },
    );
  });
}

/** Test name to outcome from TAP output; a repeated name passes only if every run passed. */
export function parseTap(output: string): Map<string, boolean> {
  const results = new Map<string, boolean>();
  for (const match of output.matchAll(/^\s*(not )?ok \d+ - (.+?)(?: # .*)?$/gm)) {
    const name = match[2] ?? "";
    results.set(name, (results.get(name) ?? true) && !match[1]);
  }
  return results;
}

function staticChecks(task: RepoTask, files: Record<string, string>, baseline: readonly string[]) {
  const js = Object.entries(files).filter(([file]) => file.endsWith(".js"));
  const floats = js
    .filter(([file]) => /^src\/(money|billing)\//.test(file) && file !== "src/money/format.js")
    .filter(([, source]) => /\bparseFloat\b|\.toFixed\s*\(/.test(stripComments(source)))
    .map(([file]) => file);
  const legacy = (tree: Record<string, string>) =>
    JSON.stringify(
      Object.entries(tree)
        .filter(([file]) => file.startsWith("src/legacy/"))
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  const known = new Set(baseline);
  const undocumented = exportsOf(files)
    .filter((key) => !known.has(key))
    .filter((key) => {
      const [file = "", name = ""] = key.split(":");
      return !documented(files[file] ?? "", name);
    });
  const oldName = js
    // Callers only: tests may still exercise the deprecated alias.
    .filter(([file]) => file.startsWith("src/"))
    .filter(([file]) => file !== "src/billing/total.js" && !file.startsWith("src/legacy/"))
    .filter(([, source]) => /\bcalcTotal\b/.test(stripComments(source)))
    .map(([file]) => file);
  return {
    floats,
    legacyChanged: legacy(files) !== legacy(task.files),
    undocumented,
    oldName,
  };
}

/**
 * Scores the workspace. `baseline` lists the exports present when the `@since 2.4` rule was set;
 * exports added later need the tag.
 */
export async function scoreRepo(
  task: RepoTask,
  workspace: string,
  baseline: readonly string[] | null,
): Promise<{ score: Score; checks: RepoCheck[] }> {
  const files = await readTree(workspace);
  const copy = await mkdtemp(join(tmpdir(), "pit-eval-score-"));
  try {
    await cp(workspace, copy, {
      recursive: true,
      filter: (source) => !/[/\\](\.git|node_modules)([/\\]|$)/.test(source),
    });
    const visible = await run(["--test"], copy);
    await mkdir(join(copy, "test-hidden"), { recursive: true });
    await Promise.all(
      task.hidden.map((suite) => writeFile(join(copy, "test-hidden", suite.file), suite.source)),
    );
    const hidden = await run(
      [
        "--test",
        "--test-reporter=tap",
        ...task.hidden.map((suite) => join("test-hidden", suite.file)),
      ],
      copy,
    );
    const results = parseTap(hidden.output);
    const statics = staticChecks(task, files, baseline ?? exportsOf(task.files));
    const checks: RepoCheck[] = task.hidden.map((suite) => {
      const failed = suite.tests.filter((name) => results.get(name) !== true);
      const ticket = suite.check === "REG" ? 0 : Number(suite.check.slice(1));
      return {
        id: suite.check,
        ticket,
        passed: failed.length === 0,
        detail: failed.length === 0 ? "pass" : `failed: ${failed.slice(0, 5).join("; ")}`,
      };
    });
    const rename = checks.find((check) => check.id === "T7");
    if (rename && statics.oldName.length > 0) {
      rename.passed = false;
      rename.detail = `calcTotal still used in ${statics.oldName.join(", ")}`;
    }
    const changelog = files["CHANGELOG.md"] ?? "";
    const listed = new Set(
      [...changelog.matchAll(/^\s*[-*]\s*T([1-8])\s*:/gm)].map((match) => match[1]),
    );
    const missing = [1, 2, 3, 4, 5, 6, 7].filter((ticket) => !listed.has(String(ticket)));
    const heading = /^#+\s*\[?2\.4\.0\b/m.test(changelog);
    checks.push(
      {
        id: "T8",
        ticket: 8,
        passed: missing.length === 0 && heading && visible.code === 0,
        detail:
          [
            missing.length > 0 ? `changelog lacks T${missing.join(", T")}` : "",
            heading ? "" : "no 2.4.0 heading",
            visible.code === 0 ? "" : "visible suite fails",
          ]
            .filter(Boolean)
            .join("; ") || "pass",
      },
      {
        id: "RULE-cents",
        ticket: 2,
        passed: statics.floats.length === 0,
        detail:
          statics.floats.length === 0
            ? "pass"
            : `parseFloat or toFixed in ${statics.floats.join(", ")}`,
      },
      {
        id: "RULE-legacy",
        ticket: RULES_TICKET,
        passed: !statics.legacyChanged,
        detail: statics.legacyChanged ? "src/legacy/ changed" : "pass",
      },
      {
        id: "RULE-since",
        ticket: RULES_TICKET,
        passed: statics.undocumented.length === 0,
        detail:
          statics.undocumented.length === 0
            ? "pass"
            : `no @since 2.4: ${statics.undocumented.join(", ")}`,
      },
    );
    const correct = checks.filter((check) => check.passed).length;
    return {
      checks,
      score: {
        correct,
        total: checks.length,
        accuracy: correct / checks.length,
        answers: checks.map((check) => ({
          id: check.id,
          chunk: check.ticket,
          distance: -1,
          expected: "pass",
          given: check.detail,
          correct: check.passed,
        })),
      },
    };
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}
