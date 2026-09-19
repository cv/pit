/**
 * Reviews bounded staged and unstaged Git changes for Pit.
 *
 * @param input.diffLines - Maximum lines in each diff. The default is 240.
 * @param input.commits - Recent commits to include. The default is 5.
 */
async function reviewPitChanges(
  { preparePitDelivery, git: { diff: gitDiff, log: gitLog } },
  input: { diffLines?: number; commits?: number } = {},
) {
  for (const [name, value] of Object.entries(input)) {
    if (value !== undefined && !Number.isInteger(value)) {
      throw new Error(`${name} must be an integer`);
    }
  }
  const diffLines = Math.max(20, Math.min(input.diffLines ?? 240, 800));
  const commits = Math.max(1, Math.min(input.commits ?? 5, 20));
  const options = { maxBytes: 6000, maxLines: diffLines, truncate: "head" as const, raise: true };
  const [readiness, stat, stagedStat, diff, stagedDiff, log] = await Promise.all([
    preparePitDelivery(),
    gitDiff(["--stat"], options),
    gitDiff(["--cached", "--stat"], options),
    gitDiff([], options),
    gitDiff(["--cached"], options),
    gitLog(["--oneline", `-${commits}`], options),
  ]);
  return {
    ...readiness,
    stat: stat.stdout.trim(),
    stagedStat: stagedStat.stdout.trim(),
    diff: diff.stdout,
    diffTruncated: Boolean(diff.truncated),
    stagedDiff: stagedDiff.stdout,
    stagedDiffTruncated: Boolean(stagedDiff.truncated),
    recentCommits: log.stdout.trim(),
    truncated:
      readiness.truncated ||
      [stat, stagedStat, diff, stagedDiff, log].some((result) => result.truncated),
  };
}
