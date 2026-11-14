import { describe, expect, it, vi } from "vitest";

import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

const committed = { sha: "abc1234", branch: "topic", files: ["a.ts"], pushed: true };

function openFakes(head: string, openPullRequests: unknown[] = []) {
  const calls: string[] = [];
  const record =
    <T>(name: string, value: T) =>
    async (...args: unknown[]) => {
      calls.push(`${name} ${JSON.stringify(args)}`);
      return value;
    };
  return {
    calls,
    dependencies: {
      git: {
        revParse: record("revParse", processResult({ stdout: `${head}\n` })),
        switchBranch: record("switchBranch", processResult()),
      },
      delivery: { commit: record("commit", committed) },
      gh: {
        prList: record("prList", processResult({ stdout: JSON.stringify(openPullRequests) })),
        prCreate: record(
          "prCreate",
          processResult({ stdout: "https://github.com/cv/pit/pull/391\n" }),
        ),
      },
    },
  };
}

describe("delivery.openPullRequest", () => {
  it("branches, commits and pushes, then opens the pull request in that order", async () => {
    const open = await loadWorkflowFunction("delivery.openPullRequest");
    const { calls, dependencies } = openFakes("main");
    const result = await open(dependencies, {
      branch: "topic",
      files: ["a.ts"],
      message: "feat: add a\n\nDetails.",
      body: "Body",
      draft: true,
    });
    expect(result).toEqual({
      number: 391,
      url: "https://github.com/cv/pit/pull/391",
      created: true,
      branch: "topic",
      branchCreated: true,
      sha: "abc1234",
      files: ["a.ts"],
    });
    expect(calls.map((call) => call.split(" ")[0])).toEqual([
      "revParse",
      "switchBranch",
      "commit",
      "prList",
      "prCreate",
    ]);
    expect(calls[1]).toContain('["-c","topic"]');
    expect(calls[2]).toContain('"push":true');
    expect(JSON.parse(calls[4]?.slice("prCreate ".length) ?? "[]")[0]).toEqual({
      title: "feat: add a",
      body: "Body",
      base: "main",
      head: "topic",
      draft: true,
      raise: true,
    });
  });

  it("reuses the checked-out branch and its open pull request", async () => {
    const open = await loadWorkflowFunction("delivery.openPullRequest");
    const { calls, dependencies } = openFakes("topic", [{ number: 12, url: "https://pr/12" }]);
    expect(
      await open(dependencies, { branch: "topic", files: ["a.ts"], message: "fix: more" }),
    ).toMatchObject({ number: 12, url: "https://pr/12", created: false, branchCreated: false });
    expect(calls.some((call) => call.startsWith("switchBranch"))).toBe(false);
    expect(calls.some((call) => call.startsWith("prCreate"))).toBe(false);
  });

  it.each<{ name: string; input: Record<string, unknown>; error: string }>([
    { name: "the default branch", input: { branch: "main" }, error: "must differ" },
    { name: "the base branch", input: { branch: "dev", base: "dev" }, error: "must differ" },
    { name: "an option-like branch", input: { branch: "-f" }, error: "not a valid branch" },
    { name: "a branch with ..", input: { branch: "a..b" }, error: "not a valid branch" },
    { name: "an empty title", input: { branch: "topic", title: " " }, error: "title" },
  ])("rejects $name before touching Git", async ({ input, error }) => {
    const open = await loadWorkflowFunction("delivery.openPullRequest");
    const { calls, dependencies } = openFakes("main");
    await expect(
      open(dependencies, { files: ["a.ts"], message: "feat: a", ...input }),
    ).rejects.toThrow(error);
    expect(calls).toEqual([]);
  });
});

function mergeFakes(state = "OPEN", pullCode = 0) {
  const calls: string[] = [];
  const record =
    <T>(name: string, value: T) =>
    async (...args: unknown[]) => {
      calls.push(`${name} ${JSON.stringify(args)}`);
      return value;
    };
  const pr = { number: 8, state, url: "https://pr/8", baseRefName: "main", headRefName: "topic" };
  return {
    calls,
    dependencies: {
      gh: {
        prView: record("prView", processResult({ stdout: JSON.stringify(pr) })),
        prMerge: record("prMerge", processResult()),
      },
      git: {
        switchBranch: record("switchBranch", processResult()),
        pull: record(
          "pull",
          processResult(
            pullCode === 0
              ? { stdout: "Fast-forward\n" }
              : { code: pullCode, stderr: "fatal: Not possible to fast-forward, aborting." },
          ),
        ),
        revParse: record("revParse", processResult({ stdout: "def5678\n" })),
      },
    },
  };
}

describe("pr.merge", () => {
  it("merges, then switches to the base branch and fast-forwards it", async () => {
    const merge = await loadWorkflowFunction("pr.merge");
    const { calls, dependencies } = mergeFakes();
    expect(
      await merge(dependencies, { number: 8, method: "squash", deleteBranch: true, sync: true }),
    ).toEqual({
      number: 8,
      url: "https://pr/8",
      merged: true,
      method: "squash",
      base: "main",
      head: "topic",
      synced: { ok: true, branch: "main", sha: "def5678" },
    });
    expect(calls).toEqual([
      expect.stringMatching(/^prView \[8,/),
      'prMerge [8,{"method":"squash","deleteBranch":true,"raise":true}]',
      'switchBranch [["main"]]',
      'pull [["--ff-only"]]',
      'revParse [["HEAD"],{"raise":true}]',
    ]);
  });

  it("leaves the checkout alone without sync", async () => {
    const merge = await loadWorkflowFunction("pr.merge");
    const { calls, dependencies } = mergeFakes();
    expect(await merge(dependencies, { number: 8, method: "rebase" })).toMatchObject({
      merged: true,
      synced: null,
    });
    expect(calls.map((call) => call.split(" ")[0])).toEqual(["prView", "prMerge"]);
  });

  it("reports a failed sync after the merge instead of throwing", async () => {
    const merge = await loadWorkflowFunction("pr.merge");
    const { dependencies } = mergeFakes("OPEN", 128);
    expect(await merge(dependencies, { number: 8, method: "merge", sync: true })).toMatchObject({
      merged: true,
      synced: {
        ok: false,
        branch: "main",
        error: "git pull --ff-only failed with exit 128: fatal: Not possible to fast-forward, aborting.",
      },
    });
  });

  it("refuses a pull request that is not open before merging", async () => {
    const merge = await loadWorkflowFunction("pr.merge");
    const { calls, dependencies } = mergeFakes("MERGED");
    await expect(merge(dependencies, { number: 8, method: "squash", sync: true })).rejects.toThrow(
      "Pull request #8 is merged, not open",
    );
    expect(calls.map((call) => call.split(" ")[0])).toEqual(["prView"]);
  });

  it.each<{ name: string; input: Record<string, unknown>; error: string }>([
    { name: "a fractional number", input: { number: 1.5, method: "squash" }, error: "number" },
    { name: "an unknown method", input: { number: 8, method: "fast" }, error: "method" },
    {
      name: "a malformed repository",
      input: { number: 8, method: "squash", repo: "not a repo" },
      error: "owner/name",
    },
  ])("rejects $name before calling GitHub", async ({ input, error }) => {
    const merge = await loadWorkflowFunction("pr.merge");
    const { calls, dependencies } = mergeFakes();
    await expect(merge(dependencies, input)).rejects.toThrow(error);
    expect(calls).toEqual([]);
  });
});
