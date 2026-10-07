/**
 * Projects one page of session JSONL into compact tool-call, failure, and context events using jq.
 * Skips malformed lines and non-message data; never returns full code, images, or successful tool output.
 * Context events carry provider usage with request timing and model, user turns, system-prompt
 * updates, `usage` entries such as cache refreshes, successful `session.*` calls,
 * `pit.context-edit` operations, `pit.context-pressure` notices, and compactions.
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
  // jq handles projection only. Failure categories, correlation, context metrics, and
  // recommendations stay in TypeScript.
  const filter = String.raw`
def text: if type == "string" then . else "" end;
def num: if type == "number" then . else 0 end;
def clip($n): if length > $n then .[0:$n] else . end;
def object: if type == "object" then . else {} end;
def items: if type == "array" then .[] else empty end;
def ids($n): [items | select(type == "string") | clip(64)] | .[0:$n];
def parts: .content | if type == "array" then map(select(type == "object")) else [] end;
def usage: object | {input: (.input | num), output: (.output | num), cacheRead: (.cacheRead | num),
  cacheWrite: (.cacheWrite | num), cost: (.cost | object | .total | num)};
def call:
  (.arguments | object) as $args | ($args.code | text) as $code |
  ([$code | scan("inspectEntry\\(\\s*[\"'\u0060]([^\"'\u0060]+)") | .[0] | clip(64)] | .[0:16]) as $inspected |
  {id: (.id | text), label: ($args.label | text | clip(200)),
   programs: ([$code | scan("shell\\.execFile\\(\\s*[\"']([^\"']+)") | .[0] | clip(200)] | .[0:16]),
   shellExec: ($code | test("shell\\.exec\\(")),
   promiseAll: ($code | contains("Promise.all")),
   workspaceBatch: ($code | test("workspace\\.batch\\("))} +
  (if ($inspected | length) > 0 then {inspectTargets: $inspected} else {} end);
def failure($message; $parts):
  ($parts | map(.text | text) | join("\n")) as $text |
  if $message.role == "toolResult" and ($message.isError == true or ($text | test("^(Error:|TypeScript validation failed:|Command failed)"))) then
    ($message.details | object | .failure | object) as $failure |
    {id: ($message.toolCallId | text),
     error: (($failure.rootError | text) | if length > 0 then . else ($text | split("\n")[0]) end | clip(500)),
     functionPath: ($failure.functionPath | if type == "array" then map(select(type == "string") | clip(200)) | .[0:16] else [] end),
     failureKind: ($failure.kind | if type == "string" then . else null end)}
  else null end;
def context($entry; $message):
  if $entry.type == "message" and $message.role == "assistant" then
    {request: (($message.usage | usage) + {start: ($message.timestamp | num), at: ($entry.timestamp | text | clip(40)),
      model: ((($message.provider | text) + "/" + ($message.model | text)) | clip(200)),
      cacheWriteCost: ($message.usage | object | .cost | object | .cacheWrite | num)})}
  elif $entry.type == "message" and $message.role == "user" then {user: true}
  elif $entry.type == "message" and $message.role == "system" then
    {system: ([($message.sections | object | keys[]),
      ($message | keys[] | select(startswith("tools")) as $key | $message[$key] |
        select(type == "array" and length > 0) | "tools")] | unique | map(clip(64)) | .[0:32])}
  elif $entry.type == "usage" then
    {usageEntry: {kind: ($entry.kind | text | clip(32)), at: ($entry.timestamp | text | clip(40)),
      cacheRead: ($entry.usage | object | .cacheRead | num), cost: ($entry.usage | object | .cost | object | .total | num)}}
  elif $entry.type == "message" and $message.role == "toolResult" then
    ([$message.details | object | .traces | items | object |
      select(.namespace == "session" and .status == "succeeded") | .method | text | clip(64)] | .[0:64]) as $calls |
    if ($calls | length) > 0 then {sessionCalls: $calls} else null end
  elif $entry.type == "custom" and $entry.customType == "pit.context-edit" then
    {edits: [$entry.data | object | .operations | items | object |
      {operation: (.operation | text | clip(32)), targets: (.targets | ids(128)), covers: (.covers | ids(128)),
       action: (.action | if type == "string" then clip(32) else null end),
       tokensFreed: (.tokensFreed | num), reprefillTokens: (.reprefillTokens | num)}] | .[0:32]}
  elif $entry.type == "custom_message" and $entry.customType == "pit.context-pressure" then
    {notice: ($entry.details | object | {level: (.level | num), percent: (.percent | num),
      tokens: (.tokens | num), contextWindow: (.contextWindow | num),
      threshold: (.threshold | if type == "string" then clip(16) else null end)})}
  elif $entry.type == "compaction" then
    {compaction: {tokensBefore: ($entry.tokensBefore | num), usage: ($entry.usage | usage)}}
  else null end;
[limit($limit + 1; inputs | select(input_line_number > $afterLine) |
  {line: input_line_number, entry: (try fromjson catch null)} |
  (.entry | object) as $entry | ($entry.message | object) as $message | ($message | parts) as $parts |
  {line, calls: [$parts[] | select(.type == "toolCall") | call], failure: failure($message; $parts),
   context: context($entry; $message)} |
  .event = ({calls, failure} + (if .context == null then {} else {context} end)) |
  .bytes = (if (.calls | length) > 0 or .failure != null or .context != null then (.event | tojson | utf8bytelength) + 1 else 0 end))] |
(reduce .[0:$limit][] as $line ({count: 0, bytes: 0, full: false};
  if .full then . elif .count > 0 and .bytes + $line.bytes > $maxBytes then .full = true
  else .count += 1 | .bytes += $line.bytes end) | .count) as $count |
{hasMore: (length > $count), nextLine: (if $count > 0 then .[$count - 1].line else $afterLine end),
 events: [.[0:$count][] | select(.bytes > 0) | .event]}
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
    /** Literal entry IDs passed to `inspectEntry(...)` in the call's code. */
    inspectTargets?: string[];
  };
  type Failure = { id: string; error: string; functionPath: string[]; failureKind: string | null };
  type Usage = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  };
  type EditOperation = {
    operation: string;
    targets: string[];
    covers: string[];
    action: string | null;
    tokensFreed: number;
    reprefillTokens: number;
  };
  type Context = {
    /** One assistant message: a provider request and its usage. */
    request?: Usage & {
      /** Request start in epoch milliseconds; 0 when unrecorded. */
      start: number;
      /** The entry's ISO timestamp, written when the response completed. */
      at: string;
      /** `provider/model`. */
      model: string;
      /** Recorded dollars for the request's cache writes. */
      cacheWriteCost: number;
    };
    /** A user message. */
    user?: true;
    /** A system-prompt update: the changed section names, plus `tools` when tools changed. */
    system?: string[];
    /** A usage entry outside the conversation, such as a `cache_warm` refresh. */
    usageEntry?: { kind: string; at: string; cacheRead: number; cost: number };
    /** Successful `session.*` method names traced in one tool result. */
    sessionCalls?: string[];
    edits?: EditOperation[];
    notice?: {
      level: number;
      percent: number;
      tokens: number;
      contextWindow: number;
      /** The threshold that fired, such as "50%" or "200K"; null before Pit 0.24. */
      threshold: string | null;
    };
    compaction?: { tokensBefore: number; usage: Usage };
  };
  if (values.length !== 1) throw new Error("Expected one jq session page");
  // The fixed projection above owns this schema; the jq adapter guarantees complete, valid JSON.
  return values[0] as {
    hasMore: boolean;
    nextLine: number;
    events: Array<{ calls: Call[]; failure: Failure | null; context?: Context }>;
  };
}
