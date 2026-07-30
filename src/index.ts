import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  highlightCode,
  truncateHead,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  getNamedFunctionName,
  resolveSavedFunctionReferences,
  runInSandbox,
  validateTypeScript,
  type CapabilityHandler,
} from "./sandbox.js";
import {
  FUNCTION_ENTRY_TYPE,
  reconstructFunctions,
  registerFunctionManager,
  validateRegistryCapacity,
  validateSavedFunctionName,
  type FunctionActivity,
  type FunctionEntry,
  type FunctionRegistry,
} from "./saved-functions.js";

export { reconstructFunctions, validateRegistryCapacity } from "./saved-functions.js";
import { handleWorkspace, resolveWorkspacePath, WORKSPACE_METHODS } from "./workspace.js";
import {
  CODE_DESCRIPTION,
  PARAMS_DESCRIPTION,
  PROMPT_GUIDELINES,
  PROMPT_SNIPPET,
  createToolDescription,
} from "./tool-metadata.js";

const MAX_HTTP_BYTES = 1_000_000;
export const CAPABILITY_METHODS = {
  workspace: WORKSPACE_METHODS,
  shell: ["execFile", "exec"],
  http: ["request"],
  ui: ["confirm", "input", "select", "notify"],
  context: ["get"],
} as const;
const COLLAPSED_CODE_LINES = 12;
const COLLAPSED_RESULT_LINES = 12;
const MAX_EXPANDED_SAVED_FUNCTION_LINES = 200;
const MAX_EXPANDED_SAVED_TOTAL_LINES = 500;

interface TypeScriptDetails {
  value: unknown;
  truncated: boolean;
  functions?: FunctionActivity[];
}

async function readHttpBody(response: Response): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = MAX_HTTP_BYTES - bytes;
    if (value.byteLength > remaining) {
      chunks.push(Buffer.from(value.subarray(0, remaining)));
      bytes += Math.max(0, remaining);
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(Buffer.from(value));
    bytes += value.byteLength;
    if (bytes === MAX_HTTP_BYTES) {
      const next = await reader.read();
      if (!next.done) { truncated = true; await reader.cancel(); }
      break;
    }
  }
  return { body: Buffer.concat(chunks, bytes).toString("utf8"), truncated };
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

async function executeHostProcess(
  pi: ExtensionAPI,
  program: string,
  args: string[],
  displayCommand: string,
  options: Record<string, unknown>,
  defaultCwd: string,
  onShellCommand: (command: string) => void,
  signal?: AbortSignal,
) {
  if (options.raise !== undefined && typeof options.raise !== "boolean") {
    throw new TypeError("options.raise must be a boolean");
  }
  const cwd = options.cwd === undefined ? defaultCwd : resolveWorkspacePath(defaultCwd, options.cwd);
  onShellCommand(displayCommand);
  const result = await pi.exec(program, args, {
    cwd,
    ...(signal ? { signal } : {}),
    timeout: Number(options.timeoutMs ?? 120_000),
  });
  const stdout = truncateTail(result.stdout, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  const stderr = truncateTail(result.stderr, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (options.raise === true && result.code !== 0) {
    const detail = (stderr.content.trim() || stdout.content.trim()).slice(-4_000);
    throw new Error(
      `Command failed with exit code ${result.code}: ${displayCommand}` + (detail ? `\n${detail}` : ""),
    );
  }
  return { stdout: stdout.content, stderr: stderr.content, code: result.code, truncated: stdout.truncated || stderr.truncated };
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
      return handleWorkspace(ctx.cwd, method, args);
    }

    if (capability === "shell" && method === "exec") {
      const command = string(args[0], "command");
      const options = args[1] === undefined ? {} : object(args[1], "options");
      return executeHostProcess(pi, "/bin/sh", ["-lc", command], command, options, ctx.cwd, onShellCommand, signal);
    }

    if (capability === "shell" && method === "execFile") {
      const program = string(args[0], "program");
      if (!Array.isArray(args[1]) || !args[1].every((value) => typeof value === "string")) {
        throw new TypeError("args must be an array of strings");
      }
      const processArgs = args[1] as string[];
      const options = args[2] === undefined ? {} : object(args[2], "options");
      const display = [program, ...processArgs.map((value) => JSON.stringify(value))].join(" ");
      return executeHostProcess(pi, program, processArgs, display, options, ctx.cwd, onShellCommand, signal);
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
      const body = await readHttpBody(response);
      return {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers),
        body: body.body,
        truncated: body.truncated,
      };
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
  const resetWorkflowHints = () => {
    shellCommandUses.clear();
    suggestedShellCommands.clear();
  };

  registerFunctionManager(pi, savedFunctions);

  pi.registerTool({
    name: "typescript",
    label: "TypeScript Workspace",
    description: createToolDescription(DEFAULT_MAX_BYTES),
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: [...PROMPT_GUIDELINES],
    parameters: Type.Object({
      code: Type.String({ description: CODE_DESCRIPTION }),
      params: Type.Optional(Type.Unknown({ description: PARAMS_DESCRIPTION })),
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

      const savedReferences = resolveSavedFunctionReferences(code, savedFunctions);
      if (savedReferences.length > 0) {
        text += `\n${theme.fg("accent", `uses saved: ${savedReferences.map((reference) => reference.name).join(", ")}`)}`;
        if (context.expanded) {
          let remaining = MAX_EXPANDED_SAVED_TOTAL_LINES;
          for (const reference of savedReferences) {
            if (remaining <= 0) break;
            const highlighted = highlightCode(reference.source, "typescript");
            const count = Math.min(highlighted.length, MAX_EXPANDED_SAVED_FUNCTION_LINES, remaining);
            const displayed = highlighted.slice(0, count);
            const role = reference.direct ? "saved function" : "saved dependency";
            text += `\n\n${theme.fg("toolTitle", theme.bold(`${role}: ${reference.name}`))}`;
            text += `\n${displayed.join("\n")}`;
            if (highlighted.length > count) {
              text += `\n${theme.fg("muted", `… ${highlighted.length - count} source lines omitted`)}`;
            }
            remaining -= count;
          }
          const displayedCount = savedReferences.reduce((total, reference) =>
            total + Math.min(highlightCode(reference.source, "typescript").length, MAX_EXPANDED_SAVED_FUNCTION_LINES), 0);
          if (displayedCount > MAX_EXPANDED_SAVED_TOTAL_LINES) {
            text += `\n${theme.fg("muted", "… additional saved source omitted by the 500-line display limit")}`;
          }
        }
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
        validateRegistryCapacity(savedFunctions, namedFunction, params.code);
        validateTypeScript(params.code, savedFunctions, params.params);
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
          ...(params.params === undefined ? {} : { input: params.params }),
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
      const available = [...savedFunctions.keys()].sort();
      const savedContext = available.length ? ` Existing saved functions: ${available.join(", ")}.` : "";
      const reuseNotice = reusableCandidates.length
        ? `\n[Repeated shell command detected: ${reusableCandidates.map((command) => JSON.stringify(command)).join(", ")}. Before saving this command alone, consider whether it belongs to a recurring multi-step workflow. Compose existing saved functions into a higher-level named workflow.${savedContext}]`
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
    resetWorkflowHints();
    pi.setActiveTools(["typescript"]);
  });
  pi.on("session_tree", (_event, ctx) => {
    reconstructFunctions(savedFunctions, ctx.sessionManager.getBranch());
    resetWorkflowHints();
  });
}
