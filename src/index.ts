import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  highlightCode,
  truncateHead,
  truncateTail,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import fg from "fast-glob";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runInSandbox, validateTypeScript, type CapabilityHandler } from "./sandbox.js";

const MAX_HTTP_BYTES = 1_000_000;
const MAX_SAVED_FUNCTION_BYTES = 100_000;
const SAVED_FUNCTION_NAME = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;
type FunctionRegistry = Map<string, string>;
const COLLAPSED_CODE_LINES = 12;
const COLLAPSED_RESULT_LINES = 12;

interface TypeScriptDetails {
  value: unknown;
  truncated: boolean;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function savedFunctionName(value: unknown): string {
  const name = string(value, "function name");
  if (!SAVED_FUNCTION_NAME.test(name)) {
    throw new Error("function name must start with a letter, _, or $, contain only letters, numbers, _, $, or -, and be at most 64 characters");
  }
  return name;
}

function workspacePath(cwd: string, value: unknown): string {
  return resolve(cwd, string(value, "path").replace(/^@/, ""));
}

async function readText(cwd: string, args: unknown[]) {
  const path = workspacePath(cwd, args[0]);
  const options = args[1] === undefined ? {} : object(args[1], "options");
  const offset = Number(options.offset ?? 1);
  const limit = Number(options.limit ?? DEFAULT_MAX_LINES);
  if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1) {
    throw new Error("offset and limit must be positive integers");
  }
  const contents = await readFile(path, "utf8");
  const selected = contents.split("\n").slice(offset - 1, offset - 1 + limit).join("\n");
  const result = truncateHead(selected, { maxBytes: DEFAULT_MAX_BYTES, maxLines: limit });
  return {
    text: result.content,
    truncated: result.truncated,
    offset,
    lines: result.outputLines,
    totalLines: contents.split("\n").length,
  };
}

async function editText(cwd: string, args: unknown[]) {
  const path = workspacePath(cwd, args[0]);
  const rawEdits = args[1];
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) throw new Error("edits must be a non-empty array");
  return withFileMutationQueue(path, async () => {
    const current = await readFile(path, "utf8");
    const replacements = rawEdits.map((raw: unknown, index: number) => {
      const edit = object(raw, `edits[${index}]`);
      const oldText = string(edit.oldText, `edits[${index}].oldText`);
      const newText = string(edit.newText, `edits[${index}].newText`);
      if (!oldText) throw new Error(`edits[${index}].oldText may not be empty`);
      const start = current.indexOf(oldText);
      if (start < 0) throw new Error(`edits[${index}].oldText was not found`);
      if (current.indexOf(oldText, start + 1) >= 0) throw new Error(`edits[${index}].oldText is not unique`);
      return { start, end: start + oldText.length, newText, index };
    });
    const ordered = [...replacements].sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i]!.start < ordered[i - 1]!.end) throw new Error("edits overlap");
    }
    let next = current;
    for (const replacement of ordered.reverse()) {
      next = next.slice(0, replacement.start) + replacement.newText + next.slice(replacement.end);
    }
    await writeFile(path, next, "utf8");
    return { path, edits: replacements.length };
  });
}

export function handleFunctions(
  functions: FunctionRegistry,
  method: string,
  args: unknown[],
): unknown {
  switch (method) {
    case "set": {
      const name = savedFunctionName(args[0]);
      const source = string(args[1], "function source");
      if (Buffer.byteLength(source) > MAX_SAVED_FUNCTION_BYTES) {
        throw new Error(`saved function source exceeds ${formatSize(MAX_SAVED_FUNCTION_BYTES)}`);
      }
      validateTypeScript(source);
      const replaced = functions.has(name);
      functions.set(name, source);
      return { name, replaced };
    }
    case "get": {
      const name = savedFunctionName(args[0]);
      const source = functions.get(name);
      if (source === undefined) {
        const available = [...functions.keys()].sort();
        throw new Error(
          `Saved function "${name}" was not found.` +
          (available.length ? ` Available functions: ${available.join(", ")}` : " No functions are saved."),
        );
      }
      return source;
    }
    case "has": return functions.has(savedFunctionName(args[0]));
    case "list": return [...functions.keys()].sort();
    case "delete": return functions.delete(savedFunctionName(args[0]));
    default: throw new Error(`Unknown functions method: ${method}`);
  }
}

function createCapabilities(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  functions: FunctionRegistry,
  signal?: AbortSignal,
): CapabilityHandler {
  return async (capability, method, args) => {
    if (capability === "workspace") {
      switch (method) {
        case "readText": return readText(ctx.cwd, args);
        case "writeText": {
          const path = workspacePath(ctx.cwd, args[0]);
          const contents = string(args[1], "contents");
          return withFileMutationQueue(path, async () => {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, contents, "utf8");
            return { path, bytes: Buffer.byteLength(contents) };
          });
        }
        case "editText": return editText(ctx.cwd, args);
        case "list": {
          const path = args[0] === undefined ? ctx.cwd : workspacePath(ctx.cwd, args[0]);
          const entries = await readdir(path, { withFileTypes: true });
          return entries.slice(0, 2_000).map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
          }));
        }
        case "glob": {
          const patterns = typeof args[0] === "string" || Array.isArray(args[0]) ? args[0] as string | string[] : "**/*";
          const options = args[1] === undefined ? {} : object(args[1], "options");
          return (await fg(patterns, {
            cwd: ctx.cwd,
            dot: Boolean(options.dot),
            onlyFiles: options.onlyFiles === undefined ? false : Boolean(options.onlyFiles),
            ignore: Array.isArray(options.ignore) ? options.ignore.map(String) : [],
            followSymbolicLinks: false,
          })).slice(0, 10_000);
        }
        case "stat": {
          const info = await stat(workspacePath(ctx.cwd, args[0]));
          return { size: info.size, modified: info.mtime.toISOString(), directory: info.isDirectory(), file: info.isFile() };
        }
        default: throw new Error(`Unknown workspace method: ${method}`);
      }
    }

    if (capability === "shell" && method === "exec") {
      const command = string(args[0], "command");
      const options = args[1] === undefined ? {} : object(args[1], "options");
      const cwd = options.cwd === undefined ? ctx.cwd : workspacePath(ctx.cwd, options.cwd);
      const result = await pi.exec("/bin/sh", ["-lc", command], {
        cwd,
        ...(signal ? { signal } : {}),
        timeout: Number(options.timeoutMs ?? 120_000),
      });
      const stdout = truncateTail(result.stdout, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
      const stderr = truncateTail(result.stderr, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
      return { stdout: stdout.content, stderr: stderr.content, code: result.code, truncated: stdout.truncated || stderr.truncated };
    }

    if (capability === "http" && method === "request") {
      const url = string(args[0], "url");
      const options = args[1] === undefined ? {} : object(args[1], "options");
      const response = await fetch(url, {
        ...(options.method === undefined ? {} : { method: string(options.method, "method") }),
        ...(options.headers === undefined ? {} : { headers: options.headers as Record<string, string> }),
        ...(options.body === undefined ? {} : { body: string(options.body, "body") }),
        ...(signal ? { signal } : {}),
      });
      const body = await response.text();
      const clipped = Buffer.byteLength(body) > MAX_HTTP_BYTES ? Buffer.from(body).subarray(0, MAX_HTTP_BYTES).toString("utf8") : body;
      return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers), body: clipped, truncated: clipped !== body };
    }

    if (capability === "ui") {
      if (!ctx.hasUI) throw new Error("UI is not available in this mode");
      switch (method) {
        case "confirm": return ctx.ui.confirm(string(args[0], "title"), string(args[1], "message"));
        case "input": return ctx.ui.input(string(args[0], "title"), args[1] === undefined ? undefined : string(args[1], "placeholder"));
        case "select": {
          if (!Array.isArray(args[1])) throw new Error("options must be an array");
          return ctx.ui.select(string(args[0], "title"), args[1].map(String));
        }
        case "notify": ctx.ui.notify(string(args[0], "message"), (args[1] as "info" | "warning" | "error") ?? "info"); return null;
        default: throw new Error(`Unknown ui method: ${method}`);
      }
    }

    if (capability === "functions") {
      return handleFunctions(functions, method, args);
    }

    if (capability === "context" && method === "get") {
      return {
        cwd: ctx.cwd,
        mode: ctx.mode,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: ctx.thinkingLevel,
        sessionFile: ctx.sessionManager.getSessionFile(),
      };
    }

    throw new Error(`Unknown capability or method: ${capability}.${method}`);
  };
}

export function display(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

export default function pit(pi: ExtensionAPI) {
  const savedFunctions: FunctionRegistry = new Map();

  pi.registerTool({
    name: "typescript",
    label: "TypeScript Workspace",
    description: `Run a TypeScript function in a fresh, permission-restricted process for batched coding operations.

CALLING CONTRACT

Pass a function expression that destructures only the host capabilities it needs:

async ({ workspace, shell }) => {
  const [packageFile, status] = await Promise.all([
    workspace.readText("package.json"),
    shell.exec("git status --short"),
  ]);
  return { packageJson: JSON.parse(packageFile.text), status };
}

The function is contextually type-checked against the capability contract, so capability names, methods, arguments, awaited values, and return values are validated without requiring source annotations. Capability calls begin immediately and return promises. Start independent calls together and await them with Promise.all. Sequence only operations with data dependencies or conflicting side effects. The function cannot use imports and must return a compact JSON-serializable value.

CAPABILITIES

workspace
- workspace.readText(path, { offset?, limit? }) returns { text, truncated, offset, lines, totalLines }; it does not return a raw string.
- workspace.writeText(path, contents) creates parent directories and replaces the complete file.
- workspace.editText(path, edits) applies { oldText, newText } replacements; each oldText must be non-empty, unique in the original file, and non-overlapping.
- workspace.list(path?) returns { name, type } entries.
- workspace.glob(patterns?, { dot?, onlyFiles?, ignore? }) returns matching paths relative to the workspace.
- workspace.stat(path) returns { size, modified, directory, file }.

shell
- shell.exec(command, { cwd?, timeoutMs? }) returns { stdout, stderr, code, truncated }. Nonzero exit codes are returned as data, so inspect code when success matters.

http
- http.request(url, { method?, headers?, body? }) returns { status, ok, headers, body, truncated }.

ui
- ui.confirm(title, message), ui.input(title, placeholder?), ui.select(title, options), and ui.notify(message, level). UI may be unavailable outside interactive or RPC modes.

functions
- functions.set(name, program) saves a self-contained, contextually typed PitProgram for reuse and returns { name, replaced }. Saved functions may not close over local variables; pass changing data through input.
- functions.run(name, input?) executes a saved function with the current capabilities and optional JSON input.
- functions.has(name), functions.list(), and functions.delete(name) inspect or mutate the process-local registry.

context
- context.get() returns cwd, mode, model, thinkingLevel, and sessionFile.

The sandbox has no direct filesystem, network, subprocess, worker, addon, or inherited-environment access. Use capabilities for all external effects. Paths are relative to Pi's current working directory unless absolute. Batch related operations into one call. Parallelize independent reads, searches, status checks, and HTTP requests. Sequence operations when one consumes another's result, when mutating the same file, or when shell commands share mutable state. Return only information useful for the next reasoning step. Output is limited to ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: "Run sandboxed TypeScript with batched and parallel host capabilities plus reusable functions",
    promptGuidelines: [
      "Use typescript for workspace inspection, file changes, shell commands, HTTP requests, UI interactions, and session-context queries.",
      "Call typescript with an async function expression that destructures the required capabilities, such as async ({ workspace, shell }) => { ... }.",
      "Code passed to typescript is contextually type-checked against the capability contract; use validation diagnostics to correct capability names, arguments, missing awaits, and result types.",
      "Capability calls in typescript begin immediately and return promises; await every capability promise before returning the final result.",
      "In typescript, start independent capability calls together with Promise.all; do not await independent operations one at a time.",
      "In typescript, sequence operations only when they have data dependencies or conflicting side effects, especially mutations to the same file or shared shell state.",
      "Batch related work into one typescript call instead of making several small tool calls.",
      "In typescript, save repeated self-contained workflows with functions.set(name, program) and invoke them later with functions.run(name, input).",
      "Saved functions in typescript receive fresh capabilities on every run, must not close over local variables, and should receive changing JSON data through their input parameter.",
      "Remember that typescript workspace.readText returns an object with a text property rather than a raw string.",
      "Remember that typescript shell.exec returns nonzero exit codes as data; inspect code, stdout, and stderr when command success matters.",
      "Return a compact JSON-serializable summary from typescript and avoid returning large intermediate data.",
      "Use only destructured capabilities for external effects in typescript; direct imports, filesystem access, network access, and subprocess creation are unavailable.",
    ],
    parameters: Type.Object({
      code: Type.String({
        description: `A contextually type-checked TypeScript function expression receiving destructured capabilities; source annotations are optional. Example: async ({ workspace, shell }) => { const [file, status] = await Promise.all([workspace.readText("package.json"), shell.exec("git status --short")]); return { packageJson: JSON.parse(file.text), status }; }. Start independent operations together with Promise.all. Sequence only dependent operations or conflicting mutations. Repeated workflows can be saved with functions.set and reused with functions.run. Await all capability promises, do not use imports, and return a compact JSON-serializable value.`,
      }),
      timeoutMs: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 300_000,
        description: "Maximum wall-clock time for the entire invocation in milliseconds (default: 30000).",
      })),
    }),
    renderCall(args, theme, context) {
      const code = typeof args.code === "string" ? args.code : "";
      const lines = code ? highlightCode(code, "typescript") : [];
      const shown = context.expanded ? lines : lines.slice(0, COLLAPSED_CODE_LINES);
      const state = context.argsComplete ? `${lines.length} line${lines.length === 1 ? "" : "s"}` : "generating…";
      let text = theme.fg("toolTitle", theme.bold("typescript"));
      text += theme.fg("dim", ` (${state})`);
      if (args.timeoutMs !== undefined) {
        text += theme.fg("dim", ` timeout=${args.timeoutMs}ms`);
      }
      if (shown.length > 0) {
        text += `\n${shown.join("\n")}`;
      } else {
        text += `\n${theme.fg("dim", context.argsComplete ? "(empty source)" : "(waiting for source…)")}`;
      }
      if (!context.expanded && lines.length > shown.length) {
        text += `\n${theme.fg("muted", `… ${lines.length - shown.length} more lines (Ctrl+O to expand)`)}`;
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const content = result.content[0];
      const fallback = content?.type === "text" ? content.text : "";
      if (isPartial) {
        return new Text(theme.fg("warning", "Running TypeScript…"), 0, 0);
      }
      if (context.isError) {
        return new Text(theme.fg("error", fallback || "TypeScript execution failed"), 0, 0);
      }

      const details = result.details as TypeScriptDetails | undefined;
      let source = fallback;
      let language = "typescript";
      if (details && !details.truncated) {
        if (details.value === undefined) {
          source = "undefined";
        } else {
          try {
            source = JSON.stringify(details.value, null, 2) ?? String(details.value);
            language = "json";
          } catch {
            source = String(details.value);
          }
        }
      }

      const lines = source ? highlightCode(source, language) : [];
      const shown = expanded ? lines : lines.slice(0, COLLAPSED_RESULT_LINES);
      const state = details?.truncated
        ? "truncated"
        : `${lines.length} line${lines.length === 1 ? "" : "s"}`;
      let text = theme.fg("toolTitle", theme.bold("result"));
      text += theme.fg(details?.truncated ? "warning" : "dim", ` (${state})`);
      if (shown.length > 0) {
        text += `\n${shown.join("\n")}`;
      } else {
        text += `\n${theme.fg("dim", "(no result)")}`;
      }
      if (!expanded && lines.length > shown.length) {
        text += `\n${theme.fg("muted", `… ${lines.length - shown.length} more lines (Ctrl+O to expand)`)}`;
      }
      return new Text(text, 0, 0);
    },
    async execute(_id, params, signal, _update, ctx) {
      const value = await runInSandbox(params.code, createCapabilities(pi, ctx, savedFunctions, signal), {
        ...(signal ? { signal } : {}),
        timeoutMs: params.timeoutMs ?? 30_000,
      });
      const rendered = display(value);
      const output = truncateHead(rendered, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
      return {
        content: [{ type: "text", text: output.content + (output.truncated ? "\n[Result truncated]" : "") }],
        details: { value: output.truncated ? undefined : value, truncated: output.truncated },
      };
    },
  });

  pi.on("session_start", () => pi.setActiveTools(["typescript"]));
}
