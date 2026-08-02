import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupHarness, setSlashCommands, setupHarness, value } from "./extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("commands capability", () => {
  it("lists slash commands with canonical provenance", async () => {
    setSlashCommands([
      {
        name: "review",
        description: "Review changes",
        source: "extension",
        sourceInfo: {
          path: "/tmp/review.ts",
          source: "review-package",
          scope: "project",
          origin: "package",
          baseDir: "/tmp",
        },
      },
      {
        name: "skill:delivery",
        source: "skill",
        sourceInfo: {
          path: "/tmp/SKILL.md",
          source: "delivery",
          scope: "user",
          origin: "top-level",
        },
      },
    ]);

    expect(await value("async ({ commands }) => commands.list()")).toEqual({
      commands: [
        {
          name: "review",
          description: "Review changes",
          source: "extension",
          sourceInfo: {
            path: "/tmp/review.ts",
            source: "review-package",
            scope: "project",
            origin: "package",
            baseDir: "/tmp",
          },
        },
        {
          name: "skill:delivery",
          source: "skill",
          sourceInfo: {
            path: "/tmp/SKILL.md",
            source: "delivery",
            scope: "user",
            origin: "top-level",
          },
        },
      ],
      truncated: false,
    });
  });

  it("bounds large command catalogs", async () => {
    setSlashCommands(
      Array.from({ length: 201 }, (_, index) => ({
        name: `command-${index}`,
        source: "prompt",
        sourceInfo: {
          path: `/tmp/${index}.md`,
          source: "test",
          scope: "temporary",
          origin: "top-level",
        },
      })),
    );
    expect(
      await value(`async ({ commands }) => {
        const result = await commands.list();
        return { count: result.commands.length, truncated: result.truncated };
      }`),
    ).toEqual({ count: 200, truncated: true });
  });
});
