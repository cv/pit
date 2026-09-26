import { describe, expect, it, vi } from "vitest";

import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

function repository(options: {
  tracked: string[];
  changed: string[];
  staged?: string[];
  ignored?: string[];
  upstream?: string | null;
}) {
  const staged = new Set(options.staged ?? []);
  const calls: string[][] = [];
  const execFile = vi.fn(async (program: string, args: string[]) => {
    if (program !== "git" || args[0] !== "--literal-pathspecs") {
      throw new Error(`unexpected command ${program} ${args.join(" ")}`);
    }
    const command = args.slice(1);
    calls.push(command);
    const paths = command.includes("--") ? command.slice(command.indexOf("--") + 1) : [];
    switch (command[0]) {
      case "diff":
        return processResult({ stdout: [...staged].map((path) => `${path}\0`).join("") });
      case "ls-files":
        return processResult({
          stdout: options.tracked
            .filter((file) => paths.some((path) => file === path || file.startsWith(`${path}/`)))
            .map((file) => `${file}\0`)
            .join(""),
        });
      case "add":
        for (const path of paths) {
          if (options.ignored?.includes(path)) {
            throw new Error(`The following paths are ignored: ${path}`);
          }
          if (options.changed.includes(path)) staged.add(path);
        }
        return processResult();
      case "rev-parse":
        if (command.includes("@{u}")) {
          return options.upstream
            ? processResult({ stdout: `${options.upstream}\n` })
            : processResult({ code: 128, stderr: "no upstream" });
        }
        return processResult({ stdout: "abc123\nfeature\n" });
      default:
        throw new Error(`unexpected git ${command.join(" ")}`);
    }
  });
  const commit = vi.fn().mockResolvedValue(processResult());
  const push = vi.fn().mockResolvedValue(processResult());
  return { dependencies: { shell: { execFile }, git: { commit, push } }, calls, commit, push };
}

describe("delivery.commit", () => {
  it("stages tracked edits with -u and new files normally, then commits exactly them", async () => {
    const commitChanges = await loadWorkflowFunction("delivery.commit");
    const repo = repository({
      tracked: [".pi/functions/a.ts", "README.md"],
      changed: [".pi/functions/a.ts", "test/new.test.ts"],
    });
    const result = await commitChanges(repo.dependencies, {
      files: ["./.pi/functions/a.ts", "test/new.test.ts"],
      message: "feat: add helper\n\nDetails.",
    });
    expect(result).toEqual({
      sha: "abc123",
      branch: "feature",
      subject: "feat: add helper",
      files: [".pi/functions/a.ts", "test/new.test.ts"],
      pushed: false,
      upstream: null,
    });
    expect(repo.calls.map((call) => call.join(" "))).toEqual([
      "diff --cached --name-only --no-renames -z",
      "ls-files -z -- .pi/functions/a.ts test/new.test.ts",
      "add -u -- .pi/functions/a.ts",
      "add -- test/new.test.ts",
      "diff --cached --name-only --no-renames -z",
      "rev-parse HEAD --abbrev-ref HEAD",
    ]);
    expect(repo.commit).toHaveBeenCalledWith(
      ["-m", "feat: add helper\n\nDetails."],
      expect.objectContaining({ raise: true }),
    );
    expect(repo.push).not.toHaveBeenCalled();
  });

  it("refuses unrelated staged changes before staging anything", async () => {
    const commitChanges = await loadWorkflowFunction("delivery.commit");
    const repo = repository({ tracked: ["a.ts"], changed: ["a.ts"], staged: ["other.ts"] });
    await expect(
      commitChanges(repo.dependencies, { files: ["a.ts"], message: "fix: a" }),
    ).rejects.toThrow("Unrelated changes are already staged: other.ts");
    expect(repo.calls).toHaveLength(1);
    expect(repo.commit).not.toHaveBeenCalled();
  });

  it.each<{ name: string; tracked: string[]; changed: string[]; files: string[]; error: string }>([
    {
      name: "a listed file without changes",
      tracked: ["a.ts", "b.ts"],
      changed: ["a.ts"],
      files: ["a.ts", "b.ts"],
      error: "unchanged: b.ts",
    },
    {
      name: "a directory path",
      tracked: ["src/a.ts"],
      changed: ["src/a.ts"],
      files: ["src"],
      error: "not directories: src",
    },
  ])("does not commit $name", async ({ tracked, changed, files, error }) => {
    const commitChanges = await loadWorkflowFunction("delivery.commit");
    const repo = repository({ tracked, changed });
    await expect(commitChanges(repo.dependencies, { files, message: "fix: a" })).rejects.toThrow(
      error,
    );
    expect(repo.commit).not.toHaveBeenCalled();
  });

  it("surfaces an ignored new file instead of forcing it", async () => {
    const commitChanges = await loadWorkflowFunction("delivery.commit");
    const repo = repository({ tracked: [], changed: ["secret.env"], ignored: ["secret.env"] });
    await expect(
      commitChanges(repo.dependencies, { files: ["secret.env"], message: "chore: add" }),
    ).rejects.toThrow("ignored");
    expect(repo.commit).not.toHaveBeenCalled();
  });

  it.each<{ name: string; upstream: string | null; args: string[]; expected: string }>([
    { name: "its upstream", upstream: "origin/feature", args: [], expected: "origin/feature" },
    {
      name: "a new upstream",
      upstream: null,
      args: ["-u", "origin", "feature"],
      expected: "origin/feature",
    },
  ])("pushes the current branch to $name", async ({ upstream, args, expected }) => {
    const commitChanges = await loadWorkflowFunction("delivery.commit");
    const repo = repository({ tracked: ["a.ts"], changed: ["a.ts"], upstream });
    const result = await commitChanges(repo.dependencies, {
      files: ["a.ts"],
      message: "fix: a",
      push: true,
    });
    expect(repo.push).toHaveBeenCalledWith(args, expect.objectContaining({ raise: true }));
    expect(result).toMatchObject({ pushed: true, upstream: expected });
  });

  it.each<{ name: string; input: Record<string, unknown> }>([
    { name: "no files", input: { files: [], message: "fix" } },
    { name: "an absolute path", input: { files: ["/etc/passwd"], message: "fix" } },
    { name: "parent traversal", input: { files: ["../outside.ts"], message: "fix" } },
    { name: "a newline in a path", input: { files: ["a\nb.ts"], message: "fix" } },
    { name: "a trailing slash", input: { files: ["src/"], message: "fix" } },
    { name: "a blank message", input: { files: ["a.ts"], message: "  " } },
  ])("rejects $name before running Git", async ({ input }) => {
    const commitChanges = await loadWorkflowFunction("delivery.commit");
    const repo = repository({ tracked: ["a.ts"], changed: ["a.ts"] });
    await expect(commitChanges(repo.dependencies, input)).rejects.toThrow();
    expect(repo.calls).toEqual([]);
    expect(repo.commit).not.toHaveBeenCalled();
  });
});
