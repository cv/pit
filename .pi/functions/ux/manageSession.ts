/**
 * Starts or stops an isolated Pi on a private tmux server for terminal UX acceptance. Pi runs with
 * a clean environment, temporary home and agent directories, and only this repository's extension
 * and the offline fixture provider.
 *
 * @param input.cwd - Repository directory for Pi and its extensions. The default is the current
 *   working directory.
 * @param input.width - Initial window columns (40-400). The default is 120.
 * @param input.height - Initial window rows (10-200). The default is 50.
 * @param input.extraEnv - Additional variables for the isolated Pi, such as PIT_WASMTIME_ADDON.
 *   Names must be uppercase shell identifiers.
 * @param input.keepShell - Keep the pane's shell running after Pi exits, as a terminal does. Exit
 *   checks need it: when the pane closes, the hang-up kills Pi's descendants whatever Pit did.
 *   The default is false.
 * @param input.root - Run directory returned by start; stop kills its server and removes it.
 */
async function manageSession(
  { context: { get }, shell: { execFile } },
  input:
    | {
        action: "start";
        cwd?: string;
        theme?: "dark" | "light";
        mode?: "regular" | "fullscreen";
        width?: number;
        height?: number;
        extraEnv?: Record<string, string>;
        keepShell?: boolean;
      }
    | { action: "stop"; socket: string; root: string },
) {
  const tmux = (socket: string, args: string[], raise = true) =>
    execFile("tmux", ["-S", socket, ...args], { maxBytes: 20000, raise });

  if (input.action === "stop") {
    // Checked before any tmux call: only this workflow's own servers and directories.
    if (!/^\/tmp\/pit-ux-[A-Za-z0-9]+$/.test(input.root)) {
      throw new Error(`refusing to stop a session outside /tmp/pit-ux-*: ${input.root}`);
    }
    if (input.socket !== `${input.root}/tmux.sock`) {
      throw new Error("socket must be the tmux.sock inside root");
    }
    const stopped = await tmux(input.socket, ["kill-server"], false);
    await execFile("rm", ["-rf", input.root], { raise: true });
    return { action: "stop" as const, root: input.root, stopped: stopped.code === 0 };
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
  const width = integerInput("width", input.width, 120, 40, 400);
  const height = integerInput("height", input.height, 50, 10, 200);
  const extraEnv = Object.entries(input.extraEnv ?? {});
  for (const [name] of extraEnv) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      throw new Error(`invalid environment variable name: ${name}`);
    }
  }
  const cwd = input.cwd ?? (await get()).cwd;
  if (!cwd.startsWith("/")) throw new Error("cwd must be an absolute path");

  const [nodeBin, pi] = (
    await execFile("sh", ["-c", 'dirname "$(command -v node)" && command -v pi'], { raise: true })
  ).stdout
    .trim()
    .split("\n");
  if (!nodeBin || !pi) throw new Error("node and pi must be on PATH");
  const root = (
    await execFile("mktemp", ["-d", "/tmp/pit-ux-XXXXXX"], { raise: true })
  ).stdout.trim();
  const socket = `${root}/tmux.sock`;
  const target = "pitux:0.0";
  await execFile("mkdir", ["-p", `${root}/home`, `${root}/agent`, `${root}/sessions`], {
    raise: true,
  });
  const command = [
    "env",
    "-i",
    `PATH=${nodeBin}:/usr/bin:/bin`,
    `HOME=${root}/home`,
    `PI_CODING_AGENT_DIR=${root}/agent`,
    "TERM=xterm-256color",
    "LANG=C.UTF-8",
    "PI_OFFLINE=1",
    "PI_TELEMETRY=0",
    ...extraEnv.map(([name, value]) => `${name}=${value}`),
    pi,
    "-e",
    `${cwd}/src/index.ts`,
    "-e",
    `${cwd}/.pi/skills/pit-terminal-ux/assets/fixture-provider.ts`,
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-themes",
    "--no-builtin-tools",
    "--offline",
    "--approve",
    "--provider",
    "pit-ux-fixture",
    "--model",
    "fixture",
    "--api-key",
    "fixture-not-a-real-key",
    "--thinking",
    "off",
    "--session-dir",
    `${root}/sessions`,
    "--use-theme",
    input.theme ?? "dark",
    "--tui-mode",
    input.mode ?? "regular",
  ];
  // tmux runs the pane command through a shell, so every argument is single-quoted.
  const quoted = command.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
  const paneCommand = input.keepShell ? `${quoted}; exec sleep 86400` : quoted;
  await tmux(socket, [
    "-f",
    "/dev/null",
    "start-server",
    ";",
    "set-option",
    "-g",
    "history-limit",
    "50000",
    ";",
    // Isolated server only: modified keys for search, and OSC 52 into a test buffer for copy.
    "set-option",
    "-s",
    "extended-keys",
    "always",
    ";",
    "set-option",
    "-s",
    "set-clipboard",
    "on",
    ";",
    "new-session",
    "-d",
    "-s",
    "pitux",
    "-x",
    String(width),
    "-y",
    String(height),
    "-c",
    cwd,
    paneCommand,
  ]);
  let screen = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    screen = (await tmux(socket, ["capture-pane", "-p", "-t", target], false)).stdout;
    // The footer names the selected model once Pi is ready.
    if (/fixture\s*$/m.test(screen)) return { action: "start" as const, root, socket, target };
  }
  await tmux(socket, ["kill-server"], false);
  await execFile("rm", ["-rf", root], { raise: true });
  const shown = screen
    .split("\n")
    .filter((row) => row.trim())
    .slice(-5)
    .join("\n");
  throw new Error(`isolated Pi did not show the fixture model within 20 s:\n${shown}`);
}
