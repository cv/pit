import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { loadSkillsFromDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";

import { createFunctionState, reconcileFunctionState } from "../../src/functions/state.js";
import {
  loadProjectFunctionConfig,
  loadProjectFunctions,
} from "../../src/functions/storage/project.js";
import { prepareSandboxProgram } from "../../src/sandbox/program.js";
import { validateTypeScript } from "../../src/sandbox/validation.js";

const { skills, diagnostics } = loadSkillsFromDir({
  dir: resolve(".pi/skills"),
  source: "project",
});
const examples: Array<{ name: string; source: string }> = [];
for (const skill of skills) {
  const lines = readFileSync(skill.filePath, "utf8").split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]?.trim() !== "```ts pit-example") continue;
    const start = index + 1;
    const name = `${relative(process.cwd(), skill.filePath)}:${start + 1}`;
    while (++index < lines.length && lines[index]?.trim() !== "```") {
      /* Find the closing fence. */
    }
    if (index === lines.length) throw new Error(`Unclosed Pit example at ${name}`);
    examples.push({ name, source: lines.slice(start, index).join("\n") });
  }
}

const state = createFunctionState();
let config: Awaited<ReturnType<typeof loadProjectFunctionConfig>>;
let errors: string[];
beforeAll(async () => {
  const ctx = { cwd: process.cwd(), isProjectTrusted: () => true } as ExtensionContext;
  config = await loadProjectFunctionConfig(ctx);
  state.projectEnabled = config.enabled;
  errors = await loadProjectFunctions(ctx, state.projectCandidates, state.candidateMetadata, {
    user: state.user,
  });
  errors.push(...reconcileFunctionState(state));
}, 30_000);

describe("project agent workflow resources", () => {
  it("discovers and type-checks the trusted project's complete workflow graph", () => {
    expect(config).toMatchObject({ enabled: true });
    expect(config.error).toBeUndefined();
    expect(errors).toEqual([]);
    expect(state.project.size).toBeGreaterThan(0);
    expect(() =>
      validateTypeScript("async ({}) => null", new Map(), undefined, {
        environment: { projectFunctions: state.project, userFunctions: state.user },
        checkAll: true,
      }),
    ).not.toThrow();
    // Full graph validation can pass 15 s on contended CI runners with coverage enabled.
  });

  it("does not enable repository workflows without project trust", async () => {
    const ctx = { cwd: process.cwd(), isProjectTrusted: () => false } as ExtensionContext;
    expect(await loadProjectFunctionConfig(ctx)).toMatchObject({ enabled: false });
  });

  it("discovers usable workflow skills and executable examples without pinning prose or inventory", () => {
    const requiredSkills = ["pit-delivery", "pit-terminal-ux", "pit-test-audit"];
    expect(diagnostics).toEqual([]);
    expect(skills.map((skill) => skill.name)).toEqual(expect.arrayContaining(requiredSkills));
    for (const skill of skills.filter((entry) => requiredSkills.includes(entry.name))) {
      expect(skill.description.trim().length).toBeGreaterThan(0);
      expect(skill.disableModelInvocation).toBe(false);
    }
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(examples)("type-checks $name without executing helper effects", async ({ source }) => {
    const program = await prepareSandboxProgram(source, {
      projectFunctions: state.project,
      userFunctions: state.user,
    });
    expect(program.compiled.length).toBeGreaterThan(0);
  });
});
