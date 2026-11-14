/**
 * Waits for a GitHub Actions run and fails by default on timeout or unsuccessful completion.
 *
 * @param input.attempts - Maximum status checks (1-120). The default is 12.
 * @param input.intervalMs - Delay between checks (1000-30000). The default is 15000 ms.
 * @param input.initialDelayMs - Delay before the first check (0-120000). The default is 120000 ms.
 *   It counts toward timeoutMs.
 * @param input.timeoutMs - Wall-clock limit for the whole wait (1000-285000). The default is
 *   240000 ms, safely inside the 300 s tool limit. The wait stops early when another interval plus
 *   its slowest check so far would pass it; a timeout reports attempts made, requestedAttempts,
 *   timeoutMs, elapsedMs, and the last observed run status, URL, and jobs.
 * @param input.raise - Fail on timeout or unsuccessful completion. The default is true.
 */
async function waitForRun(
  { gh: { runView } },
  input: {
    id: number;
    repo: string;
    attempts?: number;
    intervalMs?: number;
    initialDelayMs?: number;
    timeoutMs?: number;
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
  const timeoutMs = integerInput("timeoutMs", input.timeoutMs, 240000, 1000, 285000);
  const raise = input.raise ?? true;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  // A deadline, not an attempt count: GitHub's response time also spends the tool's 300 s.
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  if (initialDelayMs > 0) await sleep(Math.min(initialDelayMs, Math.max(0, deadline - Date.now())));
  type Job = { name: string; status: string; conclusion: string; url: string };
  const summarizeJobs = (jobs: Job[] | undefined) =>
    jobs?.map((job) => ({
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      url: job.url,
    }));
  let last: { status: string; url: string; jobs?: Job[] } | undefined;
  let attempt = 0;
  let slowestCheckMs = 0;
  while (attempt < requestedAttempts) {
    attempt++;
    const checkStarted = Date.now();
    const result = await runView(input.id, { repo: input.repo, raise: true });
    slowestCheckMs = Math.max(slowestCheckMs, Date.now() - checkStarted);
    const run = JSON.parse(result.stdout);
    last = run;
    if (run.status === "completed") {
      const summary = {
        attempt,
        status: run.status,
        conclusion: run.conclusion,
        url: run.url,
        jobs: summarizeJobs(run.jobs),
      };
      if (raise && run.conclusion !== "success") {
        throw new Error(
          `GitHub Actions run ${input.id} completed with ${run.conclusion || "no conclusion"}`,
        );
      }
      return summary;
    }
    if (attempt >= requestedAttempts || Date.now() + intervalMs + slowestCheckMs > deadline) break;
    await sleep(intervalMs);
  }
  const elapsedMs = Date.now() - startedAt;
  const limitNote =
    attempt < requestedAttempts
      ? `; it stopped at its ${timeoutMs / 1000} s time limit with ${requestedAttempts - attempt} checks unused`
      : "";
  const unfinished = (last?.jobs ?? [])
    .filter((job) => job.status !== "completed")
    .map((job) => job.name);
  const unfinishedNote = unfinished.length
    ? `, unfinished jobs: ${unfinished.slice(0, 10).join(", ")}${unfinished.length > 10 ? ` and ${unfinished.length - 10} more` : ""}`
    : "";
  const progressNote = last ? `; last status ${last.status}${unfinishedNote}` : "";
  if (raise) {
    throw new Error(
      `GitHub Actions run ${input.id} did not complete after ${attempt} checks in ${Math.round(elapsedMs / 1000)} s${limitNote}${progressNote}`,
    );
  }
  return {
    status: "timed_out",
    id: input.id,
    attempts: attempt,
    requestedAttempts,
    timeoutMs,
    elapsedMs,
    lastStatus: last?.status,
    url: last?.url,
    jobs: summarizeJobs(last?.jobs),
  };
}
