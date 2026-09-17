/**
 * Reports bounded Git delivery readiness without rerunning validation.
 */
async function preparePitDelivery({ git: { diff: gitDiff, status: gitStatus } }) {
  const [status, diffCheck, stagedDiffCheck] = await Promise.all([
    gitStatus(["--short", "--branch"]),
    gitDiff(["--check"]),
    gitDiff(["--cached", "--check"]),
  ]);
  const unstaged = (diffCheck.stdout || diffCheck.stderr).trim();
  const staged = (stagedDiffCheck.stdout || stagedDiffCheck.stderr).trim();
  return {
    status: status.stdout.trim(),
    diffCheck: unstaged,
    stagedDiffCheck: staged,
    ready: diffCheck.code === 0 && stagedDiffCheck.code === 0,
  };
}
