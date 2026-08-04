/**
 * Finds the newest GitHub Actions run whose head SHA matches a commit prefix.
 *
 * @pit project
 */
async function findGitHubRunForCommit(
  { gh },
  input: { repo: string; sha: string; limit?: number },
) {
  const sha = input.sha.trim().toLowerCase();
  // biome-ignore lint/performance/useTopLevelRegex: project functions expose one top-level callable.
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new Error("sha must be a 7-40 character hexadecimal commit prefix");
  }
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const result = await gh.runList({
    repo: input.repo,
    limit,
    maxLines: 100,
    maxBytes: 30000,
    raise: true,
  });
  const runs = JSON.parse(result.stdout) as Array<{
    databaseId: number;
    headSha: string;
    name: string;
    status: string;
    conclusion: string;
    url: string;
  }>;
  const matches = runs
    .filter((run) => run.headSha.toLowerCase().startsWith(sha))
    .slice(0, 5)
    .map(({ databaseId, headSha, name, status, conclusion, url }) => ({
      id: databaseId,
      headSha,
      name,
      status,
      conclusion,
      url,
    }));
  return { found: matches.length > 0, matches };
}
