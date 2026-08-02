/**
 * Waits for a GitHub Actions run. Use when waiting for CI.
 *
 * @pit project
 */
async function waitForGitHubRun(
  { gh, shell },
  input: { id: number; repo: string; attempts?: number },
) {
  const attempts = input.attempts ?? 36;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await gh.runView(input.id, { repo: input.repo });
    const run = JSON.parse(result.stdout);
    if (run.status === "completed") {
      return {
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
    }
    await shell.execFile("sleep", ["5"], { raise: true });
  }
  return { status: "timed_out", id: input.id };
}
