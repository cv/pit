import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadWorkflowFunction, processResult } from "../helpers/workflow-function.js";

const ROOT = "/tmp/pit-ux-Ab12Cd";
const SOCKET = `${ROOT}/tmux.sock`;
const TARGET = "pitux:0.0";

// The functions poll with setTimeout and Date; the loader binds whichever is installed.
beforeEach(() => {
  vi.useFakeTimers();
  return () => vi.useRealTimers();
});

/** A host whose pane shows `screens` in turn (repeating the last); other commands succeed. */
function host(screens: string[] = [""]) {
  const calls: Array<{ program: string; args: string[] }> = [];
  let shown = 0;
  const execFile = vi.fn(async (program: string, args: string[]) => {
    calls.push({ program, args });
    if (program === "sh") return processResult({ stdout: "/opt/node/bin\n/opt/node/bin/pi\n" });
    if (program === "mktemp") return processResult({ stdout: `${ROOT}\n` });
    if (program === "tmux" && args.includes("capture-pane")) {
      return processResult({ stdout: screens[Math.min(shown++, screens.length - 1)] ?? "" });
    }
    return processResult();
  });
  return { execFile, calls };
}

describe("managePitUxSession", () => {
  it("starts Pi on a private server with a clean environment and only the repository extensions", async () => {
    const manage = await loadWorkflowFunction("managePitUxSession");
    const { execFile, calls } = host(["Loading", "0.0%/128k (auto)                  fixture\n"]);
    const started = manage(
      { context: { get: vi.fn() }, shell: { execFile } },
      { action: "start", cwd: "/repo", extraEnv: { PIT_WASMTIME_ADDON: "/build/addon.node" } },
    );
    await vi.runAllTimersAsync();

    expect(await started).toEqual({ action: "start", root: ROOT, socket: SOCKET, target: TARGET });
    const launch = calls.find((call) => call.args.includes("new-session"));
    expect(launch?.args.slice(0, 4)).toEqual(["-S", SOCKET, "-f", "/dev/null"]);
    const command = launch?.args.at(-1) ?? "";
    for (const argument of [
      "env",
      "-i",
      `HOME=${ROOT}/home`,
      `PI_CODING_AGENT_DIR=${ROOT}/agent`,
      "PIT_WASMTIME_ADDON=/build/addon.node",
      "/opt/node/bin/pi",
      "/repo/src/index.ts",
      "/repo/.pi/skills/pit-terminal-ux/assets/fixture-provider.ts",
      "--no-extensions",
      "--offline",
    ]) {
      expect(command).toContain(`'${argument}'`);
    }
  });

  it("stops its server and removes the run when Pi never shows the fixture model", async () => {
    const manage = await loadWorkflowFunction("managePitUxSession");
    const { execFile, calls } = host(["Loading"]);
    const started = manage(
      { context: { get: async () => ({ cwd: "/repo" }) }, shell: { execFile } },
      { action: "start" },
    );
    const failure = started.catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await failure).toMatchObject({
      message: expect.stringContaining("did not show the fixture model"),
    });

    expect(calls.slice(-2)).toEqual([
      { program: "tmux", args: ["-S", SOCKET, "kill-server"] },
      { program: "rm", args: ["-rf", ROOT] },
    ]);
  });

  it("keeps the pane's shell running after Pi only when asked", async () => {
    const manage = await loadWorkflowFunction("managePitUxSession");
    const paneCommand = async (keepShell: boolean) => {
      const { execFile, calls } = host(["fixture\n"]);
      const started = manage(
        { context: { get: vi.fn() }, shell: { execFile } },
        { action: "start", cwd: "/repo", keepShell },
      );
      await vi.runAllTimersAsync();
      await started;
      return calls.find((call) => call.args.includes("new-session"))?.args.at(-1) ?? "";
    };
    expect(await paneCommand(true)).toMatch(/'regular'; exec sleep 86400$/);
    expect(await paneCommand(false)).toMatch(/'regular'$/);
  });

  it("stops only its own server, then removes the run directory", async () => {
    const manage = await loadWorkflowFunction("managePitUxSession");
    const { execFile, calls } = host();
    expect(
      await manage(
        { context: { get: vi.fn() }, shell: { execFile } },
        { action: "stop", socket: SOCKET, root: ROOT },
      ),
    ).toEqual({ action: "stop", root: ROOT, stopped: true });
    expect(calls).toEqual([
      { program: "tmux", args: ["-S", SOCKET, "kill-server"] },
      { program: "rm", args: ["-rf", ROOT] },
    ]);
  });

  it.each<{ name: string; input: Record<string, unknown>; error: string }>([
    {
      name: "a root outside /tmp/pit-ux-*",
      input: { action: "stop", socket: "/tmp/other/tmux.sock", root: "/tmp/other" },
      error: "refusing to stop",
    },
    {
      name: "a root that escapes /tmp/pit-ux-*",
      input: { action: "stop", socket: "/tmp/pit-ux-a/../x/tmux.sock", root: "/tmp/pit-ux-a/../x" },
      error: "refusing to stop",
    },
    {
      name: "a socket outside its root",
      input: { action: "stop", socket: "/tmp/pit-ux-Zz99Yy/tmux.sock", root: ROOT },
      error: "socket must be the tmux.sock inside root",
    },
    {
      name: "an out-of-range width",
      input: { action: "start", cwd: "/repo", width: 20 },
      error: "width must be an integer between 40 and 400",
    },
    {
      name: "an environment name that is not a shell identifier",
      input: { action: "start", cwd: "/repo", extraEnv: { "PATH; rm": "x" } },
      error: "invalid environment variable name",
    },
    {
      name: "a relative working directory",
      input: { action: "start", cwd: "repo" },
      error: "cwd must be an absolute path",
    },
  ])("rejects $name before any host call", async ({ input, error }) => {
    const manage = await loadWorkflowFunction("managePitUxSession");
    const { execFile } = host();
    await expect(manage({ context: { get: vi.fn() }, shell: { execFile } }, input)).rejects.toThrow(
      error,
    );
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("runPitUxCase", () => {
  it("waits for a new completion when an earlier one is still on screen", async () => {
    const runCase = await loadWorkflowFunction("runPitUxCase");
    const earlier = "earlier case\nFixture completed.\n";
    const finished = `${earlier}trace-a\n ✓ Returned number: 42 (13ms)\nFixture completed.\n\n`;
    // The fixture's result appears 1.5 s after submission; until then only the earlier one shows.
    const submitted = Date.now();
    const calls: string[][] = [];
    const execFile = vi.fn(async (_program: string, args: string[]) => {
      calls.push(args);
      const done = Date.now() - submitted >= 1500;
      return processResult({ stdout: args.includes("capture-pane") && done ? finished : earlier });
    });
    const run = runCase(
      { shell: { execFile } },
      { socket: SOCKET, target: TARGET, fixture: "trace-a", match: "Returned" },
    );
    await vi.runAllTimersAsync();

    expect(await run).toEqual({
      settled: true,
      rows: 5,
      matched: ["3:  ✓ Returned number: 42 (13ms)"],
      tail: [
        "earlier case",
        "Fixture completed.",
        "trace-a",
        " ✓ Returned number: 42 (13ms)",
        "Fixture completed.",
      ],
    });
    expect(calls.filter((args) => args.includes("send-keys")).map((args) => args.slice(5))).toEqual(
      [["-l", "trace-a"], ["Enter"]],
    );
  });

  it("captures after a fixed delay without waiting for a completion", async () => {
    const runCase = await loadWorkflowFunction("runPitUxCase");
    const started = Date.now();
    const execFile = vi.fn(async (_program: string, args: string[]) =>
      processResult({
        stdout:
          args.includes("capture-pane") && Date.now() - started >= 1000 ? "TICK 2\n" : "TICK 1\n",
      }),
    );
    const run = runCase(
      { shell: { execFile } },
      { socket: SOCKET, target: TARGET, fixture: "cancel", delayMs: 1500 },
    );
    await vi.runAllTimersAsync();
    expect(await run).toEqual({ settled: false, rows: 1, matched: [], tail: ["TICK 2"] });
    // It captured at the delay, not after the default 20 s wait.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reports an unsettled capture when the deadline passes", async () => {
    const runCase = await loadWorkflowFunction("runPitUxCase");
    const { execFile } = host(["working\n"]);
    const run = runCase(
      { shell: { execFile } },
      { socket: SOCKET, target: TARGET, fixture: "cancel", timeoutMs: 2000 },
    );
    await vi.runAllTimersAsync();
    expect(await run).toEqual({ settled: false, rows: 1, matched: [], tail: ["working"] });
  });
});

describe("runPitUxFixtures", () => {
  it("runs each fixture in a new session and reports only its own entry's outcome", async () => {
    const runFixtures = await loadWorkflowFunction("runPitUxFixtures");
    const order: string[] = [];
    const execFile = vi.fn(async (_program: string, args: string[]) => {
      order.push(`send ${args.slice(5).join(" ")}`);
      return processResult();
    });
    const tails: Record<string, string[]> = {
      "trace-a": [
        "trace-a",
        "✗ Failed (1ms)",
        "Fixture completed.",
        "trace-a",
        "✓ Returned number: 42 (13ms)",
        "Fixture completed.",
      ],
      error: [
        "error",
        "✗ Failed (33ms)",
        "Diagnostic line 1",
        "  routine output",
        "Fixture completed.",
      ],
    };
    const runPitUxCase = vi.fn(async ({ fixture }: { fixture: string }) => {
      order.push(`case ${fixture}`);
      return { settled: true, rows: 0, matched: [], tail: tails[fixture] };
    });
    const run = runFixtures(
      { runPitUxCase, shell: { execFile } },
      { socket: SOCKET, target: TARGET, fixtures: ["trace-a", "error"] },
    );
    await vi.runAllTimersAsync();

    expect(await run).toEqual({
      results: [
        { fixture: "trace-a", settled: true, outcome: ["✓ Returned number: 42 (13ms)"] },
        { fixture: "error", settled: true, outcome: ["✗ Failed (33ms)", "Diagnostic line 1"] },
      ],
    });
    expect(order).toEqual([
      "send -l /new",
      "send Enter",
      "case trace-a",
      "send -l /new",
      "send Enter",
      "case error",
    ]);
  });
});

describe("inspectPitUxRowStyle", () => {
  function styledHost(plain: string, styled: string) {
    return vi.fn(async (_program: string, args: string[]) =>
      processResult({ stdout: args.includes("-e") ? styled : plain }),
    );
  }

  it("reads the matching row's styles when truncation dropped more styled rows", async () => {
    const inspect = await loadWorkflowFunction("inspectPitUxRowStyle");
    // The styled capture is longer in bytes, so its tail kept one row fewer.
    const execFile = styledHost(
      "old row\nx NEEDLE here\ntail row\n",
      "\u001b[31mx NEEDLE here\u001b[0m\n\u001b[1mtail row\u001b[0m\n",
    );
    expect(
      await inspect({ shell: { execFile } }, { socket: SOCKET, target: TARGET, needle: "NEEDLE" }),
    ).toEqual({ found: true, row: "x NEEDLE here", sgr: ["[31m", "[0m"] });
  });

  it("reports a needle that is not on screen", async () => {
    const inspect = await loadWorkflowFunction("inspectPitUxRowStyle");
    const execFile = styledHost("other\n", "other\n");
    expect(
      await inspect({ shell: { execFile } }, { socket: SOCKET, target: TARGET, needle: "NEEDLE" }),
    ).toEqual({ found: false, row: "", sgr: [] });
  });
});

describe("UX acceptance input boundaries", () => {
  const USER_SOCKET = "/tmp/tmux-1000/default";
  it.each<{ name: string; fn: string; input: Record<string, unknown>; error: string }>([
    {
      name: "runPitUxCase on the user's tmux server",
      fn: "runPitUxCase",
      input: { socket: USER_SOCKET, target: TARGET, fixture: "trace-a" },
      error: "socket must come from managePitUxSession",
    },
    {
      name: "runPitUxFixtures on the user's tmux server",
      fn: "runPitUxFixtures",
      input: { socket: USER_SOCKET, target: TARGET, fixtures: ["trace-a"] },
      error: "socket must come from managePitUxSession",
    },
    {
      name: "inspectPitUxRowStyle on the user's tmux server",
      fn: "inspectPitUxRowStyle",
      input: { socket: USER_SOCKET, target: TARGET, needle: "x" },
      error: "socket must come from managePitUxSession",
    },
    {
      name: "runPitUxCase with a multi-line prompt",
      fn: "runPitUxCase",
      input: { socket: SOCKET, target: TARGET, fixture: "trace-a\n/quit" },
      error: "fixture must be one line",
    },
    {
      name: "runPitUxCase with an out-of-range timeout",
      fn: "runPitUxCase",
      input: { socket: SOCKET, target: TARGET, timeoutMs: 500 },
      error: "timeoutMs must be an integer between 1000 and 120000",
    },
    {
      name: "runPitUxCase with both a delay and a completion pattern",
      fn: "runPitUxCase",
      input: { socket: SOCKET, target: TARGET, delayMs: 1000, waitFor: "done" },
      error: "delayMs and waitFor cannot be combined",
    },
    {
      name: "runPitUxCase with an out-of-range delay",
      fn: "runPitUxCase",
      input: { socket: SOCKET, target: TARGET, delayMs: 50 },
      error: "delayMs must be an integer between 100 and 120000",
    },
    {
      name: "runPitUxFixtures with a prompt instead of a fixture name",
      fn: "runPitUxFixtures",
      input: { socket: SOCKET, target: TARGET, fixtures: ["/quit"] },
      error: "invalid fixture name",
    },
  ])("rejects $name before any host call", async ({ fn, input, error }) => {
    const run = await loadWorkflowFunction(fn);
    const execFile = vi.fn();
    const runPitUxCase = vi.fn();
    await expect(run({ runPitUxCase, shell: { execFile } }, input)).rejects.toThrow(error);
    expect(execFile).not.toHaveBeenCalled();
    expect(runPitUxCase).not.toHaveBeenCalled();
  });
});
