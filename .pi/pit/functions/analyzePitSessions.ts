/**
 * Aggregates workflow failures and usage patterns across recent Pit sessions.
 *
 * @pit project
 * @param input.limit - Maximum sessions to inspect. The default is 12.
 * @param input.examples - Repeated failure labels retained per session. The default is 5.
 */
async function analyzePitSessions(
  { context, shell },
  input: { limit?: number; examples?: number } = {},
) {
  const runtime = await context.get();
  if (!runtime.sessionFile) {
    throw new Error("No current session file is available");
  }
  const directory = runtime.sessionFile.slice(0, runtime.sessionFile.lastIndexOf("/"));
  const listed = await shell.execFile(
    "find",
    [directory, "-maxdepth", "1", "-type", "f", "-name", "*.jsonl", "-print"],
    { raise: true, maxBytes: 50000, maxLines: 500 },
  );
  const limit = Math.max(1, Math.min(input.limit ?? 12, 20));
  const files = listed.stdout.trim().split("\n").filter(Boolean).sort().reverse().slice(0, limit);
  const audits: Array<Awaited<ReturnType<typeof analyzePitSession>>> = [];
  for (let offset = 0; offset < files.length; offset += 4) {
    const batch = files.slice(offset, offset + 4);
    audits.push(
      ...(await Promise.all(
        batch.map((file) => analyzePitSession({ file, examples: input.examples ?? 5 })),
      )),
    );
  }
  const categories: Record<string, number> = {};
  const programs: Record<string, number> = {};
  const labels: Record<string, number> = {};
  const recommendations = new Set<string>();
  for (const audit of audits) {
    for (const [name, count] of Object.entries(audit.categories ?? {})) {
      categories[name] = (categories[name] ?? 0) + Number(count);
    }
    for (const [name, count] of Object.entries(audit.execFilePrograms ?? {})) {
      programs[name] = (programs[name] ?? 0) + Number(count);
    }
    for (const [label, count] of audit.repeatedWorkflowFailureLabels ?? []) {
      if (label) {
        labels[label] = (labels[label] ?? 0) + Number(count);
      }
    }
    for (const recommendation of audit.recommendations ?? []) {
      recommendations.add(recommendation);
    }
  }
  const total = (field: string) =>
    audits.reduce((sum, audit) => sum + Number(audit[field] ?? 0), 0);
  const toolCalls = total("toolCalls");
  const workflowFailures = total("workflowFailures");
  return {
    directory,
    sessions: audits.length,
    toolCalls,
    failures: total("failures"),
    workflowFailures,
    gateFailures: total("gateFailures"),
    workflowFailureRatePercent: Number(
      ((100 * workflowFailures) / Math.max(1, toolCalls)).toFixed(1),
    ),
    categories,
    execFilePrograms: programs,
    repeatedWorkflowFailureLabels: Object.entries(labels)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12),
    recommendations: [...recommendations],
    perSession: audits.map((audit) => ({
      file: audit.file.split("/").at(-1),
      toolCalls: audit.toolCalls,
      workflowFailures: audit.workflowFailures,
      gateFailures: audit.gateFailures,
      categories: audit.categories,
    })),
  };
}
