/**
 * Finds past runs of a prompt template, or any fixed user message, across every project's Pi
 * sessions and summarizes what followed each run: tool-call labels, errors, saved function IDs,
 * duration, cost, the final assistant report, and the user's next message. Use it to judge a
 * prompt or skill by its real use.
 *
 * A run spans the messages after the matching user message, in file order, up to the next user
 * message, so a branched session can mix branches. Each matching file is read whole by one jq
 * query; a file whose summary exceeds jq's output limit is listed in `failures`.
 *
 * @param input.marker - Text the expanded user message starts with, or contains with `match`.
 *   At least 12 characters.
 * @param input.match - "prefix" (default) or "contains".
 * @param input.limit - Newest runs returned (1-100). The default is 40.
 * @param input.reportChars - Characters kept from each final report (0-4000). The default is 600.
 * @param input.nextChars - Characters kept from each next user message (0-2000). The default is
 *   300.
 * @param input.includeCurrent - Include the current session file. The default is false.
 */
async function findPromptRuns(
  { context: { get }, shell: { execFile }, jq },
  input: {
    marker: string;
    match?: "prefix" | "contains";
    limit?: number;
    reportChars?: number;
    nextChars?: number;
    includeCurrent?: boolean;
  },
) {
  interface Run {
    id: string;
    ts: string;
    end: string;
    toolCalls: number;
    labels: string[];
    savedIds: string[];
    toolErrors: number;
    errors: string[];
    cost: number;
    report: string;
    next: string | null;
  }
  const marker = input.marker?.trim() ?? "";
  if (marker.length < 12 || marker.includes("\0")) {
    throw new Error("marker must be at least 12 characters");
  }
  const match = input.match ?? "prefix";
  if (match !== "prefix" && match !== "contains") {
    throw new Error('match must be "prefix" or "contains"');
  }
  const bounded = (name: string, value: number | undefined, fallback: number, max: number) => {
    const result = value ?? fallback;
    if (!Number.isInteger(result) || result < 0 || result > max) {
      throw new Error(`${name} must be an integer from 0 to ${max}`);
    }
    return result;
  };
  const limit = bounded("limit", input.limit, 40, 100);
  if (limit < 1) throw new Error("limit must be an integer from 1 to 100");
  const reportChars = bounded("reportChars", input.reportChars, 600, 4000);
  const nextChars = bounded("nextChars", input.nextChars, 300, 2000);

  const { sessionFile } = await get();
  if (!sessionFile) throw new Error("No current session file is available");
  // Pi stores sessions as <root>/<project directory>/<session>.jsonl.
  const root = sessionFile.split("/").slice(0, -2).join("/");
  if (!root) throw new Error(`Cannot find the sessions directory above ${sessionFile}`);
  const grep = await execFile("grep", ["-rlF", "--include=*.jsonl", "--", marker, root], {
    raise: false,
    timeoutMs: 60000,
    maxBytes: 1_000_000,
  });
  // grep exits 1 when nothing matches.
  if (grep.code > 1) throw new Error(`grep failed (exit ${grep.code}): ${grep.stderr.slice(-500)}`);
  if (grep.truncated) {
    throw new Error("Session discovery was truncated; refusing an incomplete selection");
  }
  const files = grep.stdout
    .split("\n")
    .filter((file) => file && (input.includeCurrent || file !== sessionFile))
    .sort();

  const filter = String.raw`
def text: if type == "string" then . else ([.[]? | select(.type == "text") | .text] | join(" ")) end;
def hit: if $prefix then startswith($marker) else contains($marker) end;
[inputs | fromjson? | select(type == "object" and .type == "message")] as $m
| ($m | length) as $n
| range(0; $n) as $i
| select($m[$i].message.role == "user" and ($m[$i].message.content | text | hit))
| (first(range($i + 1; $n) | select($m[.].message.role == "user")) // $n) as $end
| $m[$i + 1:$end] as $w
| [$w[] | select(.message.role == "assistant") | .message.content[]? | select(.type == "toolCall")] as $calls
| [$w[] | select(.message.role == "toolResult" and .message.isError)] as $failed
| {
    id: $m[$i].id,
    ts: $m[$i].timestamp,
    end: (($w | last | .timestamp) // $m[$i].timestamp),
    toolCalls: ($calls | length),
    labels: [$calls[] | (.arguments.label // .arguments.functionId // .name // "?") | tostring | .[0:90]][0:20],
    savedIds: ([$calls[] | .arguments.functionId // empty | tostring] | unique),
    toolErrors: ($failed | length),
    errors: [$failed[] | (.message.content | text | .[0:200])][0:4],
    cost: ([$w[] | .message.usage.cost.total? | numbers] | add // 0),
    report: ([$w[] | select(.message.role == "assistant") | (.message.content | text) | select(test("\\S"))] | last // "" | .[0:$reportChars]),
    next: (if $end < $n then ($m[$end].message.content | text | .[0:$nextChars]) else null end)
  }`;

  const runs: Array<Omit<Run, "end"> & { project: string; file: string; minutes: number }> = [];
  const failures: Array<{ file: string; error: string }> = [];
  for (const file of files) {
    const relative = file.slice(root.length + 1);
    try {
      const { values } = await jq({
        file,
        filter,
        rawInput: true,
        nullInput: true,
        variables: { marker, prefix: match === "prefix", reportChars, nextChars },
      });
      const project = (relative.split("/")[0] ?? relative).replace(/^-+|-+$/g, "");
      for (const value of values as unknown as Run[]) {
        const { end, ...run } = value;
        runs.push({
          project,
          file: relative,
          ...run,
          minutes: Math.round((Date.parse(end) - Date.parse(run.ts)) / 60000),
          cost: Math.round(run.cost * 100) / 100,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ file: relative, error: message.slice(0, 300) });
    }
  }

  runs.sort((a, b) => b.ts.localeCompare(a.ts));
  const followUps = new Map<string, number>();
  for (const run of runs) {
    const key = run.next === null ? "<none>" : run.next.trim().toLowerCase().slice(0, 40);
    followUps.set(key, (followUps.get(key) ?? 0) + 1);
  }
  return {
    root,
    filesMatched: files.length,
    total: runs.length,
    omitted: Math.max(0, runs.length - limit),
    topFollowUps: [...followUps]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([text, count]) => ({ text, count })),
    runs: runs.slice(0, limit),
    failures: failures.slice(0, 10),
    failuresOmitted: Math.max(0, failures.length - 10),
  };
}
