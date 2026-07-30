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
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  getNamedFunctionName,
  runInSandbox,
  validateTypeScript,
  type CapabilityHandler,
} from "./sandbox.js";

const MAX_HTTP_BYTES = 1_000_000;
const MAX_SAVED_FUNCTION_BYTES = 100_000;
const SAVED_FUNCTION_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const RESERVED_FUNCTION_NAMES = new Set([
  "Array", "Boolean", "Date", "Error", "Infinity", "JSON", "Map", "Math",
  "NaN", "Number", "Object", "Promise", "RegExp", "Set", "String",
  "console", "eval", "globalThis", "process", "undefined",
]);
export const CAPABILITY_METHODS = {
  workspace: ["readText", "writeText", "editText", "batch", "list", "glob", "stat"],
  shell: ["exec"],
  http: ["request"],
  ui: ["confirm", "input", "select", "notify"],
  context: ["get"],
} as const;

type FunctionRegistry = Map<string, string>;
const FUNCTION_ENTRY_TYPE = "pit-functions";
interface FunctionEntry {
  name: string;
  source: string;
}
interface FunctionActivity {
  action: "set" | "run";
  name: string;
  replaced?: boolean;
}
const COLLAPSED_CODE_LINES = 12;
const COLLAPSED_RESULT_LINES = 12;

interface TypeScriptDetails {
  value: unknown;
  truncated: boolean;
  functions?: FunctionActivity[];
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

function validateSavedFunctionName(name: string): void {
  if (!SAVED_FUNCTION_NAME.test(name) || name.startsWith("__pit") || RESERVED_FUNCTION_NAMES.has(name)) {
    throw new Error(
      "saved function name must be a non-reserved TypeScript identifier of at most 64 characters",
    );
  }
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

function sourceLocation(contents: string, index: number): string {
  const before = contents.slice(0, index);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = index - lastNewline;
  return `${line}:${column}`;
}

function occurrenceLocations(contents: string, search: string): number[] {
  const locations: number[] = [];
  let offset = 0;
  while (offset <= contents.length - search.length) {
    const found = contents.indexOf(search, offset);
    if (found < 0) break;
    locations.push(found);
    offset = found + 1;
  }
  return locations;
}

function applyTextEdits(current: string, rawEdits: unknown): { next: string; edits: number } {
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) throw new Error("edits must be a non-empty array");
  const replacements = rawEdits.map((raw: unknown, index: number) => {
    const edit = object(raw, `edits[${index}]`);
    const oldText = string(edit.oldText, `edits[${index}].oldText`);
    const newText = string(edit.newText, `edits[${index}].newText`);
    if (!oldText) throw new Error(`edits[${index}].oldText may not be empty`);
    const occurrences = occurrenceLocations(current, oldText);
    if (occurrences.length === 0) throw new Error(`edits[${index}].oldText was not found`);
    if (occurrences.length > 1) {
      const shown = occurrences.slice(0, 10).map((offset) => sourceLocation(current, offset));
      const omitted = occurrences.length - shown.length;
      throw new Error(
        `edits[${index}].oldText is not unique; matched ${occurrences.length} times at ${shown.join(", ")}` +
        (omitted ? ` (and ${omitted} more)` : ""),
      );
    }
    const start = occurrences[0]!;
    return { start, end: start + oldText.length, newText };
  });
  const ordered = [...replacements].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i]!.start < ordered[i - 1]!.end) throw new Error("edits overlap");
  }
  let next = current;
  for (const replacement of ordered.reverse()) {
    next = next.slice(0, replacement.start) + replacement.newText + next.slice(replacement.end);
  }
  return { next, edits: replacements.length };
}

async function editText(cwd: string, args: unknown[]) {
  const path = workspacePath(cwd, args[0]);
  return withFileMutationQueue(path, async () => {
    const current = await readFile(path, "utf8");
    const result = applyTextEdits(current, args[1]);
    await writeFile(path, result.next, "utf8");
    return { path, edits: result.edits };
  });
}

async function withMutationQueues<T>(paths: string[], task: () => Promise<T>): Promise<T> {
  const [path, ...rest] = paths;
  return path === undefined
    ? task()
    : withFileMutationQueue(path, () => withMutationQueues(rest, task));
}

async function readSnapshot(path: string): Promise<{ existed: boolean; contents: string }> {
  try {
    return { existed: true, contents: await readFile(path, "utf8") };
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return { existed: false, contents: "" };
    }
    throw error;
  }
}

async function batchWorkspace(cwd: string, args: unknown[]) {
  const rawOperations = args[0];
  if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
    throw new Error("operations must be a non-empty array");
  }
  const operations = rawOperations.map((raw, index) => {
    const operation = object(raw, `operations[${index}]`);
    const kind = string(operation.kind, `operations[${index}].kind`);
    if (kind !== "write" && kind !== "edit") throw new Error(`Unknown batch operation: ${kind}`);
    const path = workspacePath(cwd, operation.path);
    return { kind, path, operation, index };
  });
  const paths = operations.map((operation) => operation.path);
  if (new Set(paths).size !== paths.length) throw new Error("batch operations must target unique paths");

  return withMutationQueues([...paths].sort(), async () => {
    const snapshots = new Map(await Promise.all(paths.map(async (path) => [path, await readSnapshot(path)] as const)));
    const prepared = operations.map(({ kind, path, operation, index }) => {
      const snapshot = snapshots.get(path)!;
      if (kind === "write") {
        const contents = string(operation.contents, `operations[${index}].contents`);
        return { kind, path, snapshot, next: contents, edits: undefined };
      }
      if (!snapshot.existed) throw new Error(`operations[${index}] cannot edit a missing file`);
      const result = applyTextEdits(snapshot.contents, operation.edits);
      return { kind, path, snapshot, next: result.next, edits: result.edits };
    });

    const committed: typeof prepared = [];
    try {
      for (const operation of prepared) {
        await mkdir(dirname(operation.path), { recursive: true });
        await writeFile(operation.path, operation.next, "utf8");
        committed.push(operation);
      }
    } catch (error) {
      for (const operation of committed.reverse()) {
        try {
          if (operation.snapshot.existed) await writeFile(operation.path, operation.snapshot.contents, "utf8");
          else await unlink(operation.path);
        } catch {
          // Preserve the original write failure; rollback is best-effort.
        }
      }
      throw error;
    }
    return {
      files: prepared.map((operation) => ({
        path: operation.path,
        kind: operation.kind,
        bytes: Buffer.byteLength(operation.next),
        ...(operation.edits === undefined ? {} : { edits: operation.edits }),
      })),
    };
  });
}

export function reconstructFunctions(
  registry: FunctionRegistry,
  entries: readonly unknown[],
): void {
  registry.clear();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== FUNCTION_ENTRY_TYPE) continue;
    if (!entry.data || typeof entry.data !== "object") continue;
    const definition = entry.data as Partial<FunctionEntry>;
    if (typeof definition.name !== "string" || typeof definition.source !== "string") continue;
    try {
      validateSavedFunctionName(definition.name);
      validateTypeScript(definition.source, registry);
      registry.set(definition.name, definition.source);
    } catch {
      // Ignore stale or malformed persisted definitions.
    }
  }
}

function createCapabilities(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  registry: FunctionRegistry,
  activity: FunctionActivity[],
  onShellCommand: (command: string) => void,
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
        case "batch": return batchWorkspace(ctx.cwd, args);
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
      onShellCommand(command);
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

    if (capability === "__pit" && method === "savedFunctionRun") {
      const name = string(args[0], "saved function name");
      if (!registry.has(name)) throw new Error(`Saved function "${name}" is unavailable`);
      activity.push({ action: "run", name });
      return null;
    }

    if (capability === "context" && method === "get") {
      return {
        cwd: ctx.cwd,
        mode: ctx.mode,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: ctx.thinkingLevel,
        sessionFile: ctx.sessionManager.getSessionFile(),
        savedFunctions: [...registry.keys()].sort(),
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
  const shellCommandUses = new Map<string, number>();
  const suggestedShellCommands = new Set<string>();

  pi.registerTool({
    name: "typescript",
    label: "TypeScript Workspace",
    description: `Run a TypeScript expression in a fresh, permission-restricted process for batched coding operations.

CALLING CONTRACT

Pass an anonymous function expression for one-shot work. It should destructure only the host capabilities it needs:

async ({ workspace, shell }) => {
  const [packageFile, status] = await Promise.all([
    workspace.readText("package.json"),
    shell.exec("git status --short"),
  ]);
  return { packageJson: JSON.parse(packageFile.text), status };
}

Code is contextually type-checked against the capability contract, so capability names, methods, arguments, awaited values, and return values are validated without requiring source annotations. Capability calls begin immediately and return promises. Start independent calls together and await them with Promise.all. Sequence only operations with data dependencies or conflicting side effects. The function cannot use imports and must return a compact JSON-serializable value.

CAPABILITIES

workspace
- workspace.readText(path, { offset?, limit? }) returns { text, truncated, offset, lines, totalLines }; it does not return a raw string.
- workspace.writeText(path, contents) creates parent directories and replaces the complete file.
- workspace.editText(path, edits) applies { oldText, newText } replacements; each oldText must be non-empty, unique in the original file, and non-overlapping.
- workspace.batch(operations) validates and atomically commits multiple write/edit operations across unique files; validation failures make no changes and write failures trigger best-effort rollback.
- workspace.list(path?) returns { name, type } entries.
- workspace.glob(patterns?, { dot?, onlyFiles?, ignore? }) returns matching paths relative to the workspace.
- workspace.stat(path) returns { size, modified, directory, file }.

shell
- shell.exec(command, { cwd?, timeoutMs? }) returns { stdout, stderr, code, truncated }. Nonzero exit codes are returned as data, so inspect code when success matters.

http
- http.request(url, { method?, headers?, body? }) returns { status, ok, headers, body, truncated }.

ui
- ui.confirm(title, message), ui.input(title, placeholder?), ui.select(title, options), and ui.notify(message, level). UI may be unavailable outside interactive or RPC modes.

context
- context.get() returns cwd, mode, model, thinkingLevel, sessionFile, and savedFunctions.

REUSABLE FUNCTIONS

Give stable project workflows a top-level function name. Named functions are executed and saved automatically:

async function runTests({ shell }, input: { coverage?: boolean } = {}) {
  return shell.exec(input.coverage ? "npm run coverage" : "npm test");
}

Invoke the saved function in a later tool call as ordinary TypeScript. Its current capabilities are bound automatically:

runTests()
runTests({ coverage: true })

Anonymous function expressions are one-shot. A named top-level function is persisted after successful validation, replaces an existing definition with the same name, survives reloads, and follows the active session branch. Saved functions are injected into new isolates as typed lexical bindings and may call one another. Use descriptive names such as runTests, typecheck, lint, build, or gitStatus. context.get().savedFunctions lists the names available on the current branch.

The sandbox has no direct filesystem, network, subprocess, worker, addon, or inherited-environment access. Use capabilities for all external effects. Paths are relative to Pi's current working directory unless absolute. Batch related operations into one call. Parallelize independent reads, searches, status checks, and HTTP requests. Sequence operations when one consumes another's result, when mutating the same file, or when shell commands share mutable state. Return only information useful for the next reasoning step. Output is limited to ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: "Run sandboxed TypeScript with batched and parallel host capabilities plus reusable functions",
    promptGuidelines: [
      "Use typescript for workspace inspection, file changes, shell commands, HTTP requests, UI interactions, and session-context queries.",
      "Call typescript with an anonymous async function for one-shot work, a named async function to save a recurring workflow, or an ordinary call expression such as runTests() to invoke a saved function.",
      "Code passed to typescript is contextually type-checked against the capability contract; use validation diagnostics to correct capability names, arguments, missing awaits, and result types.",
      "Capability calls in typescript begin immediately and return promises; await every capability promise before returning the final result.",
      "In typescript, start independent capability calls together with Promise.all; do not await independent operations one at a time.",
      "In typescript, sequence operations only when they have data dependencies or conflicting side effects, especially mutations to the same file or shared shell state; use workspace.batch for transactional multi-file writes and edits.",
      "Batch related work into one typescript call instead of making several small tool calls.",
      "In typescript, use anonymous functions for one-shot work and named top-level functions for stable workflows likely to recur, such as runTests, typecheck, lint, or build.",
      "Named top-level functions in typescript are saved automatically on the active session branch; invoke them later as ordinary expressions such as runTests() or runTests({ coverage: true }).",
      "Saved functions invoked in typescript receive current capabilities automatically and are listed by context.get().savedFunctions.",
      "In typescript, annotate a saved function's input parameter so later invocations retain input and return type checking.",
      "Remember that typescript workspace.readText returns an object with a text property rather than a raw string.",
      "Remember that typescript shell.exec returns nonzero exit codes as data; inspect code, stdout, and stderr when command success matters.",
      "Return a compact JSON-serializable summary from typescript and avoid returning large intermediate data.",
      "Use only destructured capabilities for external effects in typescript; direct imports, filesystem access, network access, and subprocess creation are unavailable.",
    ],
    parameters: Type.Object({
      code: Type.String({
        description: `Contextually type-checked TypeScript. Use an anonymous function expression for one-shot work: async ({ workspace, shell }) => { const [file, status] = await Promise.all([workspace.readText("package.json"), shell.exec("git status --short")]); return { packageJson: JSON.parse(file.text), status }; }. Use a named top-level function for a recurring workflow: async function runTests({ shell }) { return shell.exec("npm test"); }. Named functions save automatically and can be invoked later with runTests(). Start independent operations together, await all capability promises, do not use imports, and return a compact JSON-serializable value.`,
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
      let text = "";
      if (details?.functions?.length) {
        const operations = details.functions.map((operation) => {
          if (operation.action === "set") return `${operation.replaced ? "replaced" : "saved"} ${operation.name}`;
          return `ran ${operation.name}`;
        });
        text += theme.fg("accent", `functions: ${operations.join(", ")}`) + "\n";
      }
      text += theme.fg("toolTitle", theme.bold("result"));
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
      const functionActivity: FunctionActivity[] = [];
      const repeatedShellCommands = new Set<string>();
      const namedFunction = getNamedFunctionName(params.code);
      if (namedFunction) {
        validateSavedFunctionName(namedFunction);
        if (Buffer.byteLength(params.code) > MAX_SAVED_FUNCTION_BYTES) {
          throw new Error(`saved function source exceeds ${formatSize(MAX_SAVED_FUNCTION_BYTES)}`);
        }
        validateTypeScript(params.code, savedFunctions);
        const replaced = savedFunctions.has(namedFunction);
        savedFunctions.set(namedFunction, params.code);
        pi.appendEntry(FUNCTION_ENTRY_TYPE, { name: namedFunction, source: params.code } satisfies FunctionEntry);
        functionActivity.push({ action: "set", name: namedFunction, replaced });
      }
      const value = await runInSandbox(
        params.code,
        createCapabilities(pi, ctx, savedFunctions, functionActivity, (command) => {
          const count = (shellCommandUses.get(command) ?? 0) + 1;
          shellCommandUses.set(command, count);
          if (count >= 2 && !suggestedShellCommands.has(command)) repeatedShellCommands.add(command);
        }, signal),
        {
          ...(signal ? { signal } : {}),
          timeoutMs: params.timeoutMs ?? 30_000,
          savedFunctions,
        },
      );
      const rendered = display(value);
      const output = truncateHead(rendered, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
      const savedNotice = namedFunction
        ? `\n[Saved function "${namedFunction}". Invoke later with: ${namedFunction}()]`
        : "";
      const reusableCandidates = functionActivity.length === 0
        ? [...repeatedShellCommands]
        : [];
      for (const command of reusableCandidates) suggestedShellCommands.add(command);
      const reuseNotice = reusableCandidates.length
        ? `\n[Repeated shell command detected: ${reusableCandidates.map((command) => JSON.stringify(command)).join(", ")}. Consider naming this workflow as a top-level function so it can be reused.]`
        : "";
      return {
        content: [{
          type: "text",
          text: output.content + (output.truncated ? "\n[Result truncated]" : "") + savedNotice + reuseNotice,
        }],
        details: {
          value: output.truncated ? undefined : value,
          truncated: output.truncated,
          ...(functionActivity.length ? { functions: functionActivity } : {}),
        },
      };
    },
  });

  pi.on("session_start", (_event, ctx) => {
    reconstructFunctions(savedFunctions, ctx.sessionManager.getBranch());
    pi.setActiveTools(["typescript"]);
  });
  pi.on("session_tree", (_event, ctx) => {
    reconstructFunctions(savedFunctions, ctx.sessionManager.getBranch());
  });
}
