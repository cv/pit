/**
 * Waits for a GitHub Actions run and fails by default on timeout or unsuccessful completion.
 *
 * @pit project
 * @param input.attempts - Maximum status checks. The default is 48.
 * @param input.intervalMs - Delay between checks. The default is 5000 ms.
 * @param input.initialDelayMs - Delay before the first check. The default is 30000 ms.
 * @param input.raise - Fail on timeout or unsuccessful completion. The default is true.
 */
async function waitForGitHubRun(
  { gh },
  input: {
    id: number;
    repo: string;
    attempts?: number;
    intervalMs?: number;
    initialDelayMs?: number;
    raise?: boolean;
  },
) {
  const intervalMs = Math.max(1000, Math.min(input.intervalMs ?? 5000, 30000));
  const initialDelayMs = Math.max(0, Math.min(input.initialDelayMs ?? 30000, 120000));
  const requestedAttempts = Math.max(1, Math.min(input.attempts ?? 48, 120));
  const pollingBudgetMs = Math.max(0, 270000 - initialDelayMs);
  const maximumAttempts = Math.floor(pollingBudgetMs / intervalMs) + 1;
  const attempts = Math.min(requestedAttempts, maximumAttempts);
  const raise = input.raise ?? true;
  if (initialDelayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, initialDelayMs));
  }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await gh.runView(input.id, { repo: input.repo, raise: true });
    const run = JSON.parse(result.stdout);
    if (run.status === "completed") {
      const summary = {
        attempt,
        status: run.status,
        conclusion: run.conclusion,
        url: run.url,
        jobs: run.jobs?.map(
          (job: { name: string; status: string; conclusion: string; url: string }) => ({
            name: job.name,
            status: job.status,
            conclusion: job.conclusion,
            url: job.url,
          }),
        ),
      };
      if (raise && run.conclusion !== "success") {
        throw new Error(
          `GitHub Actions run ${input.id} completed with ${run.conclusion || "no conclusion"}`,
        );
      }
      return summary;
    }
    if (attempt < attempts) {
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  if (raise) {
    throw new Error(`GitHub Actions run ${input.id} did not complete after ${attempts} checks`);
  }
  return { status: "timed_out", id: input.id, attempts };
}
