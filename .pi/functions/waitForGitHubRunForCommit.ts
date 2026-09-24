/**
 * Finds the exact GitHub Actions run for a commit and waits for its bounded completion.
 *
 * @param input.discoveryAttempts - Run searches before failing (1-12). The default is 3.
 * @param input.discoveryIntervalMs - Delay between searches (1000-30000). The default is 5000 ms.
 *   findGitHubRunForCommit and waitForGitHubRun validate the remaining inputs.
 */
async function waitForGitHubRunForCommit(
  { findGitHubRunForCommit, waitForGitHubRun },
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
  const discoveryAttempts = integerInput("discoveryAttempts", input.discoveryAttempts, 3, 1, 12);
  const discoveryIntervalMs = integerInput(
    "discoveryIntervalMs",
    input.discoveryIntervalMs,
    5000,
    1000,
    30000,
  );
  let match: Awaited<ReturnType<typeof findGitHubRunForCommit>>["matches"][number] | undefined;
  for (let attempt = 1; attempt <= discoveryAttempts; attempt++) {
    const found = await findGitHubRunForCommit({
      repo: input.repo,
      sha: input.sha,
      limit: input.limit,
      runName: input.runName,
    });
    match = found.matches[0];
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
