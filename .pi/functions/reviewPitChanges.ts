/**
 * Reviews bounded staged and unstaged Git changes for Pit.
 * Each diff stops at whichever of its line or byte limits comes first; the limits used are returned.
 *
 * @param input.diffLines - Maximum lines in each diff (20-800). The default is 240.
 * @param input.diffBytes - Maximum bytes in each diff (1000-20000). The default is 12000.
 * @param input.commits - Recent commits to include (1-20). The default is 5.
 */
async function reviewPitChanges(
  { preparePitDelivery, git: { diff: gitDiff, log: gitLog } },
  input: { diffLines?: number; diffBytes?: number; commits?: number } = {},
) {
  const integerInput = (
    name: string,
    value: number | undefined,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const chosen = value ?? fallback;
    if (!Number.isInteger(chosen) || chosen < min || chosen > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return chosen;
  };
  const limits = {
    diffLines: integerInput("diffLines", input.diffLines, 240, 20, 800),
    // Two diffs at the maximum still leave room for summaries within the tool output limit.
    diffBytes: integerInput("diffBytes", input.diffBytes, 12_000, 1000, 20_000),
    commits: integerInput("commits", input.commits, 5, 1, 20),
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
