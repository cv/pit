/**
 * Reviews bounded staged and unstaged Git changes for Pit.
 *
 * @param input.diffLines - Maximum lines in each diff. The default is 240.
 * @param input.commits - Recent commits to include. The default is 5.
 */
async function reviewPitChanges({ git }, input: { diffLines?: number; commits?: number } = {}) {
  const diffLines = Math.max(20, Math.min(input.diffLines ?? 240, 800));
  const commits = Math.max(1, Math.min(input.commits ?? 5, 20));
  const options = { maxBytes: 30000, maxLines: diffLines, truncate: "head" as const };
  const [status, stat, stagedStat, diff, stagedDiff, diffCheck, stagedDiffCheck, log] =
    await Promise.all([
      git.status(["--short", "--branch"]),
      git.diff(["--stat"]),
      git.diff(["--cached", "--stat"]),
      git.diff([], options),
      git.diff(["--cached"], options),
      git.diff(["--check"]),
      git.diff(["--cached", "--check"]),
      git.log(["--oneline", `-${commits}`]),
    ]);
  return {
    status: status.stdout.trim(),
    stat: stat.stdout.trim(),
    stagedStat: stagedStat.stdout.trim(),
    diff: diff.stdout,
    diffTruncated: Boolean(diff.truncated),
    stagedDiff: stagedDiff.stdout,
    stagedDiffTruncated: Boolean(stagedDiff.truncated),
    diffCheck: (diffCheck.stdout || diffCheck.stderr).trim(),
    stagedDiffCheck: (stagedDiffCheck.stdout || stagedDiffCheck.stderr).trim(),
    recentCommits: log.stdout.trim(),
    ready: diffCheck.code === 0 && stagedDiffCheck.code === 0,
  };
}
