import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatPitSkillsForPrompt } from "../../src/skill-prompt.js";
import { beforeAgentStart, cleanupHarness, setupHarness } from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("Pit skill prompt", () => {
  it("advertises model-invokable skills with Pit file-loading guidance", () => {
    const prompt = formatPitSkillsForPrompt([
      {
        name: "review<&>'",
        description: 'Review "changes" & report\nnext >',
        filePath: "/tmp/<review>&\"'/skill.md",
      },
      {
        name: "manual-only",
        description: "Only available through its command",
        filePath: "/tmp/manual/SKILL.md",
        disableModelInvocation: true,
      },
    ]);

    expect(prompt).toContain("<name>review&lt;&amp;&gt;&apos;</name>");
    expect(prompt).toContain(
      "<description>Review &quot;changes&quot; &amp; report\nnext &gt;</description>",
    );
    expect(prompt).toContain("<location>/tmp/&lt;review&gt;&amp;&quot;&apos;/skill.md</location>");
    expect(prompt).not.toContain("manual-only");
    expect(formatPitSkillsForPrompt([])).toBe("");
    expect(
      formatPitSkillsForPrompt([
        {
          name: "manual-only",
          description: "Manual",
          filePath: "/tmp/manual.md",
          disableModelInvocation: true,
        },
      ]),
    ).toBe("");
  });

  it("does not duplicate a native or previously injected skill catalog", () => {
    const skill = {
      name: "delivery",
      description: "Deliver completed changes",
      filePath: "/skills/delivery/SKILL.md",
    };

    expect(
      beforeAgentStart({
        systemPrompt: "base prompt\n\n<available_skills>native</available_skills>",
        systemPromptOptions: { selectedTools: ["typescript", "read"], skills: [skill] },
      }),
    ).toBeUndefined();
    expect(
      beforeAgentStart({
        systemPrompt: "custom prompt\n\n<available_skills>custom</available_skills>",
        systemPromptOptions: { selectedTools: ["typescript"], skills: [skill] },
      }),
    ).toBeUndefined();
  });

  it("uses the current loaded catalog after a resource refresh", () => {
    const first = beforeAgentStart({
      systemPrompt: "base prompt",
      systemPromptOptions: {
        skills: [{ name: "old-skill", description: "Old", filePath: "/skills/old.md" }],
      },
    });
    const refreshed = beforeAgentStart({
      systemPrompt: "base prompt",
      systemPromptOptions: {
        skills: [{ name: "new-skill", description: "New", filePath: "/skills/new.md" }],
      },
    });

    expect(first.systemPrompt).toContain("<name>old-skill</name>");
    expect(refreshed.systemPrompt).not.toContain("old-skill");
    expect(refreshed.systemPrompt).toContain("<name>new-skill</name>");
  });
  it("injects Pi's loaded skill catalog into Pit's system prompt", () => {
    const result = beforeAgentStart({
      systemPrompt: "base prompt",
      systemPromptOptions: {
        skills: [
          {
            name: "delivery",
            description: "Deliver completed changes",
            filePath: "/skills/delivery/SKILL.md",
          },
        ],
      },
    });

    expect(result.systemPrompt).toContain("base prompt");
    expect(result.systemPrompt).toContain("<available_skills>");
    expect(result.systemPrompt).toContain("<name>delivery</name>");
    expect(result.systemPrompt).toContain("<location>/skills/delivery/SKILL.md</location>");
  });
});
