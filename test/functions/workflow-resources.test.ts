import { resolve } from "node:path";

import { loadSkillsFromDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createFunctionState, reconcileFunctionState } from "../../src/functions/state.js";
import {
  loadProjectFunctionConfig,
  loadProjectFunctions,
} from "../../src/functions/storage/project.js";
import { validateTypeScript } from "../../src/sandbox/validation.js";

describe("project agent workflow resources", () => {
  it("discovers and type-checks the trusted project's complete workflow graph", async () => {
    const ctx = { cwd: process.cwd(), isProjectTrusted: () => true } as ExtensionContext;
    const config = await loadProjectFunctionConfig(ctx);
    expect(config).toMatchObject({ enabled: true });
    expect(config.error).toBeUndefined();
    const state = createFunctionState();
    state.projectEnabled = config.enabled;
    const errors = await loadProjectFunctions(
      ctx,
      state.projectCandidates,
      state.candidateMetadata,
      { user: state.user },
    );
    errors.push(...reconcileFunctionState(state));
    expect(errors).toEqual([]);
    expect(state.project.size).toBeGreaterThan(0);
    expect(() =>
      validateTypeScript("async ({}) => null", new Map(), undefined, {
        environment: { projectFunctions: state.project, userFunctions: state.user },
        checkAll: true,
      }),
    ).not.toThrow();
    // Type-checking every project function takes ~3 s alone but can pass 15 s on
    // contended CI runners with coverage enabled.
  }, 30_000);

  it("does not enable repository workflows without project trust", async () => {
    const ctx = { cwd: process.cwd(), isProjectTrusted: () => false } as ExtensionContext;
    expect(await loadProjectFunctionConfig(ctx)).toMatchObject({ enabled: false });
  });

  it("discovers usable workflow skills without pinning their prose or inventory", () => {
    const { skills, diagnostics } = loadSkillsFromDir({
      dir: resolve(".pi/skills"),
      source: "project",
    });
    expect(diagnostics).toEqual([]);
    expect(skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(["pit-delivery", "pit-terminal-ux"]),
    );
    for (const skill of skills.filter((entry) =>
      ["pit-delivery", "pit-terminal-ux"].includes(entry.name),
    )) {
      expect(skill.description.trim().length).toBeGreaterThan(0);
      expect(skill.disableModelInvocation).toBe(false);
    }
  });
});
