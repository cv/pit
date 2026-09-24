/**
 * Waits for a GitHub Actions run and fails by default on timeout or unsuccessful completion.
 *
 * @param input.attempts - Maximum status checks (1-120). The default is 12. Checks that would not
 *   fit the 285 s polling budget after the initial delay are skipped; a timeout reports both
 *   attempts made and requestedAttempts.
 * @param input.intervalMs - Delay between checks (1000-30000). The default is 15000 ms.
 * @param input.initialDelayMs - Delay before the first check (0-120000). The default is 120000 ms.
 * @param input.raise - Fail on timeout or unsuccessful completion. The default is true.
 */
async function waitForGitHubRun(
  { gh: { runView } },
  input: {
    id: number;
    repo: string;
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
  const intervalMs = integerInput("intervalMs", input.intervalMs, 15000, 1000, 30000);
  const initialDelayMs = integerInput("initialDelayMs", input.initialDelayMs, 120000, 0, 120000);
  const requestedAttempts = integerInput("attempts", input.attempts, 12, 1, 120);
  // Keeps the whole wait inside the 300 s tool invocation limit.
  const POLLING_BUDGET_MS = 285000;
  const attempts = Math.min(
    requestedAttempts,
    Math.floor((POLLING_BUDGET_MS - initialDelayMs) / intervalMs) + 1,
  );
  const raise = input.raise ?? true;
  if (initialDelayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, initialDelayMs));
  }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await runView(input.id, { repo: input.repo, raise: true });
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
  const budgetNote =
    attempts < requestedAttempts
      ? `; ${requestedAttempts} were requested, but only ${attempts} fit the ${POLLING_BUDGET_MS / 1000} s polling budget`
      : "";
  if (raise) {
    throw new Error(
      `GitHub Actions run ${input.id} did not complete after ${attempts} checks${budgetNote}`,
    );
  }
  return { status: "timed_out", id: input.id, attempts, requestedAttempts };
}
