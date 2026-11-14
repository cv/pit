/**
 * Merges an open pull request and, with sync, switches to its base branch and fast-forwards it.
 *
 * @param input.number - Pull request number.
 * @param input.method - Merge method: merge, squash, or rebase. Repositories allow different ones.
 * @param input.repo - GitHub owner/name. The default is the current repository. sync updates the
 *   local checkout, so use it only for the current repository.
 * @param input.deleteBranch - Delete the head branch after merging. The default is false.
 * @param input.sync - After merging, run git switch <base> and git pull --ff-only. The default is
 *   false. A failed sync reports the merge as done and names the step that failed.
 */
async function merge(
  { gh: { prView, prMerge }, git: { switchBranch, pull, revParse } },
  input: {
    number: number;
    method: "merge" | "squash" | "rebase";
    repo?: string;
    deleteBranch?: boolean;
    sync?: boolean;
  },
) {
  if (!Number.isInteger(input.number) || input.number < 1) {
    throw new Error("number must be a positive integer");
  }
  if (!["merge", "squash", "rebase"].includes(input.method)) {
    throw new Error("method must be merge, squash, or rebase");
  }
  if (input.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(input.repo)) {
    throw new Error("repo must be owner/name");
  }
  const repo = input.repo ? { repo: input.repo } : {};
  const viewed = await prView(input.number, {
    ...repo,
    json: ["number", "state", "url", "baseRefName", "headRefName"],
    raise: true,
  });
  const pr = JSON.parse(viewed.stdout) as {
    state: string;
    url: string;
    baseRefName: string;
    headRefName: string;
  };
  if (pr.state !== "OPEN") {
    throw new Error(`Pull request #${input.number} is ${pr.state.toLowerCase()}, not open`);
  }
  await prMerge(input.number, {
    ...repo,
    method: input.method,
    ...(input.deleteBranch === true ? { deleteBranch: true } : {}),
    raise: true,
  });
  const merged = {
    number: input.number,
    url: pr.url,
    merged: true,
    method: input.method,
    base: pr.baseRefName,
    head: pr.headRefName,
  };
  if (input.sync !== true) return { ...merged, synced: null };

  // The merge already happened, so a failed sync is reported, not thrown.
  const step = async (name: string, run: () => Promise<{ code: number; stderr: string }>) => {
    const result = await run();
    return result.code === 0
      ? undefined
      : `${name} failed with exit ${result.code}: ${result.stderr.trim().slice(-1000)}`;
  };
  const failure =
    (await step(`git switch ${pr.baseRefName}`, () => switchBranch([pr.baseRefName]))) ??
    (await step("git pull --ff-only", () => pull(["--ff-only"])));
  if (failure)
    return { ...merged, synced: { ok: false as const, branch: pr.baseRefName, error: failure } };
  const sha = (await revParse(["HEAD"], { raise: true })).stdout.trim();
  return { ...merged, synced: { ok: true as const, branch: pr.baseRefName, sha } };
}
