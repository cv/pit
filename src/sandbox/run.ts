import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { CapabilityTrace, FunctionExecutionContext } from "../execution/capability-trace.js";
import { CapabilityDispatcher, type CapabilityHandler } from "./dispatcher.js";
import type { FunctionExecutionOptions, FunctionExecutor } from "./executor.js";
import { SandboxLifecycle } from "./lifecycle.js";
import { prepareSandboxProgram, type PreparedSandboxProgram } from "./program.js";
import {
  isCapabilityCallMessage,
  type SandboxWireError,
  WireFrameDecoder,
  type WireMessage,
} from "./wire.js";

export interface SandboxOptions {
  memoryLimitMb?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  userFunctions?: ReadonlyMap<string, string>;
  projectFunctions?: ReadonlyMap<string, string>;
  sessionFunctions?: ReadonlyMap<string, string>;
  input?: unknown;
  onCapabilityTrace?: (trace: CapabilityTrace) => void;
}

export class SandboxRemoteError extends Error {
  declare readonly remoteName: string;
  declare readonly remoteFrames: readonly string[];
  declare readonly remoteTruncated: boolean;

  constructor(error: SandboxWireError) {
    super(error.message);
    this.name = "SandboxRemoteError";
    Object.defineProperties(this, {
      remoteName: { value: error.name ?? "Error", enumerable: false },
      remoteFrames: { value: Object.freeze([...(error.frames ?? [])]), enumerable: false },
      remoteTruncated: { value: error.truncated === true, enumerable: false },
    });
  }
}

export function sandboxFatalError(value: unknown): Error {
  if (typeof value === "string") return new Error(value);
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return new Error("TypeScript sandbox failed");
  }
  const error = value as Record<string, unknown>;
  if (typeof error.message !== "string") return new Error("TypeScript sandbox failed");
  return new SandboxRemoteError({
    message: error.message,
    ...(typeof error.name === "string" ? { name: error.name } : {}),
    ...(Array.isArray(error.frames)
      ? {
          frames: error.frames
            .filter((frame): frame is string => typeof frame === "string")
            .slice(0, 20),
        }
      : {}),
    ...(error.truncated === true ? { truncated: true } : {}),
  });
}

export function parseFunctionExecutionContext(
  value: unknown,
): FunctionExecutionContext | undefined {
  if (!(value && typeof value === "object" && !Array.isArray(value))) return;
  const context = value as Record<string, unknown>;
  if (
    !(
      Number.isSafeInteger(context.invocationId) &&
      Number(context.invocationId) > 0 &&
      typeof context.name === "string" &&
      context.name.length > 0
    ) ||
    (context.scope !== "global" && context.scope !== "project" && context.scope !== "session") ||
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

const RUNNER = fileURLToPath(new URL("./runner.mjs", import.meta.url));
const MAX_PROTOCOL_FRAME_BYTES = 8_000_000;
const MAX_CONCURRENT_CAPABILITY_CALLS = 32;
const MAX_CAPABILITY_CALLS = 1024;

export const nodeFunctionExecutor: FunctionExecutor = {
  async execute(
    program: PreparedSandboxProgram,
    handler: CapabilityHandler,
    options: FunctionExecutionOptions,
  ): Promise<unknown> {
    const token = randomBytes(24).toString("base64url");
    const child = spawn(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${RUNNER}`,
        `--max-old-space-size=${Math.floor(options.memoryLimitMb)}`,
        RUNNER,
      ],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const allowedCalls = new Set(program.effects);

    return await new Promise<unknown>((resolve, reject) => {
      let stderr = "";
      const lifecycle = new SandboxLifecycle({
        child,
        timeoutMs: options.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
        resolve,
        reject,
      });
      if (lifecycle.settled) return;
      const send = (message: WireMessage): boolean => {
        if (lifecycle.settled || !child.stdin.writable) return false;
        const frame = `${JSON.stringify({ ...message, token })}\n`;
        if (Buffer.byteLength(frame) > MAX_PROTOCOL_FRAME_BYTES) return false;
        child.stdin.write(frame);
        return true;
      };
      const dispatcher = new CapabilityDispatcher({
        handler,
        signal: lifecycle.capabilitySignal,
        maximumCalls: MAX_CAPABILITY_CALLS,
        maximumConcurrentCalls: MAX_CONCURRENT_CAPABILITY_CALLS,
        allowedCalls,
        send,
        parseFunctionContext: parseFunctionExecutionContext,
        ...(options.onCapabilityTrace ? { onTrace: options.onCapabilityTrace } : {}),
      });

      /* v8 ignore next -- an EPIPE race is platform-dependent and handled defensively. */
      child.stdin.on("error", (error) => {
        if (!lifecycle.settled) lifecycle.finish(error);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-8192);
      });
      child.on("error", (error) => lifecycle.finish(error));
      child.on("exit", (code, signal) => {
        if (!lifecycle.settled) {
          const detail = stderr.trim() || `exit ${code ?? signal}`;
          lifecycle.finish(new Error(`TypeScript sandbox stopped: ${detail}`));
        }
      });

      const decoder = new WireFrameDecoder(MAX_PROTOCOL_FRAME_BYTES);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        let messages: WireMessage[];
        try {
          messages = decoder.push(chunk);
        } catch (error) {
          lifecycle.finish(error as Error);
          return;
        }
        for (const message of messages) {
          if (message.token !== token) continue;
          if (message.type === "result") {
            lifecycle.finishAfter(dispatcher.pending(), undefined, message.value);
            return;
          }
          if (message.type === "fatal") {
            lifecycle.finishAfter(dispatcher.pending(), sandboxFatalError(message.error));
            return;
          }
          if (isCapabilityCallMessage(message)) dispatcher.handle(message);
        }
      });

      /* v8 ignore next -- validated source and registry limits keep start frames below the cap. */
      if (!send({ type: "start", value: program.compiled, input: options.input })) {
        lifecycle.finish(new Error(`RPC frame exceeds ${MAX_PROTOCOL_FRAME_BYTES} bytes`));
      }
    });
  },
};

function executionOptions(options: SandboxOptions): FunctionExecutionOptions {
  const memoryLimitMb = options.memoryLimitMb ?? 128;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(memoryLimitMb) || memoryLimitMb < 16) {
    throw new Error("memoryLimitMb must be at least 16");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be positive");
  }
  return {
    memoryLimitMb,
    timeoutMs,
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onCapabilityTrace ? { onCapabilityTrace: options.onCapabilityTrace } : {}),
  };
}

export async function runWithFunctionExecutor(
  source: string,
  handler: CapabilityHandler,
  options: SandboxOptions,
  executor: FunctionExecutor,
): Promise<unknown> {
  const execution = executionOptions(options);
  const program = await prepareSandboxProgram(source, {
    ...(options.userFunctions ? { userFunctions: options.userFunctions } : {}),
    ...(options.projectFunctions ? { projectFunctions: options.projectFunctions } : {}),
    ...(options.sessionFunctions ? { sessionFunctions: options.sessionFunctions } : {}),
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  return executor.execute(program, handler, execution);
}

/** Run TypeScript in the current restricted Node executor. */
export function runInSandbox(
  source: string,
  handler: CapabilityHandler,
  options: SandboxOptions = {},
): Promise<unknown> {
  return runWithFunctionExecutor(source, handler, options, nodeFunctionExecutor);
}
