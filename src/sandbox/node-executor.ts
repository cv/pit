import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { CapabilityDispatcher, type CapabilityHandler } from "./dispatcher.js";
import {
  parseFunctionExecutionContext,
  type FunctionExecutionOptions,
  type FunctionExecutor,
} from "./executor.js";
import { SandboxLifecycle } from "./lifecycle.js";
import type { PreparedSandboxProgram } from "./program.js";
import {
  isCapabilityCallMessage,
  type SandboxWireError,
  WireFrameDecoder,
  type WireMessage,
} from "./wire.js";

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

const RUNNER = fileURLToPath(new URL("./runner.mjs", import.meta.url));
const MAX_PROTOCOL_FRAME_BYTES = 8_000_000;
const MAX_CONCURRENT_CAPABILITY_CALLS = 32;
const MAX_CAPABILITY_CALLS = 1024;

/** @deprecated Use the default Wasmtime executor. Retained temporarily for diagnostics. */
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
