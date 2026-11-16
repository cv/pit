import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanupHarness, context, cwd, setupHarness, tool } from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

const SKILL_LINES = 30;

async function installSkill(name: string, lines = SKILL_LINES): Promise<void> {
  await mkdir(join(cwd, `skills/${name}/references`), { recursive: true });
  await writeFile(
    join(cwd, `skills/${name}/SKILL.md`),
    Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join("\n"),
  );
  await writeFile(join(cwd, `skills/${name}/references/guide.md`), "guide\n");
}

async function execute(code: string) {
  return tool.execute("skill-call", { code }, undefined, () => {}, context());
}

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function render(result: any, { expanded = false, width = 200 } = {}): string[] {
  const renderResult = tool.renderResult;
  if (!renderResult) throw new Error("typescript tool has no result renderer");
  return renderResult(result, { expanded, isPartial: false }, plainTheme, { args: {} })
    .render(width)
    .map((row) => stripTerminalSequences(row).trimEnd());
}

describe("skill reads", () => {
  it.each([
    {
      name: "a whole raw read",
      code: `read("skills/review/SKILL.md", { format: "raw" })`,
      headline: /^✓ \[skill\] review, 1-30 of 30, raw \(/,
    },
    {
      name: "a partial read",
      code: `read("skills/review/SKILL.md", { limit: 10 })`,
      headline: /^. \[skill\] review, 1-10 of 30, hashed, more available \(/,
    },
    {
      name: "a ranges read",
      code: `read("skills/review/SKILL.md", { ranges: [[3, 3], [5, 30]] })`,
      headline: /^✓ \[skill\] review, lines 3, 5-30 of 30, hashed \(/,
    },
  ])("heads $name of a skill file with its skill", async ({ code, headline }) => {
    await installSkill("review");
    const result = await execute(`async ({ workspace: { read } }) => ${code}`);
    const rows = render(result);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(headline);
  });

  it("lists the skills a batch or object returned, and warns about partial coverage", async () => {
    await installSkill("review");
    await installSkill("deploy");
    await writeFile(join(cwd, "notes.md"), "plain\n");
    const batch = await execute(`async ({ workspace: { batch } }) => batch([
      { kind: "read", file: "skills/review/SKILL.md", options: { limit: 10 } },
      { kind: "read", file: "skills/review/SKILL.md", options: { offset: 21, limit: 5 } },
      { kind: "read", file: "skills/deploy/SKILL.md" },
      { kind: "read", file: "skills/review/references/guide.md" },
      { kind: "read", file: "notes.md" },
    ])`);
    expect(render(batch).slice(1)).toEqual([
      "[skill] review ⚠ partial: lines 1-10, 21-25 of 30",
      "[skill] deploy",
    ]);

    const record = await execute(`async ({ workspace: { read } }) => ({
      skill: await read("skills/deploy/SKILL.md", { format: "raw" }),
      note: await read("notes.md"),
    })`);
    expect(render(record).slice(1)).toEqual(["[skill] deploy"]);
  });

  it("marks nothing for reads it did not return or files that are not skills", async () => {
    await installSkill("review");
    const unreturned = await execute(`async ({ workspace: { read } }) => {
      await read("skills/review/SKILL.md");
      return "done";
    }`);
    const reference = await execute(
      `async ({ workspace: { read } }) => read("skills/review/references/guide.md")`,
    );
    for (const result of [unreturned, reference]) {
      expect(render(result).join("\n")).not.toContain("[skill]");
    }
  });

  it("names the first four skills and counts the rest, within narrow terminals", async () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    for (const name of names) await installSkill(name, 1);
    const result = await execute(`async ({ workspace: { batch } }) => batch(
      ${JSON.stringify(names)}.map((name) => ({ kind: "read", file: "skills/" + name + "/SKILL.md" })),
    )`);
    expect(render(result).slice(1)).toEqual([
      "[skill] a",
      "[skill] b",
      "[skill] c",
      "[skill] d",
      "… 2 more: e, f",
    ]);
    expect(render(result, { width: 20 }).every((row) => visibleWidth(row) <= 20)).toBe(true);
  });

  it("keeps the skill headline when expanded", async () => {
    await installSkill("review");
    const result = await execute(
      `async ({ workspace: { read } }) => read("skills/review/SKILL.md", { format: "raw" })`,
    );
    const rows = render(result, { expanded: true });
    expect(rows.find((row) => row.includes("[skill]"))).toMatch(/\[skill\] review, 1-30 of 30/);
    expect(rows).toContain("line 30");
  });
});
