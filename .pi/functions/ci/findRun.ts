/**
 * Finds the newest GitHub Actions run whose head SHA matches a commit prefix.
 * @param input.runName - Optional workflow name, file name such as ci.yml, or ID. GitHub filters
 *   runs by it before the search window, and an unknown workflow is an error.
 * @param input.limit - Recent runs to inspect (1-100). The default is 20. searchLimited flags a
 *   full search window.
 */
async function findRun(
  { gh: { runList } },
  input: { repo: string; sha: string; runName?: string; limit?: number },
) {
  const sha = input.sha.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new Error("sha must be a 7-40 character hexadecimal commit prefix");
  }
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer between 1 and 100");
  }
  const result = await runList({
    repo: input.repo,
    limit,
    ...(input.runName ? { workflow: input.runName } : {}),
    ...(sha.length === 40 ? { commit: sha } : {}),
    json: ["databaseId", "headSha", "name", "status", "conclusion", "url"],
    maxLines: 100,
    maxBytes: 30000,
    raise: true,
  });
  if (result.truncated) {
    throw new Error("GitHub run list was truncated; reduce limit before retrying");
  }
  const runs = JSON.parse(result.stdout) as Array<{
    databaseId: number;
    headSha: string;
    name: string;
    status: string;
    conclusion: string;
    url: string;
  }>;
  const matching = runs.filter((run) => run.headSha.toLowerCase().startsWith(sha));
  const matches = matching
    .slice(0, 5)
    .map(({ databaseId, headSha, name, status, conclusion, url }) => ({
      id: databaseId,
      headSha,
      name,
      status,
      conclusion,
      url,
    }));
  return {
    found: matches.length > 0,
    matches,
    truncated: matching.length > matches.length,
    searchLimited: runs.length === limit,
  };
}
