/**
 * Aggregates workflow failures, usage patterns, and context-management telemetry across recent
 * Pit sessions.
 *
 * @param input.limit - Maximum sessions to inspect (1-20). The default is 12.
 * @param input.examples - Repeated failure labels retained per session (1-30, validated by
 *   sessions.analyze). The default is 5.
 */
async function analyzeRecent(
  { context: { get }, workspace: { glob }, sessions: { analyze } },
  input: { limit?: number; examples?: number } = {},
) {
  const limit = input.limit ?? 12;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error("limit must be an integer between 1 and 20");
  }
  const runtime = await get();
  if (!runtime.sessionFile) {
    throw new Error("No current session file is available");
  }
  const slash = runtime.sessionFile.lastIndexOf("/");
  const directory = slash < 0 ? "." : runtime.sessionFile.slice(0, slash) || "/";
  const escaped = directory.replace(/([*?[\]{}()!+@\\])/g, "\\$1");
  const listed = await glob(`${escaped === "/" ? "" : escaped}/*.jsonl`, {
    onlyFiles: true,
    dot: true,
    limit: 10000,
  });
  if (listed.truncated)
    throw new Error("Session discovery was truncated; refusing an incomplete selection");
  const files = [...listed.entries].sort().reverse().slice(0, limit);
  const audits: Array<Awaited<ReturnType<typeof analyze>>> = [];
  for (let offset = 0; offset < files.length; offset += 4) {
    const batch = files.slice(offset, offset + 4);
    audits.push(
      ...(await Promise.all(batch.map((file) => analyze({ file, examples: input.examples ?? 5 })))),
    );
  }
  const categories = new Map<string, number>();
  const programs = new Map<string, number>();
  const labels = new Map<string, number>();
  const recommendations = new Set<string>();
  for (const audit of audits) {
    for (const [name, count] of Object.entries(audit.categories ?? {})) {
      categories.set(name, (categories.get(name) ?? 0) + count);
    }
    for (const [name, count] of Object.entries(audit.execFilePrograms ?? {})) {
      programs.set(name, (programs.get(name) ?? 0) + count);
    }
    for (const [label, count] of audit.repeatedWorkflowFailureLabels ?? []) {
      if (label) {
        labels.set(label, (labels.get(label) ?? 0) + count);
      }
    }
    for (const recommendation of audit.recommendations ?? []) {
      recommendations.add(recommendation);
    }
  }
  // Sums each numeric leaf of the per-session context reports. Peaks and fixed parameters take
  // the maximum. Null-prototype nodes keep recorded names such as "__proto__" as plain keys.
  type Tree = { [key: string]: number | Tree };
  const MAXIMA = new Set(["peakPromptTokens", "followWindowTurns"]);
  const merge = (total: Tree, add: Tree): Tree => {
    for (const [key, value] of Object.entries(add)) {
      const current = total[key];
      if (typeof value === "number") {
        const base = typeof current === "number" ? current : 0;
        total[key] = MAXIMA.has(key) ? Math.max(base, value) : base + value;
      } else {
        total[key] = merge(typeof current === "object" ? current : Object.create(null), value);
      }
    }
    return total;
  };
  const roundCosts = (tree: Tree): Tree => {
    for (const [key, value] of Object.entries(tree)) {
      if (typeof value === "object") roundCosts(value);
      else if (key === "cost") tree[key] = Number(value.toFixed(6));
    }
    return tree;
  };
  const context = roundCosts(
    audits.reduce<Tree>(
      (total, audit) => merge(total, (audit.context ?? {}) as unknown as Tree),
      Object.create(null),
    ),
  );
  if (recommendations.size > 1)
    recommendations.delete("No recurring workflow failure needs action.");
  const total = (
    field: "toolCalls" | "failures" | "workflowFailures" | "gateFailures" | "expectedFailures",
  ) => audits.reduce((sum, audit) => sum + audit[field], 0);
  const toolCalls = total("toolCalls");
  const workflowFailures = total("workflowFailures");
  return {
    directory,
    sessions: audits.length,
    toolCalls,
    failures: total("failures"),
    workflowFailures,
    gateFailures: total("gateFailures"),
    expectedFailures: total("expectedFailures"),
    workflowFailureRatePercent: Number(
      ((100 * workflowFailures) / Math.max(1, toolCalls)).toFixed(1),
    ),
    categories: Object.fromEntries(categories),
    execFilePrograms: Object.fromEntries(programs),
    repeatedWorkflowFailureLabels: [...labels].sort((a, b) => b[1] - a[1]).slice(0, 12),
    context,
    recommendations: [...recommendations],
    perSession: audits.map((audit) => ({
      file: audit.file.split("/").at(-1),
      toolCalls: audit.toolCalls,
      workflowFailures: audit.workflowFailures,
      gateFailures: audit.gateFailures,
      expectedFailures: audit.expectedFailures,
      categories: audit.categories,
      contextEdits: audit.context?.edits.total ?? 0,
      contextNotices: audit.context?.notices.shown ?? 0,
      compactions: audit.context?.compactions.total ?? 0,
    })),
  };
}
