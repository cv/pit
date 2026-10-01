/**
 * Audits a Pi session for recurring tool-call failures, workflow smells, and context-management
 * telemetry: provider usage, compactions, context edits, pressure notices, and edit churn.
 * Processes compact pages, keeping correlation and classification in TypeScript.
 *
 * @param input.examples - Recent failure examples to retain (1-30). The default is 12.
 */
async function analyze(
  { context: { get }, sessions: { readEvents } },
  input: { file?: string; examples?: number } = {},
) {
  const examples = input.examples ?? 12;
  if (!Number.isInteger(examples) || examples < 1 || examples > 30) {
    throw new Error("examples must be an integer between 1 and 30");
  }
  const file = input.file ?? (await get()).sessionFile;
  if (!file) throw new Error("No Pi session file is available");
  type Page = Awaited<ReturnType<typeof readEvents>>;
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
  // Context telemetry. A pressure notice counts as followed when an elide or summarize is
  // recorded within the next NOTICE_WINDOW model turns (assistant messages).
  const NOTICE_WINDOW = 3;
  type Usage = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  };
  const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  const addUsage = (total: Usage, usage: Usage) => {
    for (const key of Object.keys(total) as Array<keyof Usage>) total[key] += usage[key];
  };
  const roundCost = (usage: Usage) => ({ ...usage, cost: Number(usage.cost.toFixed(6)) });
  const sum = (counts: Map<string, number>) => [...counts.values()].reduce((a, b) => a + b, 0);
  const requestUsage = emptyUsage();
  const compactionUsage = emptyUsage();
  let requests = 0;
  let peakPromptTokens = 0;
  let compactions = 0;
  let compactedTokens = 0;
  const operations = new Map<string, number>();
  const noteActions = new Map<string, number>();
  let tokensFreed = 0;
  let reprefillTokens = 0;
  const sessionCalls = new Map<string, number>();
  const noticeLevels = new Map<string, number>();
  let noticesFollowed = 0;
  let pendingNotices: number[] = [];
  // Entries an elide or summarize removed from context, and how many times each was removed.
  const removed = new Set<string>();
  const reductions = new Map<string, number>();
  let inspectedRemoved = 0;
  let afterLine = 0;
  const MAX_SESSION_LINES = 100_000;
  type Telemetry = NonNullable<Awaited<ReturnType<typeof readEvents>>["events"][number]["context"]>;
  const recordContext = (telemetry: Telemetry) => {
    if (telemetry.request) {
      const { request } = telemetry;
      requests++;
      addUsage(requestUsage, request);
      peakPromptTokens = Math.max(
        peakPromptTokens,
        request.input + request.cacheRead + request.cacheWrite,
      );
      pendingNotices = pendingNotices
        .map((turns) => turns + 1)
        .filter((turns) => turns <= NOTICE_WINDOW);
    }
    for (const method of telemetry.sessionCalls ?? []) increment(sessionCalls, method);
    for (const edit of telemetry.edits ?? []) {
      increment(operations, edit.operation);
      if (edit.action) increment(noteActions, edit.action);
      tokensFreed += edit.tokensFreed;
      reprefillTokens += edit.reprefillTokens;
      if (edit.operation === "restore") {
        for (const target of [...edit.targets, ...edit.covers]) removed.delete(target);
      }
      if (edit.operation !== "elide" && edit.operation !== "summarize") continue;
      noticesFollowed += pendingNotices.length;
      pendingNotices = [];
      for (const target of edit.covers.length > 0 ? edit.covers : edit.targets) {
        removed.add(target);
        increment(reductions, target);
      }
    }
    if (telemetry.notice) {
      // Keyed by the threshold that fired; notices from before Pit 0.24 had only percentages.
      const { level, threshold } = telemetry.notice;
      increment(noticeLevels, threshold ?? `${level}%`);
      pendingNotices.push(0);
    }
    if (telemetry.compaction) {
      compactions++;
      compactedTokens += telemetry.compaction.tokensBefore;
      addUsage(compactionUsage, telemetry.compaction.usage);
    }
  };
  for (;;) {
    if (afterLine >= MAX_SESSION_LINES)
      throw new Error(`Session exceeds ${MAX_SESSION_LINES} lines; refusing an incomplete audit`);
    // Each page rescans the file from its start, so request the largest pages; the reader
    // ends dense pages early at its byte budget.
    const page = await readEvents({ file, afterLine, limit: 500 });
    for (const event of page.events) {
      for (const call of event.calls) {
        calls.set(call.id, call.label);
        toolCalls++;
        for (const program of call.programs) increment(programs, program);
        shellExecCalls += Number(call.shellExec);
        promiseAllCalls += Number(call.promiseAll);
        workspaceBatchCalls += Number(call.workspaceBatch);
        for (const target of call.inspectTargets ?? [])
          inspectedRemoved += Number(removed.has(target));
      }
      if (event.context) recordContext(event.context);
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
      'Use targeted tests and npm.run("check") before the final delivery.validate gate.',
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
    context: {
      requests,
      usage: roundCost(requestUsage),
      peakPromptTokens,
      compactions: {
        total: compactions,
        modelRequested: sessionCalls.get("compact") ?? 0,
        tokensBefore: compactedTokens,
        usage: roundCost(compactionUsage),
      },
      edits: {
        total: sum(operations),
        byOperation: Object.fromEntries(operations),
        noteActions: Object.fromEntries(noteActions),
        tokensFreed,
        reprefillTokens,
      },
      notices: {
        shown: sum(noticeLevels),
        byLevel: Object.fromEntries(noticeLevels),
        followed: noticesFollowed,
        followWindowTurns: NOTICE_WINDOW,
      },
      churn: {
        inspectedRemovedEntries: inspectedRemoved,
        reeditedEntries: [...reductions.values()].filter((count) => count > 1).length,
      },
      sessionCalls: Object.fromEntries(sessionCalls),
    },
    recommendations,
  };
}
