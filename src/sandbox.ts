import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type CapabilityTrace,
  type FunctionExecutionContext,
  finishCapabilityTrace,
  startCapabilityTrace,
} from "./capability-trace.js";
import { compileSandboxSource } from "./sandbox-program.js";

export type {
  ProjectFunctionMetadata,
  ProjectFunctionParameter,
  SavedFunctionReference,
} from "./sandbox-program.js";
export {
  clearSandboxCaches,
  formatDiagnostic,
  getNamedFunctionName,
  getProjectFunctionMetadata,
  getSandboxCacheStats,
  getSavedFunctionCallSignature,
  resolveSavedFunctionReferences,
  validateTypeScript,
} from "./sandbox-program.js";

export interface SandboxOptions {
  memoryLimitMb?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  savedFunctions?: ReadonlyMap<string, string>;
  savedFunctionScopes?: ReadonlyMap<string, "project" | "session">;
  input?: unknown;
  onCapabilityTrace?: (trace: CapabilityTrace) => void;
}

export interface CapabilityRequest {
  capability: string;
  method: string;
  args: unknown[];
  signal: AbortSignal;
  functionContext?: FunctionExecutionContext;
}

export type CapabilityHandler = (request: CapabilityRequest) => unknown | Promise<unknown>;

interface WireMessage {
  token?: string;
  type?: string;
  id?: number;
  capability?: string;
  method?: string;
  args?: unknown[];
  functionContext?: FunctionExecutionContext;
  value?: unknown;
  error?: string;
  input?: unknown;
}

type CapabilityCallMessage = WireMessage &
  Required<Pick<WireMessage, "id" | "capability" | "method" | "args">>;

function isCapabilityCallMessage(message: WireMessage): message is CapabilityCallMessage {
  return (
    message.type === "call" &&
    typeof message.id === "number" &&
    typeof message.capability === "string" &&
    typeof message.method === "string" &&
    Array.isArray(message.args)
  );
}

export function parseFunctionExecutionContext(
  value: unknown,
): FunctionExecutionContext | undefined {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return;
  }
  const context = value as Record<string, unknown>;
  if (
    !(
      Number.isSafeInteger(context.invocationId) &&
      Number(context.invocationId) > 0 &&
      typeof context.name === "string" &&
      context.name.length > 0
    ) ||
    (context.scope !== "project" && context.scope !== "session") ||
    !(
      Number.isSafeInteger(context.depth) &&
      Number(context.depth) >= 1 &&
      Number(context.depth) <= 32
    ) ||
    !(
      context.parentInvocationId === undefined ||
      (Number.isSafeInteger(context.parentInvocationId) && Number(context.parentInvocationId) > 0)
    )
  ) {
    return;
  }
  return context as unknown as FunctionExecutionContext;
}

const RUNNER = fileURLToPath(new URL("./sandbox-runner.mjs", import.meta.url));
const MAX_PROTOCOL_FRAME_BYTES = 8_000_000;
const MAX_CONCURRENT_CAPABILITY_CALLS = 32;
const MAX_CAPABILITY_CALLS = 1024;

async function prepareSandboxRun(source: string, options: SandboxOptions) {
  const memoryLimitMb = options.memoryLimitMb ?? 128;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(memoryLimitMb) || memoryLimitMb < 16) {
    throw new Error("memoryLimitMb must be at least 16");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be positive");
  }
  const compiled = await compileSandboxSource(source, {
    ...(options.savedFunctions ? { savedFunctions: options.savedFunctions } : {}),
    ...(options.savedFunctionScopes ? { savedFunctionScopes: options.savedFunctionScopes } : {}),
    ...(options.input === undefined ? {} : { input: options.input }),
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
  return { timeoutMs, compiled, token, child };
}

/**
 * Run a TypeScript expression in a fresh, permission-restricted Node
 * process. The child has no filesystem, network, subprocess, worker, addon, or
 * inherited-environment access. All useful effects go through the provided capabilities.
 */
export async function runInSandbox(
  source: string,
  handler: CapabilityHandler,
  options: SandboxOptions = {},
): Promise<unknown> {
  const { timeoutMs, compiled, token, child } = await prepareSandboxRun(source, options);

  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let callCount = 0;
    let activeCalls = 0;
    let stdout = "";
    let stderr = "";
    const inFlight = new Set<Promise<void>>();
    const capabilityController = new AbortController();
    const capabilitySignal = options.signal
      ? AbortSignal.any([options.signal, capabilityController.signal])
      : capabilityController.signal;
    const reportCapabilityTrace = (trace: CapabilityTrace) => {
      try {
        options.onCapabilityTrace?.(trace);
      } catch {
        // Tracing is observational and must not affect capability execution.
      }
    };
    const finish = (error?: Error, value?: unknown) => {
      /* v8 ignore next -- only asynchronous child-process races call finish twice. */
      if (settled) {
        return;
      }
      settled = true;
      capabilityController.abort();
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const finishAfterCalls = (error: Error | undefined, value?: unknown) => {
      void Promise.allSettled([...inFlight]).then(() => finish(error, value));
    };
    const onAbort = () => finish(new Error("TypeScript execution cancelled"));
    const timer = setTimeout(
      () => finish(new Error(`TypeScript execution timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      return onAbort();
    }

    /* v8 ignore next -- an EPIPE race is platform-dependent and handled defensively. */
    child.stdin.on("error", (error) => {
      if (!settled) {
        finish(error);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (!settled) {
        const detail = stderr.trim() || `exit ${code ?? signal}`;
        finish(new Error(`TypeScript sandbox stopped: ${detail}`));
      }
    });

    const send = (message: WireMessage): boolean => {
      if (settled || !child.stdin.writable) {
        return false;
      }
      const frame = `${JSON.stringify({ ...message, token })}\n`;
      if (Buffer.byteLength(frame) > MAX_PROTOCOL_FRAME_BYTES) {
        return false;
      }
      child.stdin.write(frame);
      return true;
    };

    const handleCapabilityCall = (message: CapabilityCallMessage): void => {
      const { id, capability, method, args } = message;
      callCount++;
      const functionContext = parseFunctionExecutionContext(message.functionContext);
      const trace = startCapabilityTrace({
        id,
        sequence: callCount,
        capability,
        method,
        args,
        startedAt: Date.now(),
        ...(functionContext ? { functionContext } : {}),
      });
      reportCapabilityTrace(trace);
      const finishTrace = (status: "succeeded" | "failed" | "rejected") => {
        reportCapabilityTrace(finishCapabilityTrace(trace, status));
      };
      if (callCount > MAX_CAPABILITY_CALLS) {
        send({ type: "response", id, error: `RPC call limit exceeded (${MAX_CAPABILITY_CALLS})` });
        finishTrace("rejected");
        return;
      }
      if (activeCalls >= MAX_CONCURRENT_CAPABILITY_CALLS) {
        send({
          type: "response",
          id,
          error: `Concurrent RPC call limit exceeded (${MAX_CONCURRENT_CAPABILITY_CALLS})`,
        });
        finishTrace("rejected");
        return;
      }
      activeCalls++;
      let task: Promise<void>;
      task = Promise.resolve()
        .then(() =>
          handler({
            capability,
            method,
            args,
            signal: capabilitySignal,
            ...(trace.function ? { functionContext: trace.function } : {}),
          }),
        )
        .then(
          (value) => {
            if (send({ type: "response", id, value })) {
              finishTrace("succeeded");
            } else {
              send({ type: "response", id, error: "Capability response exceeds RPC limit" });
              finishTrace("failed");
            }
          },
          (error) => {
            send({
              type: "response",
              id,
              error: error instanceof Error ? error.message : String(error),
            });
            finishTrace("failed");
          },
        )
        .finally(() => {
          activeCalls--;
          inFlight.delete(task);
        });
      inFlight.add(task);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_PROTOCOL_FRAME_BYTES) {
          return finish(new Error(`RPC frame exceeds ${MAX_PROTOCOL_FRAME_BYTES} bytes`));
        }
        let message: WireMessage;
        try {
          message = JSON.parse(line) as WireMessage;
        } catch {
          continue; // Ignore untrusted writes to stdout.
        }
        if (message.token !== token) {
          continue;
        }
        if (message.type === "result") {
          return finishAfterCalls(undefined, message.value);
        }
        if (message.type === "fatal") {
          return finishAfterCalls(new Error(message.error));
        }
        if (isCapabilityCallMessage(message)) {
          handleCapabilityCall(message);
        }
      }
      /* v8 ignore next -- oversized newline-terminated frames are rejected above. */
      if (Buffer.byteLength(stdout) > MAX_PROTOCOL_FRAME_BYTES) {
        finish(new Error(`RPC frame exceeds ${MAX_PROTOCOL_FRAME_BYTES} bytes`));
      }
    });

    /* v8 ignore next -- validated source and registry limits keep start frames below the cap. */
    if (!send({ type: "start", value: compiled, input: options.input })) {
      finish(new Error(`RPC frame exceeds ${MAX_PROTOCOL_FRAME_BYTES} bytes`));
    }
  });
}
