/**
 * Reports how long a GitHub Actions run, each of its jobs, and selected steps took, for comparing
 * CI changes or cold and warm builds. Skipped steps are omitted.
 *
 * @param input.steps - Regular expression selecting step names to time, such as "^(Build|Test)".
 *   Without it, only jobs are timed.
 */
async function inspectTimings(
  { gh: { api } },
  input: { repo: string; id: number; steps?: string },
) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(input.repo)) throw new Error("repo must be owner/name");
  if (!Number.isSafeInteger(input.id) || input.id < 1) {
    throw new Error("id must be a positive integer");
  }
  const stepPattern = input.steps === undefined ? undefined : new RegExp(input.steps);
  const JOB_LIMIT = 100;
  const seconds = (start?: string | null, end?: string | null) =>
    start && end ? Math.round((Date.parse(end) - Date.parse(start)) / 1000) : null;
  // jq projects GitHub's job objects to timestamps before they cross the output bound.
  const [runResult, jobsResult] = await Promise.all([
    api(
      `repos/${input.repo}/actions/runs/${input.id}`,
      ["--jq", "{name, status, conclusion, run_started_at, updated_at, head_sha}"],
      { raise: true, maxBytes: 5000 },
    ),
    api(
      `repos/${input.repo}/actions/runs/${input.id}/jobs?per_page=${JOB_LIMIT}`,
      [
        "--jq",
        ".jobs[] | {name, conclusion, started_at, completed_at, steps: [.steps[] | {name, conclusion, started_at, completed_at}]}",
      ],
      { raise: true, maxBytes: 51200 },
    ),
  ]);
  if (runResult.truncated || jobsResult.truncated) {
    throw new Error(`GitHub Actions run ${input.id} timings were truncated`);
  }
  type Timed = {
    name: string;
    conclusion: string | null;
    started_at: string | null;
    completed_at: string | null;
  };
  const run = JSON.parse(runResult.stdout) as {
    name: string;
    status: string;
    conclusion: string | null;
    run_started_at: string;
    updated_at: string;
    head_sha: string;
  };
  const jobs = jobsResult.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Timed & { steps: Timed[] });
  return {
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    headSha: run.head_sha,
    wallSeconds: seconds(run.run_started_at, run.updated_at),
    jobs: jobs.map((job) => ({
      name: job.name,
      conclusion: job.conclusion,
      seconds: seconds(job.started_at, job.completed_at),
      ...(stepPattern
        ? {
            steps: job.steps
              .filter((step) => step.conclusion !== "skipped" && stepPattern.test(step.name))
              .map((step) => ({
                name: step.name,
                seconds: seconds(step.started_at, step.completed_at),
              })),
          }
        : {}),
    })),
    // GitHub pages jobs; a full page may omit later ones.
    jobsLimited: jobs.length >= JOB_LIMIT,
  };
}
