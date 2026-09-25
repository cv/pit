/**
 * Submits a prompt or keys to an isolated Pi from managePitUxSession, waits for a new completion,
 * and returns the captured rows.
 *
 * @param input.fixture - Single-line prompt text, usually a fixture name such as trace-a.
 * @param input.keys - tmux key names sent after the prompt, such as Escape or C-o.
 * @param input.width - Resize the window to this many columns (40-400) first.
 * @param input.waitFor - Regular expression that marks completion. The default is
 *   "Fixture completed\.". A submitted prompt needs a new match; otherwise any match settles.
 * @param input.timeoutMs - Maximum wait (1000-120000). The default is 20000 ms; settled is false
 *   when it expires.
 * @param input.history - Scrollback rows captured above the screen (0-50000). The default is 400.
 * @param input.match - Regular expression selecting captured rows to return with their indexes,
 *   at most the last 40.
 * @param input.tail - Last rows returned (1-200). The default is 25. Rows are clipped to 200
 *   characters.
 */
async function runPitUxCase(
  { shell: { execFile } },
  input: {
    socket: string;
    target: string;
    fixture?: string;
    keys?: string[];
    width?: number;
    waitFor?: string;
    timeoutMs?: number;
    history?: number;
    match?: string;
    tail?: number;
  },
) {
  // Only this workflow's private servers: never the pane running the conversation.
  if (!/^\/tmp\/pit-ux-[A-Za-z0-9]+\/tmux\.sock$/.test(input.socket)) {
    throw new Error("socket must come from managePitUxSession (/tmp/pit-ux-*/tmux.sock)");
  }
  if (!/^[A-Za-z0-9_-]+:\d+\.\d+$/.test(input.target)) {
    throw new Error("target must be session:window.pane");
  }
  if (input.fixture !== undefined && !/^[^\n\r]{1,500}$/.test(input.fixture)) {
    throw new Error("fixture must be one line of 1-500 characters");
  }
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
  const timeoutMs = integerInput("timeoutMs", input.timeoutMs, 20000, 1000, 120000);
  const history = integerInput("history", input.history, 400, 0, 50000);
  const tail = integerInput("tail", input.tail, 25, 1, 200);
  const width =
    input.width === undefined ? undefined : integerInput("width", input.width, 0, 40, 400);
  const completion = new RegExp(input.waitFor ?? "Fixture completed\\.", "g");
  const pattern = input.match === undefined ? undefined : new RegExp(input.match);

  const tmux = (args: string[]) =>
    execFile("tmux", ["-S", input.socket, ...args], { maxBytes: 51200, truncate: "tail" });
  const capture = async () =>
    (await tmux(["capture-pane", "-p", "-t", input.target, "-S", String(-history)])).stdout
      .split("\n")
      .map((row) => row.trimEnd());
  const completions = (rows: string[]) => rows.join("\n").match(completion)?.length ?? 0;

  if (width !== undefined) {
    const session = input.target.slice(0, input.target.indexOf(":"));
    await tmux(["resize-window", "-t", session, "-x", String(width)]);
  }
  const before = completions(await capture());
  if (input.fixture !== undefined) {
    await tmux(["send-keys", "-t", input.target, "-l", input.fixture]);
    await tmux(["send-keys", "-t", input.target, "Enter"]);
  }
  if (input.keys?.length) await tmux(["send-keys", "-t", input.target, ...input.keys]);

  const deadline = Date.now() + timeoutMs;
  let rows = await capture();
  let settled = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    rows = await capture();
    // An earlier completion still on screen must not settle a newly submitted prompt.
    const count = completions(rows);
    if (input.fixture !== undefined ? count > before : count > 0) {
      settled = true;
      // Let the final render land before the returned capture.
      await new Promise((resolve) => setTimeout(resolve, 600));
      rows = await capture();
      break;
    }
  }
  while (rows.length && rows.at(-1) === "") rows.pop();
  const matched = pattern
    ? rows
        .flatMap((row, index) => (pattern.test(row) ? [`${index}: ${row.slice(0, 160)}`] : []))
        .slice(-40)
    : [];
  return {
    settled,
    rows: rows.length,
    matched,
    tail: rows.slice(-tail).map((row) => row.slice(0, 200)),
  };
}
