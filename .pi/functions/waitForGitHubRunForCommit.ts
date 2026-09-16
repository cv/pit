/**
 * Finds the exact GitHub Actions run for a commit and waits for its bounded completion.
 *
 */
async function waitForGitHubRunForCommit(
  _capabilities,
  input: {
    repo: string;
    sha: string;
    runName?: string;
    limit?: number;
    discoveryAttempts?: number;
    discoveryIntervalMs?: number;
    attempts?: number;
    intervalMs?: number;
    initialDelayMs?: number;
    raise?: boolean;
  },
) {
  const discoveryAttempts = Math.max(1, Math.min(input.discoveryAttempts ?? 3, 12));
  const discoveryIntervalMs = Math.max(1000, Math.min(input.discoveryIntervalMs ?? 5000, 30000));
  let match:
    | {
        id: number;
        headSha: string;
        name: string;
        status: string;
        conclusion: string;
        url: string;
      }
    | undefined;
  for (let attempt = 1; attempt <= discoveryAttempts; attempt++) {
    const found = await findGitHubRunForCommit({
      repo: input.repo,
      sha: input.sha,
      limit: input.limit,
    });
    match = input.runName
      ? found.matches.find(({ name }) => name === input.runName)
      : found.matches[0];
    if (match) break;
    if (attempt < discoveryAttempts) {
      await new Promise<void>((resolve) => setTimeout(resolve, discoveryIntervalMs));
    }
  }
  if (!match) {
    throw new Error(
      `No${input.runName ? ` ${JSON.stringify(input.runName)}` : ""} GitHub Actions run found for ${input.sha}`,
    );
  }
  const run = await waitForGitHubRun({
    id: match.id,
    repo: input.repo,
    attempts: input.attempts,
    intervalMs: input.intervalMs,
    initialDelayMs: input.initialDelayMs ?? (match.status === "completed" ? 0 : undefined),
    raise: input.raise,
  });
  return { match, run };
}
