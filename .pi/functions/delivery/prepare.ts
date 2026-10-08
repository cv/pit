/**
 * Reports bounded Git delivery readiness without rerunning validation.
 * Ready means Git inspection succeeded, both whitespace checks passed, and installed direct
 * dependencies match the lockfile; not that CI passed.
 */
async function prepare({
  git: { diff: gitDiff, status: gitStatus },
  delivery: { inspectDependencies },
}) {
  const options = { maxBytes: 4000, maxLines: 160, raise: false };
  const [status, diffCheck, stagedDiffCheck, dependencies] = await Promise.all([
    gitStatus(["--short", "--branch"], options),
    gitDiff(["--check"], options),
    gitDiff(["--cached", "--check"], options),
    inspectDependencies({ limit: 30 }),
  ]);
  const diagnostic = (result: { stdout: string; stderr: string }) =>
    [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const results = [status, diffCheck, stagedDiffCheck];
  return {
    status: diagnostic(status),
    diffCheck: diagnostic(diffCheck),
    stagedDiffCheck: diagnostic(stagedDiffCheck),
    staleDependencies: dependencies.stale,
    truncated: results.some((result) => result.truncated),
    ready:
      results.every((result) => result.code === 0 && !result.truncated) &&
      dependencies.stale.length === 0,
  };
}
