import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { getProjectFunctionMetadata, validateTypeScript } from "../src/sandbox.js";

const functionFiles = [
  ["analyzePitSession", ".pi/pit/functions/analyzePitSession.ts"],
  ["validatePit", ".pi/pit/functions/validatePit.ts"],
  ["preparePitDelivery", ".pi/pit/functions/preparePitDelivery.ts"],
  ["waitForGitHubRun", ".pi/pit/functions/waitForGitHubRun.ts"],
] as const;

describe("project agent workflow resources", () => {
  it("defines valid composable trusted project functions", async () => {
    const entries = await Promise.all(
      functionFiles.map(async ([name, file]) => [name, await readFile(file, "utf8")] as const),
    );
    const registry = new Map(entries);
    for (const [name, source] of entries) {
      expect(getProjectFunctionMetadata(source)).toMatchObject({ name });
      expect(() => validateTypeScript(source, registry)).not.toThrow();
    }
  });

  it("uses bounded and non-duplicative delivery workflows", async () => {
    const [audit, validation, preparation, wait, skill] = await Promise.all([
      readFile(".pi/pit/functions/analyzePitSession.ts", "utf8"),
      readFile(".pi/pit/functions/validatePit.ts", "utf8"),
      readFile(".pi/pit/functions/preparePitDelivery.ts", "utf8"),
      readFile(".pi/pit/functions/waitForGitHubRun.ts", "utf8"),
      readFile(".pi/skills/pit-delivery/SKILL.md", "utf8"),
    ]);
    expect(audit).toContain("workflowFailureRatePercent");
    expect(audit).toContain('"gate"');
    expect(validation).toContain("Pit validation failed");
    expect(validation).toContain("raise: false");
    expect(preparation).not.toContain("validatePit(");
    expect(preparation).toContain('["--cached", "--check"]');
    expect(wait).toContain("setTimeout");
    expect(wait).not.toContain("shell.execFile");
    expect(skill).toContain("preparePitDelivery()");
    expect(skill).toContain("waitForGitHubRun({ id, repo, raise: true })");
  });

  it("enables project functions and provides the delivery skill", async () => {
    const config = JSON.parse(await readFile(".pi/pit.json", "utf8"));
    expect(config).toEqual({ projectFunctions: { enabled: true } });
    const skill = await readFile(".pi/skills/pit-delivery/SKILL.md", "utf8");
    expect(skill).toContain("name: pit-delivery");
    expect(skill).toContain("without** `Closes #...`");
    expect(await readFile("AGENTS.md", "utf8")).toContain("immediately preceding");
  });
});
