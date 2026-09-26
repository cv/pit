/**
 * Reports bounded Git delivery readiness without rerunning validation.
 * Ready means Git inspection succeeded and both whitespace checks passed, not that CI passed.
 */
async function prepare({ git: { diff: gitDiff, status: gitStatus } }) {
  const options = { maxBytes: 4000, maxLines: 160, raise: false };
  const [status, diffCheck, stagedDiffCheck] = await Promise.all([
    gitStatus(["--short", "--branch"], options),
    gitDiff(["--check"], options),
    gitDiff(["--cached", "--check"], options),
  ]);
  const diagnostic = (result: { stdout: string; stderr: string }) =>
    [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const results = [status, diffCheck, stagedDiffCheck];
  return {
    status: diagnostic(status),
    diffCheck: diagnostic(diffCheck),
    stagedDiffCheck: diagnostic(stagedDiffCheck),
    truncated: results.some((result) => result.truncated),
    ready: results.every((result) => result.code === 0 && !result.truncated),
  };
}
