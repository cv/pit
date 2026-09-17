import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { getPersistentFunctionMetadata } from "../../src/functions/source.js";
import { createFunctionState, reconcileFunctionState } from "../../src/functions/state.js";
import { loadProjectFunctions } from "../../src/functions/storage/project.js";
import { validateTypeScript } from "../../src/sandbox/validation.js";

const functionFiles = [
  ["analyzePitSession", ".pi/functions/analyzePitSession.ts"],
  ["analyzePitSessions", ".pi/functions/analyzePitSessions.ts"],
  ["auditPitCodeQuality", ".pi/functions/auditPitCodeQuality.ts"],
  ["formatPitChanges", ".pi/functions/formatPitChanges.ts"],
  ["findGitHubRunForCommit", ".pi/functions/findGitHubRunForCommit.ts"],
  ["inspectPitCoverageGaps", ".pi/functions/inspectPitCoverageGaps.ts"],
  ["inspectGitHubPullRequest", ".pi/functions/inspectGitHubPullRequest.ts"],
  ["managePullRequestWorktree", ".pi/functions/managePullRequestWorktree.ts"],
  ["preparePitDelivery", ".pi/functions/preparePitDelivery.ts"],
  ["reviewPitChanges", ".pi/functions/reviewPitChanges.ts"],
  ["runPitTargetedTests", ".pi/functions/runPitTargetedTests.ts"],
  ["validatePit", ".pi/functions/validatePit.ts"],
  ["waitForGitHubRun", ".pi/functions/waitForGitHubRun.ts"],
  ["waitForGitHubRunForCommit", ".pi/functions/waitForGitHubRunForCommit.ts"],
] as const;

describe("project agent workflow resources", () => {
  it("defines valid composable trusted project functions", async () => {
    const entries = await Promise.all(
      functionFiles.map(async ([name, file]) => [name, await readFile(file, "utf8")] as const),
    );
    const registry = new Map(entries);
    for (const [name, source] of entries) {
      expect(getPersistentFunctionMetadata(source)).toMatchObject({ name });
    }
    // Validation checks every saved implementation in the registry, not just the root.
    expect(() => validateTypeScript("async ({}) => null", registry)).not.toThrow();
  }, 15_000);

  it("loads and reconciles the complete project workflow graph", async () => {
    const state = createFunctionState();
    state.projectEnabled = true;
    const ctx = { cwd: process.cwd(), isProjectTrusted: () => true } as any;
    const errors = await loadProjectFunctions(
      ctx,
      state.projectCandidates,
      state.candidateMetadata,
      { user: state.user },
    );
    errors.push(...reconcileFunctionState(state));

    expect(errors).toEqual([]);
    expect([...state.project.keys()].sort()).toEqual(functionFiles.map(([name]) => name).sort());
  }, 15_000);

  it("provides bounded inner-loop workflow helpers", async () => {
    const [sessions, targeted, coverage, review, format, skill] = await Promise.all([
      readFile(".pi/functions/analyzePitSessions.ts", "utf8"),
      readFile(".pi/functions/runPitTargetedTests.ts", "utf8"),
      readFile(".pi/functions/inspectPitCoverageGaps.ts", "utf8"),
      readFile(".pi/functions/reviewPitChanges.ts", "utf8"),
      readFile(".pi/functions/formatPitChanges.ts", "utf8"),
      readFile(".pi/skills/pit-delivery/SKILL.md", "utf8"),
    ]);
    expect(sessions).toContain("analyzePitSession");
    expect(sessions).toContain("offset += 4");
    expect(targeted).toContain("Targeted tests must be safe");
    expect(targeted).toContain("raise: false");
    expect(coverage).toContain("cbranch-no|cstat-no|fstat-no");
    expect(review).toContain('["--cached", "--check"]');
    expect(format).toContain('"--write"');
    expect(format).toContain("oxfmt");
    expect(format).toContain("anchorsInvalidated");
    expect(skill).toContain("runPitTargetedTests");
    expect(skill).toContain("formatPitChanges()");
    expect(skill).toContain("auditPitCodeQuality");
    expect(skill).toContain("inspectGitHubPullRequest");
    expect(skill).toContain("managePullRequestWorktree");
  });

  it("uses bounded and non-duplicative delivery workflows", async () => {
    const [audit, validation, preparation, wait, skill] = await Promise.all([
      readFile(".pi/functions/analyzePitSession.ts", "utf8"),
      readFile(".pi/functions/validatePit.ts", "utf8"),
      readFile(".pi/functions/preparePitDelivery.ts", "utf8"),
      readFile(".pi/functions/waitForGitHubRun.ts", "utf8"),
      readFile(".pi/skills/pit-delivery/SKILL.md", "utf8"),
    ]);
    expect(audit).toContain("workflowFailureRatePercent");
    expect(audit).toContain('"gate"');
    expect(validation).toContain("Pit validation failed");
    expect(validation).toContain("raise: false");
    expect(preparation).not.toContain("validatePit(");
    expect(preparation).toContain('["--cached", "--check"]');
    expect(wait).toContain("setTimeout");
    expect(wait).toContain("input.initialDelayMs ?? 120000");
    expect(wait).not.toContain("shell.execFile");
    expect(skill).toContain("preparePitDelivery()");
    expect(skill).toContain("findGitHubRunForCommit({ repo, sha })");
    expect(skill).toContain("waitForGitHubRun({ id, repo, raise: true })");
    expect(skill).toContain("Trusted project functions own repeatable execution");
  });

  it("enables project functions and provides the delivery skill", async () => {
    const config = JSON.parse(await readFile(".pi/pit.json", "utf8"));
    expect(config).toEqual({ projectFunctions: { enabled: true } });
    const skill = await readFile(".pi/skills/pit-delivery/SKILL.md", "utf8");
    expect(skill).toContain("name: pit-delivery");
    expect(skill).toContain("without** `Closes #...`");
    expect(await readFile("AGENTS.md", "utf8")).toContain("immediately preceding");
  });

  it("packages the pit-reflect prompt for saved-function improvement", async () => {
    const [prompt, manifest] = await Promise.all([
      readFile("prompts/pit-reflect.md", "utf8"),
      readFile("package.json", "utf8").then((contents) => JSON.parse(contents)),
    ]);
    expect(prompt).toContain("description: Reflect on session work");
    expect(prompt).toContain("functions.listAll()");
    expect(prompt).toContain("functions.getSaved(name)");
    expect(prompt).toContain("functions.promote(name, summary)");
    expect(prompt).toContain("If no function change is justified");
    expect(manifest.files).toContain("prompts");
    expect(manifest.pi.prompts).toContain("./prompts");
    const projectSettings = JSON.parse(await readFile(".pi/settings.json", "utf8"));
    expect(projectSettings.prompts).toContain("../prompts");
  });
});
