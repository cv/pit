/**
 * Waits for every status check reported on a GitHub pull request and returns its merge state.
 * It stops early when any check fails. Use ci.waitForCommit for one workflow run.
 *
 * @param input.repo - GitHub owner/name. The default is the current repository.
 * @param input.attempts - Maximum polls (1-120). The default is 12.
 * @param input.intervalMs - Delay between polls (1000-30000). The default is 15000 ms.
 * @param input.initialDelayMs - Delay before the first poll (0-120000). The default is 0 ms. It
 *   counts toward timeoutMs.
 * @param input.timeoutMs - Wall-clock limit for the whole wait (1000-285000). The default is
 *   240000 ms, safely inside the 300 s tool limit. The wait stops early when another interval plus
 *   its slowest poll so far would pass it, and a timeout reports timeoutMs and elapsedMs.
 * @param input.raise - Fail when a check fails or checks are still pending. The default is true.
 */
async function waitForChecks(
  { gh: { prView } },
  input: {
    number: number;
    repo?: string;
    attempts?: number;
    intervalMs?: number;
    initialDelayMs?: number;
    timeoutMs?: number;
    raise?: boolean;
  },
) {
  type Names = { names: string[]; omitted: number };
  type Summary = {
    number: number;
    url: string;
    state: string;
    headSha: string;
    mergeStateStatus: string;
    outcome: "passed" | "failed" | "pending" | "timed_out";
    attempt: number;
    requestedAttempts: number;
    timeoutMs?: number;
    elapsedMs?: number;
    checks: { total: number; passed: number; failed: Names; pending: Names };
    note?: string;
  };
  type Check = {
    __typename?: string;
    name?: string;
    context?: string;
    status?: string;
    conclusion?: string;
    state?: string;
  };
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
  const number = integerInput("number", input.number, 0, 1, Number.MAX_SAFE_INTEGER);
  const intervalMs = integerInput("intervalMs", input.intervalMs, 15000, 1000, 30000);
  const initialDelayMs = integerInput("initialDelayMs", input.initialDelayMs, 0, 0, 120000);
  const requestedAttempts = integerInput("attempts", input.attempts, 12, 1, 120);
  if (input.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(input.repo)) {
    throw new Error("repo must be owner/name");
  }
  const timeoutMs = integerInput("timeoutMs", input.timeoutMs, 240000, 1000, 285000);
  // A deadline, not an attempt count: GitHub's response time also spends the tool's 300 s.
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const raise = input.raise ?? true;
  const NAME_LIMIT = 20;
  const passing = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  const classify = (check: Check) => {
    const name = check.name ?? check.context ?? "unnamed check";
    if (
      check.__typename === "StatusContext" ||
      (check.status === undefined && check.state !== undefined)
    ) {
      const state = (check.state ?? "").toUpperCase();
      if (!state || state === "PENDING" || state === "EXPECTED") {
        return { name, outcome: "pending", conclusion: "" };
      }
      return { name, outcome: state === "SUCCESS" ? "passed" : "failed", conclusion: state };
    }
    if ((check.status ?? "").toUpperCase() !== "COMPLETED") {
      return { name, outcome: "pending", conclusion: "" };
    }
    const conclusion = (check.conclusion ?? "").toUpperCase() || "NONE";
    return { name, outcome: passing.has(conclusion) ? "passed" : "failed", conclusion };
  };
  const bounded = (names: string[]): Names => ({
    names: names.slice(0, NAME_LIMIT),
    omitted: Math.max(0, names.length - NAME_LIMIT),
  });
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  if (initialDelayMs > 0) await sleep(Math.min(initialDelayMs, Math.max(0, deadline - Date.now())));
  let last: Summary | undefined;
  let attempt = 0;
  let slowestPollMs = 0;
  while (attempt < requestedAttempts) {
    attempt++;
    const pollStarted = Date.now();
    const result = await prView(number, {
      ...(input.repo ? { repo: input.repo } : {}),
      json: ["number", "state", "url", "headRefOid", "mergeStateStatus", "statusCheckRollup"],
      maxBytes: 50000,
      raise: true,
    });
    slowestPollMs = Math.max(slowestPollMs, Date.now() - pollStarted);
    if (result.truncated) throw new Error(`Pull request #${number} check data was truncated`);
    const pr = JSON.parse(result.stdout) as {
      state: string;
      url: string;
      headRefOid: string;
      mergeStateStatus: string;
      statusCheckRollup: Check[] | null;
    };
    const checks = (pr.statusCheckRollup ?? []).map(classify);
    const failed = checks
      .filter((check) => check.outcome === "failed")
      .map((check) => `${check.name} (${check.conclusion})`);
    const pending = checks
      .filter((check) => check.outcome === "pending")
      .map((check) => check.name);
    const outcome: Summary["outcome"] = failed.length
      ? "failed"
      : checks.length > 0 && pending.length === 0
        ? "passed"
        : "pending";
    last = {
      number,
      url: pr.url,
      state: pr.state,
      headSha: pr.headRefOid,
      mergeStateStatus: pr.mergeStateStatus,
      outcome,
      attempt,
      requestedAttempts,
      checks: {
        total: checks.length,
        passed: checks.filter((check) => check.outcome === "passed").length,
        failed: bounded(failed),
        pending: bounded(pending),
      },
    };
    if (outcome === "failed") {
      if (raise) throw new Error(`Pull request #${number} has failed checks: ${failed.join(", ")}`);
      return last;
    }
    if (outcome === "passed") return last;
    if (attempt >= requestedAttempts || Date.now() + intervalMs + slowestPollMs > deadline) break;
    await sleep(intervalMs);
  }
  if (!last) throw new Error(`Pull request #${number} was not polled`);
  const elapsedMs = Date.now() - startedAt;
  const limitNote =
    attempt < requestedAttempts ? ` (it stopped at its ${timeoutMs / 1000} s time limit)` : "";
  const note =
    last.checks.total === 0
      ? "no checks were reported"
      : `${last.checks.pending.names.length + last.checks.pending.omitted} checks are still pending`;
  if (raise) {
    throw new Error(
      `Pull request #${number} did not settle after ${attempt} polls${limitNote}: ${note}`,
    );
  }
  return { ...last, outcome: "timed_out", note, timeoutMs, elapsedMs };
}
