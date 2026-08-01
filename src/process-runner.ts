import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { boundedIntegerValue, type ProcessResult } from "./cli.js";
import type { HostShellProgressEvent } from "./execution-types.js";
import { executeStreamingProcess } from "./host-process.js";
import { resolveWorkspacePath } from "./workspace-paths.js";

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
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_BYTES,
  );
  const maxLines = boundedIntegerValue(
    options.maxLines,
    "options.maxLines",
    DEFAULT_MAX_LINES,
    DEFAULT_MAX_LINES,
  );
  const truncate = options.truncate ?? "tail";
  if (truncate !== "head" && truncate !== "tail") {
    throw new Error('options.truncate must be "head" or "tail"');
  }
  const truncateOutput = truncate === "head" ? truncateHead : truncateTail;
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
  const stdout = truncateOutput(result.stdout, { maxBytes, maxLines });
  const stderr = truncateOutput(result.stderr, { maxBytes, maxLines });
  if (options.raise === true && result.code !== 0) {
    const detail = (stderr.content.trim() || stdout.content.trim()).slice(-4000);
    throw new Error(
      `Command failed with exit code ${result.code}: ${displayCommand}` +
        (detail ? `\n${detail}` : ""),
    );
  }
  return {
    stdout: stdout.content,
    stderr: stderr.content,
    code: result.code,
    truncated: stdout.truncated || stderr.truncated,
  };
}
