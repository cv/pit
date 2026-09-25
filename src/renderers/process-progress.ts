import { retainShellOutputTail } from "../execution/progress.js";
import type { ExecutionProgressSnapshot, ShellProgress } from "../execution/types.js";
import { parseProcessResult, sanitizeProcessText } from "../process/results.js";
import { omissionMarker } from "../shared/bounds.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import type { ResultTheme } from "./types.js";

/** Join only explicit host identities. Coincidentally equal legacy IDs are not a relationship. */
export function linkedProcessProgress(details: ExecutionProgressSnapshot | undefined) {
  const sequences = new Set(
    (details?.traces ?? [])
      .filter((trace) => trace.capability !== "__pit")
      .map((trace) => trace.sequence),
  );
  const linked = new Map<number, ShellProgress[]>();
  const unlinked: ShellProgress[] = [];
  for (const entry of details?.progress ?? []) {
    if (entry.traceSequence === undefined || !sequences.has(entry.traceSequence)) {
      unlinked.push(entry);
    } else {
      const entries = linked.get(entry.traceSequence) ?? [];
      entries.push(entry);
      linked.set(entry.traceSequence, entries);
    }
  }
  return { linked, unlinked };
}

/** Display lines for a retained tail, led by a counted marker when earlier output was dropped. */
export function retainedOutputLines(
  entry: ShellProgress,
  theme: Pick<ResultTheme, "fg">,
  style: (line: string) => string = (line) => line,
): string[] {
  const lines = entry.output ? entry.output.replace(/\n$/, "").split("\n").map(style) : [];
  if (!entry.omitted) return lines;
  const marker = entry.omitted.partialLine
    ? omissionMarker(entry.omitted.bytes, "bytes")
    : omissionMarker(entry.omitted.lines, "lines");
  return [theme.fg("dim", marker), ...lines];
}

interface ReturnedOutput {
  tail: string;
  code?: number;
}

/** Applies the live retention rule to styled text, then drops styling for comparison. */
function unstyledTail(text: string): string {
  return sanitizeTerminalText(retainShellOutputTail(text));
}

/** Returned texts that could be a shell call's whole output, reduced by the live retention rule. */
function returnedOutputs(value: unknown): ReturnedOutput[] {
  const pending = [value];
  const seen = new WeakSet<object>();
  const outputs: ReturnedOutput[] = [];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (typeof entry === "string") {
      if (entry) outputs.push({ tail: unstyledTail(sanitizeProcessText(entry)) });
      continue;
    }
    if (!entry || typeof entry !== "object" || seen.has(entry)) continue;
    seen.add(entry);
    const result = parseProcessResult(entry);
    if (result) {
      // Captured chunks interleave streams; stdout-then-stderr matches only when they did not.
      outputs.push({ tail: unstyledTail(result.stdout + result.stderr), code: result.code });
    } else {
      pending.push(...Object.values(entry));
    }
  }
  return outputs;
}

/** A completed call is shown above only when a returned text yields exactly its retained tail. */
function returnedWhole(entry: ShellProgress, outputs: ReturnedOutput[]): boolean {
  if (entry.status !== "done") return false;
  const retained = sanitizeTerminalText(entry.output);
  return outputs.some(
    ({ tail, code }) => (code === undefined || code === entry.code) && tail === retained,
  );
}

export function processProgressRenderer(theme: Pick<ResultTheme, "fg">, returnedValue?: unknown) {
  let outputs: ReturnedOutput[] | undefined;
  return (
    entry: ShellProgress,
    options: { settled: boolean; indent?: string; compact?: boolean },
  ): string => {
    const indent = options.indent ?? "";
    const status =
      entry.status === "done"
        ? `exit ${entry.code ?? "unknown"}`
        : options.settled
          ? "unfinished when invocation ended"
          : "running";
    let text = `\n${indent}${theme.fg("toolTitle", `[${status}] ${entry.command}`)}`;
    if (entry.output) {
      outputs ??= returnedOutputs(returnedValue);
      text += returnedWhole(entry, outputs)
        ? `${options.compact ? " · " : `\n${indent}`}${theme.fg("dim", "(output shown above)")}`
        : `\n${retainedOutputLines(entry, theme)
            .map((line) => indent + line)
            .join("\n")}`;
    }
    return text;
  };
}
