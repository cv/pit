/**
 * Audits a Pi session for recurring tool-call failures and workflow smells.
 * Processes compact pages, keeping correlation and classification in TypeScript.
 */
async function analyzePitSession(
  { context: { get }, readPitSessionEvents },
  input: { file?: string; examples?: number } = {},
) {
  const file = input.file ?? (await get()).sessionFile;
  if (!file) throw new Error("No Pi session file is available");
  if (input.examples !== undefined && !Number.isInteger(input.examples)) {
    throw new Error("examples must be an integer");
  }
  const examples = Math.max(1, Math.min(input.examples ?? 12, 30));
  type Page = Awaited<ReturnType<typeof readPitSessionEvents>>;
  type Failure = NonNullable<Page["events"][number]["failure"]>;
  const classifyFailure = (label: string, error: string) => {
    if (
      /^(?:Expect failure:|Trigger .*?(?:failure|timeout)|Verify .*?(?:reject|fail))/i.test(label)
    )
      return "expected";
    if (/Anchor mismatch|anchor references line/i.test(error)) return "anchor";
    if (/Revision mismatch/i.test(error)) return "revision";
    if (/TypeScript validation failed/i.test(error)) return "typescript";
    if (
      /validation|coverage|static checks?|tests?|package|CI run/i.test(label) &&
      /Command failed|(?:Saved function|Function) .* failed/i.test(error)
    )
      return "gate";
    return /Command failed/i.test(error) ? "command" : "logic";
  };
  const increment = (counts: Map<string, number>, key: string) =>
    counts.set(key, (counts.get(key) ?? 0) + 1);
  const calls = new Map<string, string>();
  const categories = new Map<string, number>();
  const programs = new Map<string, number>();
  const labels = new Map<string, number>();
  const recent: Array<Failure & { label: string; category: string }> = [];
  let toolCalls = 0;
  let failures = 0;
  let workflowFailures = 0;
  let shellExecCalls = 0;
  let promiseAllCalls = 0;
  let workspaceBatchCalls = 0;
  let afterLine = 0;
  const MAX_SESSION_LINES = 100_000;
  for (;;) {
    if (afterLine >= MAX_SESSION_LINES)
      throw new Error(`Session exceeds ${MAX_SESSION_LINES} lines; refusing an incomplete audit`);
    // Each page rescans the file from its start, so request the largest pages; the reader
    // ends dense pages early at its byte budget.
    const page = await readPitSessionEvents({ file, afterLine, limit: 500 });
    for (const event of page.events) {
      for (const call of event.calls) {
        calls.set(call.id, call.label);
        toolCalls++;
        for (const program of call.programs) increment(programs, program);
        shellExecCalls += Number(call.shellExec);
        promiseAllCalls += Number(call.promiseAll);
        workspaceBatchCalls += Number(call.workspaceBatch);
      }
      const failure = event.failure;
      if (!failure || !calls.has(failure.id)) continue;
      const label = calls.get(failure.id) ?? "";
      const kind = classifyFailure(label, failure.error);
      failures++;
      increment(categories, kind);
      if (kind !== "gate" && kind !== "expected") {
        workflowFailures++;
        increment(labels, label);
      }
      recent.push({ ...failure, label, category: kind });
      if (recent.length > examples) recent.shift();
    }
    if (!page.hasMore) break;
    if (page.nextLine <= afterLine) throw new Error("Session page cursor did not advance");
    afterLine = page.nextLine;
  }
  const recommendations: string[] = [];
  if (categories.has("gate"))
    recommendations.push(
      'Use targeted tests and npm.run("check") before the final validatePit gate.',
    );
  if (categories.has("typescript"))
    recommendations.push(
      "After a TypeScript submission failure, inspect declared types and numeric bounds, then simplify the next call.",
    );
  if (categories.has("anchor") || categories.has("revision"))
    recommendations.push(
      "Make a fresh read/search of every edit target the immediately preceding workspace operation.",
    );
  if ([...labels.values()].some((count) => count > 1))
    recommendations.push("Split workflows that repeat the same failing label.");
  if (recommendations.length === 0)
    recommendations.push("No recurring workflow failure needs action.");
  const rate = (count: number) => Number(((100 * count) / Math.max(1, toolCalls)).toFixed(1));
  return {
    file,
    toolCalls,
    failures,
    failureRatePercent: rate(failures),
    workflowFailures,
    workflowFailureRatePercent: rate(workflowFailures),
    gateFailures: categories.get("gate") ?? 0,
    expectedFailures: categories.get("expected") ?? 0,
    categories: Object.fromEntries(categories),
    execFilePrograms: Object.fromEntries(programs),
    shellExecCalls,
    promiseAllCalls,
    workspaceBatchCalls,
    repeatedWorkflowFailureLabels: [...labels].sort((a, b) => b[1] - a[1]).slice(0, examples),
    recentFailureExamples: recent.map(({ category, label, error, functionPath, failureKind }) => ({
      category,
      label,
      error,
      functionPath,
      failureKind: failureKind ?? undefined,
    })),
    recommendations,
  };
}
