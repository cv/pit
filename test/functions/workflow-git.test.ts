import { describe, expect, it, vi } from "vitest";

import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

describe("listChangedGitFiles", () => {
  it.each<{ name: string; stdout: string; files: string[] }>([
    { name: "clean worktree", stdout: "", files: [] },
    {
      name: "staged, unstaged and untracked",
      stdout: " M b.ts\0A  a.ts\0?? c.ts\0MM b.ts\0",
      files: ["a.ts", "b.ts", "c.ts"],
    },
    { name: "deleted files in either column", stdout: " D a.ts\0D  b.ts\0AD c.ts\0", files: [] },
    {
      name: "rename and copy destinations",
      stdout: "R  new.ts\0old.ts\0 C copy.ts\0source.ts\0",
      files: ["copy.ts", "new.ts"],
    },
    {
      name: "literal special characters",
      stdout: "??  space.ts\0?? line\nbreak.ts\0?? café.ts\0?? a -> b.ts\0?? -flag.ts\0",
      files: [" space.ts", "-flag.ts", "a -> b.ts", "café.ts", "line\nbreak.ts"],
    },
  ])("lists $name without losing filenames", async ({ stdout, files }) => {
    const list = await loadWorkflowFunction("listChangedGitFiles");
    const status = vi.fn().mockResolvedValue(processResult({ stdout }));
    expect(await list({ git: { status } })).toEqual({ files });
    expect(status).toHaveBeenCalledWith(
      ["--porcelain=v1", "-z", "--untracked-files=all"],
      expect.objectContaining({ raise: true }),
    );
  });

  it.each<{ name: string; stdout: string; truncated?: boolean; error: string }>([
    { name: "truncated transport", stdout: "?? a.ts\0", truncated: true, error: "truncated" },
    { name: "incomplete record", stdout: "?? a.ts", error: "NUL-delimited" },
    { name: "invalid status", stdout: "garbage\0", error: "invalid porcelain" },
    { name: "missing rename source", stdout: "R  new.ts\0", error: "original path" },
    { name: "merge conflict", stdout: "UU conflict.ts\0", error: "conflicts" },
    { name: "delete conflict", stdout: "UD conflict.ts\0", error: "conflicts" },
    {
      name: "too many paths",
      stdout: Array.from({ length: 501 }, (_, i) => `?? ${i}.ts\0`).join(""),
      error: "500",
    },
  ])(
    "rejects $name rather than returning a partial list",
    async ({ stdout, truncated = false, error }) => {
      const list = await loadWorkflowFunction("listChangedGitFiles");
      const status = vi.fn().mockResolvedValue(processResult({ stdout, truncated }));
      await expect(list({ git: { status } })).rejects.toThrow(error);
    },
  );
});

describe("formatPitChanges", () => {
  it.each<{ name: string; checkOnly: boolean; code: number }>([
    { name: "successful write", checkOnly: false, code: 0 },
    { name: "successful check", checkOnly: true, code: 0 },
    { name: "failed check", checkOnly: true, code: 1 },
  ])("reports $name and invalidates anchors only for writes", async ({ checkOnly, code }) => {
    const format = await loadWorkflowFunction("formatPitChanges");
    const listChangedGitFiles = vi
      .fn()
      .mockResolvedValue({ files: ["-flag.ts", " space.ts", "image.png"] });
    const execFile = vi.fn().mockResolvedValue(processResult({ code, stdout: "formatter output" }));
    const files = ["-flag.ts", " space.ts"];
    expect(await format({ listChangedGitFiles, shell: { execFile } }, { checkOnly })).toMatchObject(
      {
        files,
        formatted: code === 0,
        changed: !checkOnly && code === 0,
        anchorsInvalidated: checkOnly ? [] : files,
      },
    );
    expect(execFile).toHaveBeenCalledWith(
      "npx",
      ["oxfmt", checkOnly ? "--check" : "--write", "--", ...files],
      expect.objectContaining({ raise: false }),
    );
    expect(listChangedGitFiles).toHaveBeenCalledOnce();
  });

  it("does not start a formatter when there are no supported files", async () => {
    const format = await loadWorkflowFunction("formatPitChanges");
    const execFile = vi.fn();
    expect(
      await format({
        listChangedGitFiles: async () => ({ files: ["image.png"] }),
        shell: { execFile },
      }),
    ).toMatchObject({ files: [], changed: false });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("rejects oversized work before any mutation", async () => {
    const format = await loadWorkflowFunction("formatPitChanges");
    const execFile = vi.fn();
    const files = Array.from({ length: 101 }, (_, i) => `${i}.ts`);
    await expect(
      format({ listChangedGitFiles: async () => ({ files }), shell: { execFile } }),
    ).rejects.toThrow("partial list");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("stops after inspection failure without invoking the formatter", async () => {
    const format = await loadWorkflowFunction("formatPitChanges");
    const execFile = vi.fn();
    const listChangedGitFiles = vi.fn().mockRejectedValue(new Error("Git failed"));
    await expect(format({ listChangedGitFiles, shell: { execFile } })).rejects.toThrow(
      "Git failed",
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  it("warns that a failed write can invalidate anchors", async () => {
    const format = await loadWorkflowFunction("formatPitChanges");
    const execFile = vi.fn().mockResolvedValue(processResult({ code: 1, stderr: "bad syntax" }));
    await expect(
      format({ listChangedGitFiles: async () => ({ files: ["a.ts"] }), shell: { execFile } }),
    ).rejects.toThrow(/re-read all attempted files[\s\S]*bad syntax/);
  });
});

describe("Git readiness and review composition", () => {
  it.each<{
    name: string;
    statusCode: number;
    diffCode: number;
    truncated: boolean;
    ready: boolean;
  }>([
    { name: "successful inspection", statusCode: 0, diffCode: 0, truncated: false, ready: true },
    { name: "status failure", statusCode: 128, diffCode: 0, truncated: false, ready: false },
    { name: "whitespace failure", statusCode: 0, diffCode: 2, truncated: false, ready: false },
    { name: "incomplete inspection", statusCode: 0, diffCode: 0, truncated: true, ready: false },
  ])("reports $name conservatively", async ({ statusCode, diffCode, truncated, ready }) => {
    const prepare = await loadWorkflowFunction("preparePitDelivery");
    const status = vi.fn().mockResolvedValue(
      processResult({
        code: statusCode,
        stdout: "branch",
        stderr: "status diagnostic",
        truncated,
      }),
    );
    const diff = vi.fn(async (args: string[]) => {
      if (!args.includes("--check")) return processResult({ stdout: "ordinary diff" });
      const scope = args.includes("--cached") ? "staged" : "unstaged";
      return processResult({
        code: diffCode,
        stdout: `${scope} check`,
        stderr: `${scope} diagnostic`,
      });
    });
    expect(await prepare({ git: { status, diff } })).toEqual({
      status: "branch\nstatus diagnostic",
      diffCheck: "unstaged check\nunstaged diagnostic",
      stagedDiffCheck: "staged check\nstaged diagnostic",
      truncated,
      ready,
    });
  });

  it("reuses readiness exactly once and fetches only the additional review data", async () => {
    const review = await loadWorkflowFunction("reviewPitChanges");
    const readiness = {
      status: "branch",
      diffCheck: "",
      stagedDiffCheck: "whitespace",
      ready: false,
      truncated: false,
    };
    const preparePitDelivery = vi.fn().mockResolvedValue(readiness);
    const outputs = new Map([
      ["--stat", "unstaged statistics"],
      ["--cached --stat", "staged statistics"],
      ["", "unstaged patch"],
      ["--cached", "staged patch"],
    ]);
    const diff = vi.fn(async (args: string[]) =>
      processResult({
        stdout: outputs.get(args.join(" ")) ?? "unexpected request",
        truncated: args.length === 0,
      }),
    );
    const log = vi.fn().mockResolvedValue(processResult({ stdout: "recent" }));
    expect(await review({ preparePitDelivery, git: { diff, log } })).toMatchObject({
      ...readiness,
      truncated: true,
      stat: "unstaged statistics",
      stagedStat: "staged statistics",
      diff: "unstaged patch",
      stagedDiff: "staged patch",
      recentCommits: "recent",
    });
    expect(preparePitDelivery).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(["--oneline", "-5"], expect.objectContaining({ raise: true }));
  });

  it("bounds each diff by its own line and byte limits and reports them", async () => {
    const review = await loadWorkflowFunction("reviewPitChanges");
    const preparePitDelivery = vi.fn().mockResolvedValue({
      status: "",
      diffCheck: "",
      stagedDiffCheck: "",
      ready: true,
      truncated: false,
    });
    const diff = vi.fn(async (_args: string[], _options: Record<string, unknown>) =>
      processResult(),
    );
    const log = vi.fn().mockResolvedValue(processResult());
    const result = await review(
      { preparePitDelivery, git: { diff, log } },
      { diffLines: 100, diffBytes: 15000 },
    );
    expect(result.limits).toEqual({ diffLines: 100, diffBytes: 15000, commits: 5 });
    for (const args of [[], ["--cached"]]) {
      expect(diff).toHaveBeenCalledWith(
        args,
        expect.objectContaining({ maxLines: 100, maxBytes: 15000 }),
      );
    }
  });
});
