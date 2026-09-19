/**
 * Projects one page of session JSONL into compact tool-call and failure events using jq.
 * Skips malformed lines and non-message data; never returns full code, images, or successful tool output.
 *
 * @param input.afterLine - Exclusive physical-line cursor, initially 0.
 * @param input.limit - Physical lines per page (1-500), default 200. Empty event pages may have more data.
 */
async function readPitSessionEvents(
  { jq },
  input: { file: string; afterLine?: number; limit?: number },
) {
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
  // jq handles projection only. Failure categories, correlation, and recommendations stay in TypeScript.
  const filter = String.raw`
def text: if type == "string" then . else "" end;
def object: if type == "object" then . else {} end;
def parts: .content | if type == "array" then map(select(type == "object")) else [] end;
def call:
  (.arguments | object) as $args | ($args.code | text) as $code |
  {id: (.id | text), label: ($args.label | text),
   programs: [$code | scan("shell\\.execFile\\(\\s*[\"']([^\"']+)") | .[0]],
   shellExec: ($code | test("shell\\.exec\\(")),
   promiseAll: ($code | contains("Promise.all")),
   workspaceBatch: ($code | test("workspace\\.batch\\("))};
def failure($message; $parts):
  ($parts | map(.text | text) | join("\n")) as $text |
  if $message.role == "toolResult" and ($message.isError == true or ($text | test("^(Error:|TypeScript validation failed:|Command failed)"))) then
    ($message.details | object | .failure | object) as $failure |
    {id: ($message.toolCallId | text),
     error: (($failure.rootError | text) | if length > 0 then . else ($text | split("\n")[0]) end),
     functionPath: ($failure.functionPath | if type == "array" then map(select(type == "string")) else [] end),
     failureKind: ($failure.kind | if type == "string" then . else null end)}
  else null end;
[limit($limit + 1; inputs | select(input_line_number > $afterLine) |
  {line: input_line_number, message: (try fromjson catch null)} |
  (.message | object | .message | object) as $message | ($message | parts) as $parts |
  {line, calls: [$parts[] | select(.type == "toolCall") | call], failure: failure($message; $parts)})] |
{hasMore: (length > $limit), nextLine: (.[0:$limit] | last.line // $afterLine),
 events: [.[0:$limit][] | select((.calls | length) > 0 or .failure != null) | {calls, failure}]}
`;
  const { values } = await jq({
    file: input.file,
    filter,
    variables: { afterLine, limit },
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
