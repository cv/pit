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

    for (const event of [
      {
        systemPrompt: "base prompt\n\n<available_skills>native</available_skills>",
        systemPromptOptions: { selectedTools: ["typescript", "read"], skills: [skill] },
      },
      {
        systemPrompt: "custom prompt\n\n<available_skills>custom</available_skills>",
        systemPromptOptions: { selectedTools: ["typescript"], skills: [skill] },
      },
      {
        systemPrompt: "base prompt\n\n<available_skills>bash</available_skills>",
        systemPromptOptions: { selectedTools: ["typescript", "bash"], skills: [skill] },
      },
    ]) {
      const { returned, sections } = beforeAgentStart(event);
      expect(returned).toBeUndefined();
      expect(sections).toEqual({});
    }
  });

  it.each<{ name: string; systemPrompt: string; options: Record<string, unknown> }>([
    {
      name: "an earlier handler replaced the prompt",
      systemPrompt: "earlier replacement",
      options: { forceSystemPrompt: "earlier replacement" },
    },
    {
      // Pi would have listed skills for read, but the replacement it sends has none.
      name: "an earlier handler replaced the prompt while read was selected",
      systemPrompt: "earlier replacement",
      options: { forceSystemPrompt: "earlier replacement", selectedTools: ["typescript", "read"] },
    },
    {
      name: "Pi before 0.86 has no prompt sections",
      systemPrompt: "base prompt",
      options: { sections: undefined },
    },
  ])("extends the replacement prompt when Pi would ignore sections: $name", (row) => {
    const skills = [{ name: "delivery", description: "Deliver", filePath: "/skills/delivery.md" }];
    const result = beforeAgentStart({
      systemPrompt: row.systemPrompt,
      systemPromptOptions: { skills, ...row.options },
    });

    expect(result.returned).toEqual({ systemPrompt: result.systemPrompt });
    expect(result.systemPrompt.startsWith(`${row.systemPrompt}\n\n`)).toBe(true);
    expect(result.systemPrompt).toContain("<name>delivery</name>");
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

    // A section lets Pi record a transcript delta instead of forcing an opaque prompt.
    expect(result.returned).toBeUndefined();
    expect(Object.keys(result.sections)).toEqual(["pit_skills"]);
    expect(result.systemPrompt).toContain("base prompt");
    expect(result.systemPrompt).toContain("<available_skills>");
    expect(result.systemPrompt).toContain("<name>delivery</name>");
    expect(result.systemPrompt).toContain("<location>/skills/delivery/SKILL.md</location>");
  });
});
