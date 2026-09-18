import { describe, expect, it } from "vitest";

import {
  projectFunctionCatalog,
  userFunctionCatalog,
} from "../../src/functions/persistent-functions.js";
import type { PersistentFunctionMetadata } from "../../src/functions/source.js";
import { formatPitSkillsForPrompt } from "../../src/skill-prompt.js";
import { savedFunctionCatalogNotice } from "../../src/tool/typescript.js";
import { textSize } from "../support/prompt-metadata.js";

const projectDocs = new Map<string, PersistentFunctionMetadata>([
  [
    "company.check",
    {
      name: "company.check",
      signature: "company.check(input: { value: number })",
      summary: "Checks a value.",
      parameters: [{ name: "input.value", description: "Value to check." }],
    },
  ],
]);
const userDocs = new Map<string, PersistentFunctionMetadata>([
  [
    "format",
    {
      name: "format",
      signature: "format(value: string)",
      summary: "Formats café names.",
      parameters: [{ name: "value", description: "Name to format." }],
    },
  ],
]);

describe("dynamic prompt additions", () => {
  it.each<{ name: string; user: boolean; project: boolean; headings: number; budget: number }>([
    { name: "no catalogs", user: false, project: false, headings: 0, budget: 0 },
    { name: "project catalog", user: false, project: true, headings: 1, budget: 150 },
    { name: "user catalog", user: true, project: false, headings: 1, budget: 150 },
    { name: "both catalogs", user: true, project: true, headings: 2, budget: 300 },
  ])("measures $name without repeated tutorials", ({ user, project, headings, budget }) => {
    const parts = [
      userFunctionCatalog(user ? userDocs : new Map(), new Map(), new Map()),
      projectFunctionCatalog(project ? projectDocs : new Map()),
    ].filter(Boolean);
    const text = parts.join("\n\n");
    expect(text.match(/^## /gm) ?? []).toHaveLength(headings);
    expect(textSize(text).bytes).toBeLessThanOrEqual(budget);
    expect(text).not.toContain("Inject them by name");
    expect(text).not.toContain("first parameter");
    expect(text.includes("company.check(input: { value: number })")).toBe(project);
    expect(text.includes("input.value: Value to check.")).toBe(project);
    expect(text.includes("value: Name to format.")).toBe(user);
  });

  it("keeps canonical IDs and effective overrides without stale parameter docs", () => {
    const override = "async function check({}, input: { value: number }) { return input.value; }";
    const session = new Map([["company.check", override]]);
    const text = projectFunctionCatalog(projectDocs, session);
    expect(text).toContain(
      "company.check(input: { value: number }) — Session override of project function.",
    );
    expect(text).not.toContain("Value to check.");
    expect(userFunctionCatalog(projectDocs, session, new Map())).toBe("");
    expect(userFunctionCatalog(projectDocs, new Map(), session)).toBe("");
  });

  it("bounds each catalog in UTF-8 without splitting entries and retains discovery", () => {
    const docs = new Map(projectDocs);
    docs.set("huge", {
      name: "huge",
      signature: "huge()",
      summary: "é".repeat(13_000),
      parameters: [],
    });
    const project = projectFunctionCatalog(docs);
    const user = userFunctionCatalog(docs, new Map(), new Map());
    expect(project).toContain("company.check(input: { value: number })");
    expect(user).toContain("company.check(input: { value: number })");
    expect(project).toContain("1 more; use functions.list()");
    expect(user).toContain("1 more; use functions.listUser()");
    for (const catalog of [project, user]) {
      expect(catalog).not.toContain("huge()");
      expect(textSize(catalog).bytes).toBeLessThanOrEqual(12_000);
    }
  });

  it("accounts for session notices and skills separately, without weakening skill instructions", () => {
    const session = savedFunctionCatalogNotice(
      new Map([["company.check", "async function check({}) { return 42; }"]]),
    );
    expect(session).toContain("company.check()");
    expect(textSize(session).bytes).toBeLessThanOrEqual(1200);
    expect(textSize(savedFunctionCatalogNotice(new Map()))).toEqual({ characters: 0, bytes: 0 });
    const skills = formatPitSkillsForPrompt([
      {
        name: "visible",
        description: "Check <code> & paths",
        filePath: "/skills/visible/SKILL.md",
      },
      {
        name: "hidden",
        description: "Hidden",
        filePath: "/skills/hidden/SKILL.md",
        disableModelInvocation: true,
      },
    ]);
    expect(textSize(skills).bytes).toBeLessThanOrEqual(1000);
    expect(skills).toContain("Check &lt;code&gt; &amp; paths");
    expect(skills).toContain("Always read skill files in full");
    expect(skills).toContain("resolve it against the skill directory");
    expect(skills).not.toContain("hidden");
    expect(textSize(formatPitSkillsForPrompt([]))).toEqual({ characters: 0, bytes: 0 });
  });
});
