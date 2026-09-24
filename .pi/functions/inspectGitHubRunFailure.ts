/**
 * Explains a failed GitHub Actions run: its failed jobs and steps, plus a bounded log excerpt
 * ending at each job's last `##[error]` line. Job logs end with post-job cleanup, so the excerpt
 * anchors on the error instead of the log tail.
 *
 * @param input.lines - Log lines to keep before each job's last error (5-200). The default is 40.
 * @param input.jobs - Failed jobs to inspect (1-10). The default is 3; `omittedJobs` counts the rest.
 */
async function inspectGitHubRunFailure(
  { gh: { runView, api } },
  input: { repo: string; id: number; lines?: number; jobs?: number },
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
  if (!/^[\w.-]+\/[\w.-]+$/.test(input.repo)) throw new Error("repo must be owner/name");
  const id = integerInput("id", input.id, 0, 1, Number.MAX_SAFE_INTEGER);
  const lineLimit = integerInput("lines", input.lines, 40, 5, 200);
  const jobLimit = integerInput("jobs", input.jobs, 3, 1, 10);
  type Step = { name: string; number: number; status: string; conclusion: string };
  type Job = {
    databaseId: number;
    name: string;
    status: string;
    conclusion: string;
    url: string;
    steps?: Step[];
  };
  const view = await runView(id, {
    repo: input.repo,
    json: ["name", "status", "conclusion", "url", "headSha", "jobs"],
    maxBytes: 50000,
    raise: true,
  });
  if (view.truncated) throw new Error(`GitHub Actions run ${id} details were truncated`);
  const run = JSON.parse(view.stdout) as {
    name: string;
    status: string;
    conclusion: string;
    url: string;
    headSha: string;
    jobs?: Job[];
  };
  const passing = new Set(["success", "skipped", "neutral"]);
  const failed = (run.jobs ?? []).filter(
    (job) => job.status === "completed" && !passing.has(job.conclusion),
  );
  // Built from a character code so the linted source contains no control character.
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
  const clean = (line: string) =>
    line
      .replace(/^\uFEFF/, "")
      .replace(TIMESTAMP, "")
      .replace(ANSI, "")
      .replace(/\r$/, "")
      .slice(0, 300);
  const ERROR_MARKER = "##[error]";
  const STEP_MARKER = "##[group]Run ";

  const failedJobs = await Promise.all(
    failed.slice(0, jobLimit).map(async (job) => {
      const summary = {
        name: job.name,
        conclusion: job.conclusion,
        url: job.url,
        failedSteps: (job.steps ?? [])
          .filter((step) => step.status === "completed" && !passing.has(step.conclusion))
          .map((step) => `${step.number}. ${step.name} (${step.conclusion})`),
      };
      const log = await api(`repos/${input.repo}/actions/jobs/${job.databaseId}/logs`, [], {
        raise: false,
        maxBytes: 51200,
        truncate: "tail",
      });
      if (log.code !== 0) {
        return Object.assign(summary, {
          step: null,
          errors: [],
          excerpt: "",
          logTruncated: false,
          logError: (log.stderr || log.stdout).trim().slice(0, 300),
        });
      }
      const lines = log.stdout.split("\n").map(clean);
      const errorIndexes = lines.flatMap((line, index) =>
        line.startsWith(ERROR_MARKER) ? [index] : [],
      );
      const cleanup = lines.findIndex((line) => line.startsWith("Post job cleanup."));
      const anchor = errorIndexes.at(-1) ?? (cleanup > 0 ? cleanup - 1 : lines.length - 1);
      let step: string | null = null;
      for (let index = anchor; index >= 0; index--) {
        if (lines[index].startsWith(STEP_MARKER)) {
          step = lines[index].slice(STEP_MARKER.length);
          break;
        }
      }
      return Object.assign(summary, {
        step,
        errors: errorIndexes.slice(-10).map((index) => lines[index].slice(ERROR_MARKER.length)),
        excerpt: lines
          .slice(Math.max(0, anchor - lineLimit), anchor + 1)
          .filter((line) => line !== "##[endgroup]")
          .join("\n"),
        logTruncated: log.truncated,
      });
    }),
  );
  return {
    id,
    name: run.name,
    url: run.url,
    status: run.status,
    conclusion: run.conclusion,
    headSha: run.headSha,
    failedJobs,
    omittedJobs: Math.max(0, failed.length - jobLimit),
    ...(run.status === "completed"
      ? {}
      : { note: `Run is still ${run.status}; only jobs that already failed are shown.` }),
  };
}
