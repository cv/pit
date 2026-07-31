import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateCapabilityCall } from "./capability-registry.js";
import { CapabilityTraceCollector } from "./capability-trace.js";
import {
  type CapabilityHandler,
  getNamedFunctionName,
  getSavedFunctionCallSignature,
  runInSandbox,
  validateTypeScript,
} from "./sandbox.js";
import {
  FUNCTION_ENTRY_TYPE,
  type FunctionActivity,
  type FunctionEntry,
  type FunctionRegistry,
  reconstructFunctions,
  registerFunctionManager,
  validateRegistryCapacity,
  validateSavedFunctionName,
} from "./saved-functions.js";

export { reconstructFunctions, validateRegistryCapacity } from "./saved-functions.js";

import { executeStreamingProcess } from "./host-process.js";
import { sanitizeTerminalText } from "./text-sanitization.js";
import {
  CODE_DESCRIPTION,
  createToolDescription,
  LABEL_DESCRIPTION,
  PARAMS_DESCRIPTION,
  PROMPT_GUIDELINES,
  PROMPT_SNIPPET,
  SAVE_ONLY_DESCRIPTION,
} from "./tool-metadata.js";
import {
  renderTypeScriptToolCall,
  renderTypeScriptToolResult,
  type ShellProgress,
} from "./typescript-tool-renderer.js";
import { handleWorkspace, resolveWorkspacePath } from "./workspace.js";

export { CAPABILITY_METHODS } from "./capability-registry.js";

const MAX_HTTP_BYTES = 1_000_000;

type HostShellProgressEvent =
  | { phase: "start" }
  | { phase: "output"; stream: "stdout" | "stderr"; chunk: string }
  | { phase: "end"; code: number };

type ShellProgressEvent = HostShellProgressEvent & {
  id: number;
  command: string;
};

function boundedInteger(
  value: unknown,
  label: string,
  maximum: number,
  defaultValue: number,
): number {
  const resolved = Number(value ?? defaultValue);
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return resolved;
}

async function readHttpBody(
  response: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) {
    return { body: "", truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const remaining = maxBytes - bytes;
    if (value.byteLength > remaining) {
      chunks.push(Buffer.from(value.subarray(0, remaining)));
      bytes += Math.max(0, remaining);
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(Buffer.from(value));
    bytes += value.byteLength;
    if (bytes === maxBytes) {
      const next = await reader.read();
      if (!next.done) {
        truncated = true;
        await reader.cancel();
      }
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
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!(Array.isArray(value) && value.every((entry) => typeof entry === "string"))) {
    throw new TypeError(`${label} must be an array of strings`);
  }
  return value;
}

function formatProcessCommand(program: string, args: string[]): string {
  return [program, ...args.map((argument) => JSON.stringify(argument))].join(" ");
}

async function executeHostProcess(
  pi: ExtensionAPI,
  program: string,
  args: string[],
  displayCommand: string,
  options: Record<string, unknown>,
  defaultCwd: string,
  onProgress?: (event: HostShellProgressEvent) => void,
  signal?: AbortSignal,
) {
  if (options.raise !== undefined && typeof options.raise !== "boolean") {
    throw new TypeError("options.raise must be a boolean");
  }
  const cwd =
    options.cwd === undefined ? defaultCwd : resolveWorkspacePath(defaultCwd, options.cwd);
  const maxBytes = boundedInteger(
    options.maxBytes,
    "options.maxBytes",
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_BYTES,
  );
  const maxLines = boundedInteger(
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

function createCapabilities(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  registry: FunctionRegistry,
  activity: FunctionActivity[],
  onShellProgress?: (event: ShellProgressEvent) => void,
): CapabilityHandler {
  let nextShellProgressId = 1;
  const progressFor = (command: string) => {
    const id = nextShellProgressId++;
    return onShellProgress
      ? (event: HostShellProgressEvent) => onShellProgress({ id, command, ...event })
      : undefined;
  };

  const runArgumentSafeProcess = (
    program: string,
    args: string[],
    options: Record<string, unknown>,
    signal: AbortSignal,
  ) => {
    const command = formatProcessCommand(program, args);
    return executeHostProcess(
      pi,
      program,
      args,
      command,
      options,
      ctx.cwd,
      progressFor(command),
      signal,
    );
  };

  return async (capability, method, args, signal) => {
    if (capability !== "__pit") {
      validateCapabilityCall(capability, method, args);
    }
    if (capability === "workspace") {
      return handleWorkspace(ctx.cwd, method, args, signal);
    }

    if (capability === "shell" && method === "exec") {
      const command = string(args[0], "command");
      const options = args[1] === undefined ? {} : object(args[1], "options");
      const progress = progressFor(command);
      return executeHostProcess(
        pi,
        "/bin/sh",
        ["-lc", command],
        command,
        options,
        ctx.cwd,
        progress,
        signal,
      );
    }

    if (capability === "shell" && method === "execFile") {
      const program = string(args[0], "program");
      const processArgs = stringArray(args[1], "args");
      const options = args[2] === undefined ? {} : object(args[2], "options");
      return runArgumentSafeProcess(program, processArgs, options, signal);
    }

    if (capability === "git") {
      const gitArgs = args[0] === undefined ? [] : stringArray(args[0], "args");
      const options = args[1] === undefined ? {} : object(args[1], "options");
      return runArgumentSafeProcess("git", [method, ...gitArgs], options, signal);
    }

    if (capability === "http" && method === "request") {
      const url = string(args[0], "url");
      const options = args[1] === undefined ? {} : object(args[1], "options");
      const maxBytes = boundedInteger(
        options.maxBytes,
        "options.maxBytes",
        MAX_HTTP_BYTES,
        MAX_HTTP_BYTES,
      );
      const response = await fetch(url, {
        ...(options.method === undefined ? {} : { method: string(options.method, "method") }),
        ...(options.headers === undefined
          ? {}
          : { headers: options.headers as Record<string, string> }),
        ...(options.body === undefined ? {} : { body: string(options.body, "body") }),
        ...(signal ? { signal } : {}),
      });
      const body = await readHttpBody(response, maxBytes);
      return {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers),
        body: body.body,
        truncated: body.truncated,
      };
    }

    if (capability === "ui") {
      if (!ctx.hasUI) {
        throw new Error("UI is not available in this mode");
      }
      switch (method) {
        case "confirm":
          return ctx.ui.confirm(string(args[0], "title"), string(args[1], "message"));
        case "input":
          return ctx.ui.input(
            string(args[0], "title"),
            args[1] === undefined ? undefined : string(args[1], "placeholder"),
          );
        case "select": {
          if (!Array.isArray(args[1])) {
            throw new Error("options must be an array");
          }
          return ctx.ui.select(string(args[0], "title"), args[1].map(String));
        }
        case "notify":
          ctx.ui.notify(
            string(args[0], "message"),
            (args[1] as "info" | "warning" | "error" | undefined) ?? "info",
          );
          return null;
        /* v8 ignore next -- registry validation rejects unknown UI methods before dispatch. */
        default:
          throw new Error(`Capability registry and UI dispatcher disagree: ${method}`);
      }
    }

    if (capability === "__pit" && method === "savedFunctionRun") {
      const name = string(args[0], "saved function name");
      if (!registry.has(name)) {
        throw new Error(`Saved function "${name}" is unavailable`);
      }
      activity.push({ action: "run", name });
      return null;
    }

    /* v8 ignore next -- registry validation routes the only context method here. */
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

    /* v8 ignore next -- registry validation rejects unknown public calls before dispatch. */
    throw new Error(`Capability registry and dispatcher disagree: ${capability}.${method}`);
  };
}

export function display(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "undefined";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const MAX_SAVED_FUNCTION_CATALOG_BYTES = 1200;

function savedFunctionCatalogNotice(registry: ReadonlyMap<string, string>): string {
  const signatures = [...registry.values()]
    .map(getSavedFunctionCallSignature)
    .filter((signature): signature is string => signature !== undefined)
    .sort((a, b) => a.localeCompare(b));
  if (signatures.length === 0) {
    return "";
  }
  const catalog = truncateHead(signatures.join(", "), {
    maxBytes: MAX_SAVED_FUNCTION_CATALOG_BYTES,
    maxLines: 1,
  }).content;
  return `\n[Saved functions: ${catalog}]`;
}

export default function pit(pi: ExtensionAPI) {
  const savedFunctions: FunctionRegistry = new Map();

  registerFunctionManager(pi, savedFunctions);

  pi.registerTool({
    name: "typescript",
    label: "TypeScript Workspace",
    description: createToolDescription(DEFAULT_MAX_BYTES),
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: [...PROMPT_GUIDELINES],
    parameters: Type.Object({
      label: Type.Optional(Type.String({ description: LABEL_DESCRIPTION })),
      code: Type.String({ description: CODE_DESCRIPTION }),
      params: Type.Optional(Type.Unknown({ description: PARAMS_DESCRIPTION })),
      saveOnly: Type.Optional(Type.Boolean({ description: SAVE_ONLY_DESCRIPTION })),
      timeoutMs: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 300_000,
          description:
            "Maximum wall-clock time for the entire invocation in milliseconds (default: 30000).",
        }),
      ),
    }),
    renderCall(args, theme, context) {
      return renderTypeScriptToolCall(args, theme, context, savedFunctions);
    },
    renderResult(result, options, theme, context) {
      return renderTypeScriptToolResult(result, options, theme, context);
    },
    async execute(_id, params, signal, update, ctx) {
      const functionActivity: FunctionActivity[] = [];
      const capabilityTraces = new CapabilityTraceCollector();
      const capabilityTraceDetails = () => {
        const snapshot = capabilityTraces.snapshot();
        return {
          ...(snapshot.traces.length > 0 ? { traces: snapshot.traces } : {}),
          ...(snapshot.truncated ? { tracesTruncated: true as const } : {}),
        };
      };
      const progressById = new Map<number, ShellProgress>();
      let lastProgressUpdate = 0;
      const onShellProgress = update
        ? (event: ShellProgressEvent) => {
            const current = progressById.get(event.id) ?? {
              id: event.id,
              command: sanitizeTerminalText(event.command),
              status: "running" as const,
              output: "",
            };
            if (event.phase === "output") {
              const chunk = sanitizeTerminalText(event.chunk);
              current.output = truncateTail(current.output + chunk, {
                maxBytes: 4000,
                maxLines: 8,
              }).content;
            }
            if (event.phase === "end") {
              current.status = "done";
              current.code = event.code;
            }
            progressById.set(event.id, current);
            const now = Date.now();
            if (event.phase !== "output" || now - lastProgressUpdate >= 100) {
              lastProgressUpdate = now;
              update({
                content: [{ type: "text", text: "Running TypeScript…" }],
                details: {
                  value: undefined,
                  truncated: false,
                  progress: [...progressById.values()],
                  ...capabilityTraceDetails(),
                },
              });
            }
          }
        : undefined;
      const namedFunction = getNamedFunctionName(params.code);
      if (params.saveOnly && namedFunction === undefined) {
        throw new Error("saveOnly requires a named top-level function");
      }
      if (params.saveOnly && params.params !== undefined) {
        throw new Error("saveOnly does not accept top-level params");
      }
      let executionRegistry: FunctionRegistry = savedFunctions;
      let replacedNamedFunction = false;
      if (namedFunction) {
        validateSavedFunctionName(namedFunction);
        validateRegistryCapacity(savedFunctions, namedFunction, params.code);
        const candidateRegistry = new Map(savedFunctions);
        candidateRegistry.set(namedFunction, params.code);
        // Validation compiles every candidate signature together, so replacements
        // are rejected when they invalidate any dependent definition.
        validateTypeScript(params.code, candidateRegistry, params.params);
        executionRegistry = candidateRegistry;
        replacedNamedFunction = savedFunctions.has(namedFunction);
        functionActivity.push({
          action: "set",
          name: namedFunction,
          replaced: replacedNamedFunction,
        });
      }
      let value: unknown;
      if (params.saveOnly) {
        value = { savedFunction: namedFunction, executed: false };
      } else {
        value = await runInSandbox(
          params.code,
          createCapabilities(pi, ctx, executionRegistry, functionActivity, onShellProgress),
          {
            ...(signal ? { signal } : {}),
            timeoutMs: params.timeoutMs ?? 30_000,
            savedFunctions: executionRegistry,
            ...(params.params === undefined ? {} : { input: params.params }),
            onCapabilityTrace: (trace) => capabilityTraces.record(trace),
          },
        );
      }
      if (namedFunction) {
        pi.appendEntry(FUNCTION_ENTRY_TYPE, {
          name: namedFunction,
          source: params.code,
        } satisfies FunctionEntry);
        savedFunctions.set(namedFunction, params.code);
      }
      const rendered = display(value);
      const output = truncateHead(rendered, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      });
      const savedNotice = namedFunction
        ? params.saveOnly
          ? `\n[Saved function "${namedFunction}" without executing it. Invoke later with: ${namedFunction}()]`
          : `\n[Saved function "${namedFunction}". Invoke later with: ${namedFunction}()]`
        : "";
      return {
        content: [
          {
            type: "text",
            text:
              output.content +
              (output.truncated ? "\n[Result truncated]" : "") +
              savedNotice +
              savedFunctionCatalogNotice(savedFunctions),
          },
        ],
        details: {
          value: output.truncated ? undefined : value,
          truncated: output.truncated,
          ...(functionActivity.length > 0 ? { functions: functionActivity } : {}),
          ...capabilityTraceDetails(),
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
