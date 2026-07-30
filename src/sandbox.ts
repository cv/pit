import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

export interface SandboxOptions {
  memoryLimitMb?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type CapabilityHandler = (
  capability: string,
  method: string,
  args: unknown[],
) => unknown | Promise<unknown>;

interface WireMessage {
  token?: string;
  type?: string;
  id?: number;
  capability?: string;
  method?: string;
  args?: unknown[];
  value?: unknown;
  error?: string;
}

const RUNNER = fileURLToPath(new URL("./sandbox-runner.mjs", import.meta.url));

/**
 * Run a TypeScript function expression in a fresh, permission-restricted Node
 * process. The child has no filesystem, network, subprocess, worker, addon, or
 * inherited-environment access. All useful effects go through the provided capabilities.
 */
export async function runInSandbox(
  source: string,
  handler: CapabilityHandler,
  options: SandboxOptions = {},
): Promise<unknown> {
  const memoryLimitMb = options.memoryLimitMb ?? 128;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(memoryLimitMb) || memoryLimitMb < 16) {
    throw new Error("memoryLimitMb must be at least 16");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be positive");
  }

  const compiled = await transform(`(${source})`, {
    loader: "ts",
    target: "es2022",
    sourcemap: "inline",
  });
  const token = randomBytes(24).toString("base64url");
  const child = spawn(
    process.execPath,
    [
      "--permission",
      `--allow-fs-read=${RUNNER}`,
      `--max-old-space-size=${Math.floor(memoryLimitMb)}`,
      RUNNER,
    ],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new Error("TypeScript execution cancelled"));
    const timer = setTimeout(
      () => finish(new Error(`TypeScript execution timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) return onAbort();

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8_192);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (!settled) {
        const detail = stderr.trim() || `exit ${code ?? signal}`;
        finish(new Error(`TypeScript sandbox stopped: ${detail}`));
      }
    });

    const send = (message: WireMessage) => {
      if (!settled && child.stdin.writable) {
        child.stdin.write(`${JSON.stringify({ ...message, token })}\n`);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      while (true) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        let message: WireMessage;
        try {
          message = JSON.parse(line) as WireMessage;
        } catch {
          continue; // Ignore untrusted writes to stdout.
        }
        if (message.token !== token) continue;
        if (message.type === "result") return finish(undefined, message.value);
        if (message.type === "fatal") return finish(new Error(message.error));
        if (
          message.type === "call" &&
          typeof message.id === "number" &&
          typeof message.capability === "string" &&
          typeof message.method === "string" &&
          Array.isArray(message.args)
        ) {
          const id = message.id;
          void Promise.resolve(handler(message.capability, message.method, message.args)).then(
            (value) => send({ type: "response", id, value }),
            (error) => send({
              type: "response",
              id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
    });

    send({ type: "start", value: compiled.code });
  });
}
