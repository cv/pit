import { type ChildProcess, spawn } from "node:child_process";

const EXIT_STDIO_GRACE_MS = 100;
const FORCE_KILL_DELAY_MS = 5000;

export interface StreamingProcessResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface StreamingProcessOptions {
  cwd: string;
  timeout: number;
  signal?: AbortSignal;
  onChunk: (stream: "stdout" | "stderr", chunk: string) => void;
}

function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;
    const cleanup = () => {
      /* v8 ignore next -- only inherited post-exit stdio handles arm this timer. */
      if (postExitTimer) {
        clearTimeout(postExitTimer);
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };
    const finalize = (code: number | null) => {
      /* v8 ignore next -- exit, close, and idle callbacks may race defensively. */
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };
    const maybeFinalizeAfterExit = () => {
      if (exited && stdoutEnded && stderrEnded) {
        finalize(exitCode);
      }
    };
    /* v8 ignore next 12 -- exercised only when a detached descendant inherits stdio. */
    const armIdleTimer = () => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
      }
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };
    /* v8 ignore next 5 -- exercised only by output arriving after child exit. */
    const onData = () => {
      if (exited && !settled) {
        armIdleTimer();
      }
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };
    const onError = (error: Error) => {
      /* v8 ignore next -- duplicate errors after settlement are a child-process race. */
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      /* v8 ignore next -- normal child pipes end before the post-exit grace path. */
      if (!settled) {
        armIdleTimer();
      }
    };
    /* v8 ignore next -- normal pipes finalize on exit plus end before close. */
    const onClose = (code: number | null) => finalize(code);
    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

export async function executeStreamingProcess(
  program: string,
  args: string[],
  options: StreamingProcessOptions,
): Promise<StreamingProcessResult> {
  const child = spawn(program, args, {
    cwd: options.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let killed = false;
  let timeout: NodeJS.Timeout | undefined;
  const killProcess = () => {
    /* v8 ignore next -- abort and timeout may race to kill the same child. */
    if (killed) {
      return;
    }
    killed = true;
    child.kill("SIGTERM");
    /* v8 ignore next 5 -- test children terminate on SIGTERM; this is the escalation fallback. */
    const forceKill = setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, FORCE_KILL_DELAY_MS);
    forceKill.unref?.();
  };
  const onStdout = (data: Buffer) => {
    const chunk = data.toString();
    stdout += chunk;
    options.onChunk("stdout", chunk);
  };
  const onStderr = (data: Buffer) => {
    const chunk = data.toString();
    stderr += chunk;
    options.onChunk("stderr", chunk);
  };
  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);
  if (options.signal) {
    if (options.signal.aborted) {
      killProcess();
    } else {
      options.signal.addEventListener("abort", killProcess, { once: true });
    }
  }
  if (options.timeout > 0) {
    timeout = setTimeout(killProcess, options.timeout);
  }
  try {
    const code = await waitForChildProcess(child);
    return { stdout, stderr, code: code ?? 0, killed };
  } catch {
    return { stdout, stderr, code: 1, killed };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    options.signal?.removeEventListener("abort", killProcess);
    child.stdout?.removeListener("data", onStdout);
    child.stderr?.removeListener("data", onStderr);
  }
}
