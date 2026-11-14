/**
 * Waits for a GitHub Actions run and fails by default on unsuccessful completion. A timeout
 * returns outcome "pending" with a hint to call again.
 *
 * @param input.attempts - Maximum status checks (1-120). The default is 12.
 * @param input.intervalMs - Delay between checks (1000-30000). The default is 15000 ms.
 * @param input.initialDelayMs - Delay before the first check (0-120000). The default is 120000 ms.
 *   It counts toward timeoutMs.
 * @param input.timeoutMs - Wall-clock limit for the whole wait (at least 1000; larger values are
 *   capped at 285000, under the tool's 300 s call limit). The default is
 *   240000 ms, safely inside the 300 s tool limit. The wait stops early when another interval plus
 *   its slowest check so far would pass it. A timeout is not a failure, since long runs outlast one
 *   tool call: it returns outcome "pending", conclusion null, attempts made, requestedAttempts,
 *   timeoutMs, elapsedMs, the last observed run status, URL, and jobs, and a hint to call again.
 * @param input.raise - Fail on unsuccessful completion. The default is true. Every result has
 *   outcome "passed", "failed", or "pending", and conclusion.
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
  // A larger limit could not finish inside one tool call, so cap it rather than reject it (#379).
  const requestedTimeoutMs =
    input.timeoutMs === undefined ? undefined : Math.min(input.timeoutMs, 285000);
  const timeoutMs = integerInput("timeoutMs", requestedTimeoutMs, 240000, 1000, 285000);
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
    const run = JSON.parse(result.stdout) as {
      status: string;
      conclusion: string;
      url: string;
      jobs?: Job[];
    };
    last = run;
    if (run.status === "completed") {
      const summary = {
        outcome: run.conclusion === "success" ? ("passed" as const) : ("failed" as const),
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
      : `; it made all ${requestedAttempts} requested checks`;
  const unfinished = (last?.jobs ?? [])
    .filter((job) => job.status !== "completed")
    .map((job) => job.name);
  const unfinishedNote = unfinished.length
    ? `, unfinished jobs: ${unfinished.slice(0, 10).join(", ")}${unfinished.length > 10 ? ` and ${unfinished.length - 10} more` : ""}`
    : "";
  const progressNote = last ? `; last status ${last.status}${unfinishedNote}` : "";
  // Not a failure even with raise: long runs outlast one tool call, so the caller waits again (#383).
  return {
    outcome: "pending" as const,
    status: last?.status ?? "unknown",
    conclusion: null,
    id: input.id,
    attempts: attempt,
    requestedAttempts,
    timeoutMs,
    elapsedMs,
    url: last?.url,
    jobs: summarizeJobs(last?.jobs),
    note: `GitHub Actions run ${input.id} did not complete after ${attempt} checks in ${Math.round(elapsedMs / 1000)} s${limitNote}${progressNote}`,
    hint: `Still running. Call ci.waitForRun({ id: ${input.id}, repo: ${JSON.stringify(input.repo)}, initialDelayMs: 0 }) again to keep waiting.`,
  };
}
