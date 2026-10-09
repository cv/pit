import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { HostShellProgressEvent } from "../execution/types.js";
import { boundedIntegerValue } from "../shared/argument-values.js";
import { boundText, LIMITS, sliceText, type SliceKeep } from "../shared/bounds.js";
import { terminationError } from "../shared/termination-errors.js";
import { resolveWorkspacePath } from "../workspace/paths.js";
import { executeStreamingProcess } from "./host.js";
import type { ProcessResult } from "./results.js";

export function formatProcessCommand(program: string, args: string[]): string {
  return [program, ...args.map((argument) => JSON.stringify(argument))].join(" ");
}

interface ProcessRequest {
  program: string;
  args: string[];
  options: Record<string, unknown>;
  displayCommand?: string;
  onProgress?: (event: HostShellProgressEvent) => void;
  signal?: AbortSignal;
}

interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

export function createProcessRunner(pi: ExtensionAPI, defaultCwd: string): ProcessRunner {
  return {
    run: (request) =>
      executeHostProcess({
        pi,
        defaultCwd,
        ...request,
      }),
  };
}

type ProcessTermination = "timeout" | "abort";

interface ProcessSettings {
  cwd: string;
  budget: { maxBytes: number; maxLines: number };
  keep: SliceKeep;
  timeout: number;
}

function processSettings(options: Record<string, unknown>, defaultCwd: string): ProcessSettings {
  if (options.raise !== undefined && typeof options.raise !== "boolean") {
    throw new TypeError("options.raise must be a boolean");
  }
  const cwd =
    options.cwd === undefined ? defaultCwd : resolveWorkspacePath(defaultCwd, options.cwd);
  // Captured output is program data: a program can raise the default to parse large output.
  const maxBytes = boundedIntegerValue(options.maxBytes, "options.maxBytes", {
    maximum: LIMITS.programData.maxBytes,
    fallback: LIMITS.processStream.maxBytes,
  });
  const maxLines = boundedIntegerValue(options.maxLines, "options.maxLines", {
    maximum: LIMITS.programData.maxLines,
    fallback: LIMITS.processStream.maxLines,
  });
  const keep = options.truncate ?? "tail";
  if (keep !== "head" && keep !== "tail") {
    throw new Error('options.truncate must be "head" or "tail"');
  }
  return {
    cwd,
    budget: { maxBytes, maxLines },
    keep,
    timeout: Number(options.timeoutMs ?? 120_000),
  };
}

function terminationOf(
  result: { termination?: ProcessTermination } | { killed: boolean },
  signal: AbortSignal | undefined,
): ProcessTermination | undefined {
  if ("termination" in result) return result.termination;
  if (!("killed" in result) || !result.killed) return undefined;
  return signal?.aborted ? "abort" : "timeout";
}

function terminationMessage(termination: ProcessTermination | undefined, timeout: number): string {
  if (termination === "timeout") return `Command timed out after ${timeout}ms`;
  if (termination === "abort") return "Command aborted";
  return "";
}

function processFailure(
  command: string,
  code: number,
  output: string,
  termination: ProcessTermination | undefined,
): Error {
  const detail = boundText(output, LIMITS.processError, "tail").text;
  const message = `Command failed with exit code ${code}: ${command}${detail ? `\n${detail}` : ""}`;
  // The host's synthetic exit codes are not reliable signals: programs may exit 124 or 130 themselves.
  if (termination === "timeout") return terminationError("timeout", message);
  if (termination === "abort") return terminationError("cancelled", message);
  return new Error(message);
}

export async function executeHostProcess({
  pi,
  defaultCwd,
  program,
  args,
  options,
  displayCommand = formatProcessCommand(program, args),
  onProgress,
  signal,
}: ProcessRequest & { pi: ExtensionAPI; defaultCwd: string }): Promise<ProcessResult> {
  const { cwd, budget, keep, timeout } = processSettings(options, defaultCwd);
  const abort = signal ? { signal } : {};
  onProgress?.({ phase: "start" });
  const result = onProgress
    ? await executeStreamingProcess(program, args, {
        cwd,
        timeout,
        ...abort,
        capture: { budget, keep },
        onChunk: (stream, chunk) => onProgress({ phase: "output", stream, chunk }),
      })
    : await pi.exec(program, args, { cwd, ...abort, timeout });
  onProgress?.({ phase: "end", code: result.code });
  const termination = terminationOf(result, signal);
  const stdout = sliceText(result.stdout, budget, keep);
  const stderr = sliceText(result.stderr || terminationMessage(termination, timeout), budget, keep);
  if (options.raise === true && result.code !== 0) {
    const output = stderr.text.trim() || stdout.text.trim();
    throw processFailure(displayCommand, result.code, output, termination);
  }
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    code: result.code,
    truncated:
      stdout.truncated || stderr.truncated || ("truncated" in result && result.truncated === true),
  };
}
