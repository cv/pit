/**
 * Projects one page of session JSONL into compact tool-call and failure events using jq.
 * Skips malformed lines and non-message data; never returns full code, images, or successful tool output.
 *
 * @param input.afterLine - Exclusive physical-line cursor, initially 0.
 * @param input.limit - Physical lines per page (1-500), default 200. Pages also end early after
 *   about 40 KB of events, always keeping at least one line. Empty event pages may have more data.
 */
async function readEvents({ jq }, input: { file: string; afterLine?: number; limit?: number }) {
  const afterLine = input.afterLine ?? 0;
  const limit = input.limit ?? 200;
  if (
    !Number.isSafeInteger(afterLine) ||
    afterLine < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500
  ) {
    throw new Error(
      "Session page requires a non-negative integer cursor and a limit from 1 to 500",
    );
  }
  // Stays below the jq adapter's 50 KB output cap, which rejects rather than truncates.
  const MAX_PAGE_BYTES = 40_000;
  // jq handles projection only. Failure categories, correlation, and recommendations stay in TypeScript.
  const filter = String.raw`
def text: if type == "string" then . else "" end;
def clip($n): if length > $n then .[0:$n] else . end;
def object: if type == "object" then . else {} end;
def parts: .content | if type == "array" then map(select(type == "object")) else [] end;
def call:
  (.arguments | object) as $args | ($args.code | text) as $code |
  {id: (.id | text), label: ($args.label | text | clip(200)),
   programs: ([$code | scan("shell\\.execFile\\(\\s*[\"']([^\"']+)") | .[0] | clip(200)] | .[0:16]),
   shellExec: ($code | test("shell\\.exec\\(")),
   promiseAll: ($code | contains("Promise.all")),
   workspaceBatch: ($code | test("workspace\\.batch\\("))};
def failure($message; $parts):
  ($parts | map(.text | text) | join("\n")) as $text |
  if $message.role == "toolResult" and ($message.isError == true or ($text | test("^(Error:|TypeScript validation failed:|Command failed)"))) then
    ($message.details | object | .failure | object) as $failure |
    {id: ($message.toolCallId | text),
     error: (($failure.rootError | text) | if length > 0 then . else ($text | split("\n")[0]) end | clip(500)),
     functionPath: ($failure.functionPath | if type == "array" then map(select(type == "string") | clip(200)) | .[0:16] else [] end),
     failureKind: ($failure.kind | if type == "string" then . else null end)}
  else null end;
[limit($limit + 1; inputs | select(input_line_number > $afterLine) |
  {line: input_line_number, message: (try fromjson catch null)} |
  (.message | object | .message | object) as $message | ($message | parts) as $parts |
  {line, calls: [$parts[] | select(.type == "toolCall") | call], failure: failure($message; $parts)} |
  .bytes = (if (.calls | length) > 0 or .failure != null then ({calls, failure} | tojson | utf8bytelength) + 1 else 0 end))] |
(reduce .[0:$limit][] as $line ({count: 0, bytes: 0, full: false};
  if .full then . elif .count > 0 and .bytes + $line.bytes > $maxBytes then .full = true
  else .count += 1 | .bytes += $line.bytes end) | .count) as $count |
{hasMore: (length > $count), nextLine: (if $count > 0 then .[$count - 1].line else $afterLine end),
 events: [.[0:$count][] | select(.bytes > 0) | {calls, failure}]}
`;
  const { values } = await jq({
    file: input.file,
    filter,
    variables: { afterLine, limit, maxBytes: MAX_PAGE_BYTES },
    rawInput: true,
    nullInput: true,
  });
  type Call = {
    id: string;
    label: string;
    programs: string[];
    shellExec: boolean;
    promiseAll: boolean;
    workspaceBatch: boolean;
  };
  type Failure = { id: string; error: string; functionPath: string[]; failureKind: string | null };
  if (values.length !== 1) throw new Error("Expected one jq session page");
  // The fixed projection above owns this schema; the jq adapter guarantees complete, valid JSON.
  return values[0] as {
    hasMore: boolean;
    nextLine: number;
    events: Array<{ calls: Call[]; failure: Failure | null }>;
  };
}
