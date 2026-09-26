/**
 * Reports the SGR style codes on the last row containing a needle in an isolated Pi from
 * ux.manageSession, for comparing themes and emphasis.
 *
 * @param input.needle - Plain text to find (1-200 characters). The last matching row wins.
 */
async function inspectRowStyle(
  { shell: { execFile } },
  input: { socket: string; target: string; needle: string },
) {
  if (!/^\/tmp\/pit-ux-[A-Za-z0-9]+\/tmux\.sock$/.test(input.socket)) {
    throw new Error("socket must come from ux.manageSession (/tmp/pit-ux-*/tmux.sock)");
  }
  if (!/^[A-Za-z0-9_-]+:\d+\.\d+$/.test(input.target)) {
    throw new Error("target must be session:window.pane");
  }
  if (input.needle.length < 1 || input.needle.length > 200) {
    throw new Error("needle must be 1-200 characters");
  }
  const capture = async (styled: boolean) =>
    (
      await execFile(
        "tmux",
        [
          "-S",
          input.socket,
          "capture-pane",
          "-p",
          ...(styled ? ["-e"] : []),
          "-S",
          "-",
          "-t",
          input.target,
        ],
        { maxBytes: 51200, truncate: "tail", raise: true },
      )
    ).stdout.split("\n");
  const plain = await capture(false);
  const styled = await capture(true);
  // Escape codes make the styled capture longer, so tail truncation can drop more of its leading
  // rows; align the two captures from the end.
  const offset = styled.length - plain.length;
  const sgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  for (let index = plain.length - 1; index >= 0; index--) {
    const text = plain[index] ?? "";
    if (!text.includes(input.needle)) continue;
    const row = styled[index + offset] ?? "";
    return {
      found: true,
      row: text.trim().slice(0, 120),
      sgr: [...new Set(row.match(sgr) ?? [])].map((code) => code.slice(1)),
    };
  }
  return { found: false, row: "", sgr: [] as string[] };
}
