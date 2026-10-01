import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { repoDriver, writeRepo } from "../../eval/context/repo/driver.js";
import { generateRepo } from "../../eval/context/repo/generate.js";
import type { Rounding } from "../../eval/context/repo/model.js";
import { scoreRepo } from "../../eval/context/repo/score.js";
import { fixedSources } from "../../eval/context/repo/sources.js";
import type { RunSpec } from "../../eval/context/worker.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pit-repo-test-"));
  roots.push(root);
  await writeRepo(root, files);
  return root;
}

const outcomes = (checks: ReadonlyArray<{ id: string; passed: boolean }>) =>
  Object.fromEntries(checks.map((check) => [check.id, check.passed]));

const ALL = [
  "T1",
  "T2",
  "T3",
  "T4",
  "T5",
  "T6",
  "T7",
  "T8",
  "RULE-cents",
  "RULE-legacy",
  "RULE-since",
  "REG",
];

describe("repository task", () => {
  it("generates the same repository for a seed and varies it across seeds", () => {
    expect(generateRepo(3)).toEqual(generateRepo(3));
    expect(generateRepo(4).params).not.toEqual(generateRepo(3).params);
  });

  // Seeds 1 and 2 use different rounding rules.
  it.each([1, 2])(
    "fails every ticket as shipped and passes them with the reference (seed %i)",
    async (seed) => {
      const task = generateRepo(seed);
      const root = await repository(task.files);
      const before = await scoreRepo(task, root, null);
      expect(outcomes(before.checks)).toEqual({
        ...Object.fromEntries(ALL.map((id) => [id, false])),
        "RULE-legacy": true,
        "RULE-since": true,
        REG: true,
      });
      // The shipped visible suite passes, so only the changelog fails ticket 8.
      expect(before.checks.find((check) => check.id === "T8")?.detail).toBe(
        "changelog lacks T1, T2, T3, T4, T5, T6, T7; no 2.4.0 heading",
      );
      await writeRepo(root, task.reference);
      const after = await scoreRepo(task, root, null);
      expect(outcomes(after.checks)).toEqual(Object.fromEntries(ALL.map((id) => [id, true])));
      expect(after.score).toMatchObject({ correct: 12, total: 12, accuracy: 1 });
    },
  );

  it("fails only the rounding tickets when halves follow the other rule", async () => {
    const task = generateRepo(1);
    const other: Rounding = task.params.rounding === "half-even" ? "half-up" : "half-even";
    const wrong = fixedSources({ ...task.params, rounding: other });
    const root = await repository({
      ...task.files,
      ...task.reference,
      "src/billing/discount.js": wrong["src/billing/discount.js"] ?? "",
      "src/billing/tax.js": wrong["src/billing/tax.js"] ?? "",
    });
    const { checks } = await scoreRepo(task, root, null);
    expect(checks.filter((check) => !check.passed).map((check) => check.id)).toEqual(["T2", "T5"]);
  });

  it("reports each broken standing rule and a leftover old name", async () => {
    const task = generateRepo(1);
    const root = await repository({ ...task.files, ...task.reference });
    await appendFile(join(root, "src/legacy/report.js"), "\n// local tweak\n");
    await appendFile(
      join(root, "src/billing/codes.js"),
      "\nexport const parsePercent = (text) => parseFloat(text);\n",
    );
    // A test of the deprecated alias is not a leftover caller.
    await writeFile(
      join(root, "test/billing/alias.test.js"),
      'import { calcTotal } from "../../src/billing/total.js";\n',
    );
    const daily = join(root, "src/reports/daily.js");
    await writeFile(daily, (await readFile(daily, "utf8")).replaceAll("orderTotal", "calcTotal"));
    const { checks } = await scoreRepo(task, root, null);
    expect(checks.filter((check) => !check.passed).map(({ id, detail }) => [id, detail])).toEqual([
      ["T7", "calcTotal still used in src/reports/daily.js"],
      ["RULE-cents", "parseFloat or toFixed in src/billing/codes.js"],
      ["RULE-legacy", "src/legacy/ changed"],
      ["RULE-since", "no @since 2.4: src/billing/codes.js:parsePercent"],
    ]);
  });

  it("sends tickets in order, skips an unreported one after its nudges, and dates the export rule", async () => {
    const spec = { seed: 1, maxNudges: 1, contextWindow: 64_000 } as RunSpec;
    const driver = repoDriver(spec);
    const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>();
    driver.extension({
      registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
    } as never);
    const done = (ticket: number) =>
      tools.get("ticket_done")?.execute("call", { ticket, summary: `did ${ticket}` });
    const root = await mkdtemp(join(tmpdir(), "pit-repo-driver-"));
    roots.push(root);
    await driver.prepare(root);
    expect(driver.firstPrompt).toContain("Ticket 1: Last night's CI run");
    expect(driver.firstPrompt).toContain("about 64K tokens");
    await expect(done(2)).rejects.toThrow("Ticket 1 is the current ticket.");
    await done(1);
    expect((await driver.next(root))?.text).toMatch(/^Ticket 2: /);
    expect(await driver.next(root)).toEqual({
      text: "Continue with ticket 2, and call ticket_done when it is finished.",
      nudge: true,
    });
    // An export added before ticket 4 predates the rule.
    await appendFile(join(root, "src/billing/discount.js"), "\nexport function early() {}\n");
    expect((await driver.next(root))?.text).toMatch(/^Ticket 3: /);
    await done(3);
    expect((await driver.next(root))?.text).toMatch(/^Ticket 4: Two more standing rules/);
    await writeFile(join(root, "src/billing/refunds.js"), "export function refundCents() {}\n");
    for (const ticket of [4, 5, 6, 7]) {
      await done(ticket);
      expect((await driver.next(root))?.text).toMatch(new RegExp(`^Ticket ${ticket + 1}: `));
    }
    expect(driver.complete()).toBe(false);
    await done(8);
    expect(await driver.next(root)).toBeNull();
    expect(driver.complete()).toBe(true);
    expect(driver.progress()).toMatchObject({
      done: [1, 3, 4, 5, 6, 7, 8],
      skipped: [2],
      rejectedCalls: 1,
    });
    const score = await driver.score(root);
    expect(score.answers.find((answer) => answer.id === "RULE-since")?.given).toBe(
      "no @since 2.4: src/billing/refunds.js:refundCents",
    );
  });
});
