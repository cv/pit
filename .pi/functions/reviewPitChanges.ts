/**
 * Reviews bounded staged and unstaged Git changes for Pit.
 * Each diff stops at whichever of its line or byte limits comes first; effective limits are returned.
 *
 * @param input.diffLines - Maximum lines in each diff. The default is 240.
 * @param input.diffBytes - Maximum bytes in each diff. The default is 12000.
 * @param input.commits - Recent commits to include. The default is 5.
 */
async function reviewPitChanges(
  { preparePitDelivery, git: { diff: gitDiff, log: gitLog } },
  input: { diffLines?: number; diffBytes?: number; commits?: number } = {},
) {
  for (const [name, value] of Object.entries(input)) {
    if (value !== undefined && !Number.isInteger(value)) {
      throw new Error(`${name} must be an integer`);
    }
  }
  const limits = {
    diffLines: Math.max(20, Math.min(input.diffLines ?? 240, 800)),
    // Two diffs at the maximum still leave room for summaries within the tool output limit.
    diffBytes: Math.max(1000, Math.min(input.diffBytes ?? 12_000, 20_000)),
    commits: Math.max(1, Math.min(input.commits ?? 5, 20)),
  };
  const diffOptions = {
    maxBytes: limits.diffBytes,
    maxLines: limits.diffLines,
    truncate: "head" as const,
    raise: true,
  };
  const summaryOptions = { maxBytes: 4000, maxLines: 120, truncate: "head" as const, raise: true };
  const [readiness, stat, stagedStat, diff, stagedDiff, log] = await Promise.all([
    preparePitDelivery(),
    gitDiff(["--stat"], summaryOptions),
    gitDiff(["--cached", "--stat"], summaryOptions),
    gitDiff([], diffOptions),
    gitDiff(["--cached"], diffOptions),
    gitLog(["--oneline", `-${limits.commits}`], summaryOptions),
  ]);
  return {
    ...readiness,
    limits,
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
