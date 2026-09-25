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

export interface ProcessRequest {
  program: string;
  args: string[];
  options: Record<string, unknown>;
  displayCommand?: string;
  onProgress?: (event: HostShellProgressEvent) => void;
  signal?: AbortSignal;
}

export interface ProcessRunner {
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
  if (options.raise !== undefined && typeof options.raise !== "boolean") {
    throw new TypeError("options.raise must be a boolean");
  }
  const cwd =
    options.cwd === undefined ? defaultCwd : resolveWorkspacePath(defaultCwd, options.cwd);
  const maxBytes = boundedIntegerValue(
    options.maxBytes,
    "options.maxBytes",
    LIMITS.processStream.maxBytes,
    LIMITS.processStream.maxBytes,
  );
  const maxLines = boundedIntegerValue(
    options.maxLines,
    "options.maxLines",
    LIMITS.processStream.maxLines,
    LIMITS.processStream.maxLines,
  );
  const truncate = options.truncate ?? "tail";
  if (truncate !== "head" && truncate !== "tail") {
    throw new Error('options.truncate must be "head" or "tail"');
  }
  const keep: SliceKeep = truncate === "head" ? "head" : "tail";
  const timeout = Number(options.timeoutMs ?? 120_000);
  onProgress?.({ phase: "start" });
  const result = onProgress
    ? await executeStreamingProcess(program, args, {
        cwd,
        timeout,
        ...(signal ? { signal } : {}),
        onChunk: (stream, chunk) => onProgress({ phase: "output", stream, chunk }),
      })
    : await pi.exec(program, args, {
        cwd,
        ...(signal ? { signal } : {}),
        timeout,
      });
  onProgress?.({ phase: "end", code: result.code });
  const processStderr =
    result.stderr ||
    ("termination" in result && result.termination === "timeout"
      ? `Command timed out after ${timeout}ms`
      : "termination" in result && result.termination === "abort"
        ? "Command aborted"
        : "");
  const stdout = sliceText(result.stdout, { maxBytes, maxLines }, keep);
  const stderr = sliceText(processStderr, { maxBytes, maxLines }, keep);
  if (options.raise === true && result.code !== 0) {
    const detail = boundText(
      stderr.text.trim() || stdout.text.trim(),
      LIMITS.processError,
      "tail",
    ).text;
    const message =
      `Command failed with exit code ${result.code}: ${displayCommand}` +
      (detail ? `\n${detail}` : "");
    const termination =
      "termination" in result
        ? result.termination
        : result.killed
          ? signal?.aborted
            ? "abort"
            : "timeout"
          : undefined;
    // The host's synthetic exit codes are not reliable signals: programs may exit 124 or 130 themselves.
    throw termination === "timeout"
      ? terminationError("timeout", message)
      : termination === "abort"
        ? terminationError("cancelled", message)
        : new Error(message);
  }
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    code: result.code,
    truncated: stdout.truncated || stderr.truncated,
  };
}
