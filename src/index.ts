import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateTail,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fg from "fast-glob";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runInSandbox, type CapabilityHandler } from "./sandbox.js";

const MAX_HTTP_BYTES = 1_000_000;

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

function createCapabilities(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal): CapabilityHandler {
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
  pi.registerTool({
    name: "typescript",
    label: "TypeScript",
    description: `Execute a TypeScript function in an isolated process and return its JSON-serializable result. Pass a function expression receiving destructurable capabilities, for example: async ({ workspace }) => workspace.readText("package.json"). Available capabilities: workspace.readText(path, {offset?, limit?}), writeText(path, contents), editText(path, edits), list(path?), glob(patterns, options?), stat(path); shell.exec(command, {cwd?, timeoutMs?}); http.request(url, {method?, headers?, body?}); ui.confirm/input/select/notify; context.get(). The sandbox itself has no filesystem, network, subprocess, worker, addon, or inherited-environment access. Output is limited to ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: "Execute isolated TypeScript with explicitly injected capabilities",
    promptGuidelines: [
      "Use typescript for all tool work; combine related reads, searches, commands, and edits into one function when practical.",
      "In typescript, destructure the host capabilities you need: ({ workspace, shell, http, ui, context }) => { ... }.",
      "The typescript source must be a function expression, must return the useful result, and cannot use imports.",
    ],
    parameters: Type.Object({
      code: Type.String({ description: "A TypeScript function expression: async ({ workspace, shell }) => { ...; return value }" }),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 300_000, description: "Overall execution timeout (default 30000)" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const value = await runInSandbox(params.code, createCapabilities(pi, ctx, signal), {
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
