/**
 * Runs offline fixtures one at a time in an isolated Pi from ux.manageSession, each in a new Pi
 * session, and returns whether each settled and its status rows and decisive diagnostics.
 *
 * @param input.fixtures - Fixture names to run in order (1-30), such as trace-a or timeout.
 * @param input.timeoutMs - Maximum wait per fixture (1000-120000). The default is 40000 ms.
 */
async function runFixtures(
  { ux: { runCase }, shell: { execFile } },
  input: { socket: string; target: string; fixtures: string[]; timeoutMs?: number },
) {
  // Checked here too because /new is sent before ux.runCase validates its input.
  if (!/^\/tmp\/pit-ux-[A-Za-z0-9]+\/tmux\.sock$/.test(input.socket)) {
    throw new Error("socket must come from ux.manageSession (/tmp/pit-ux-*/tmux.sock)");
  }
  if (!/^[A-Za-z0-9_-]+:\d+\.\d+$/.test(input.target)) {
    throw new Error("target must be session:window.pane");
  }
  if (input.fixtures.length < 1 || input.fixtures.length > 30) {
    throw new Error("fixtures must list 1-30 names");
  }
  for (const fixture of input.fixtures) {
    if (!/^[a-z0-9-]+$/.test(fixture)) throw new Error(`invalid fixture name: ${fixture}`);
  }
  const timeoutMs = input.timeoutMs ?? 40000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("timeoutMs must be an integer between 1000 and 120000");
  }

  const results: Array<{ fixture: string; settled: boolean; outcome: string[] }> = [];
  for (const fixture of input.fixtures) {
    // A new session clears the screen, so each fixture's completion is the first one shown.
    for (const keys of [["-l", "/new"], ["Enter"]]) {
      await execFile("tmux", ["-S", input.socket, "send-keys", "-t", input.target, ...keys], {
        raise: true,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const run = await runCase({
      socket: input.socket,
      target: input.target,
      fixture,
      timeoutMs,
      history: 0,
      tail: 45,
    });
    const rows = run.tail.map((row) => row.trim());
    // The entry runs from the submitted prompt to the fixture's completion notice.
    const start = rows.lastIndexOf(fixture);
    const end = rows.indexOf("Fixture completed.", start + 1);
    const entry = rows.slice(start + 1, end < 0 ? undefined : end);
    results.push({
      fixture,
      settled: run.settled,
      outcome: entry
        .filter(
          (row) =>
            /^[✓⚠✗]/.test(row) ||
            /^(Command failed|TypeScript|Error:|Diagnostic|TAIL_SENTINEL|… \d+)/.test(row),
        )
        .slice(0, 4),
    });
  }
  return { results };
}
