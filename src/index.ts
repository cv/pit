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
import { validateCapabilityCall } from "./capability-registry.js";
import { HangingIndentText } from "./hanging-indent-text.js";
import { type RenderedResultValue, renderResultValue } from "./result-renderers.js";
import {
  type CapabilityHandler,
  getNamedFunctionName,
  getSavedFunctionCallSignature,
  resolveSavedFunctionReferences,
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
import {
  CODE_DESCRIPTION,
  createToolDescription,
  LABEL_DESCRIPTION,
  PARAMS_DESCRIPTION,
  PROMPT_GUIDELINES,
  PROMPT_SNIPPET,
  SAVE_ONLY_DESCRIPTION,
} from "./tool-metadata.js";
import { handleWorkspace, resolveWorkspacePath } from "./workspace.js";

export { CAPABILITY_METHODS } from "./capability-registry.js";

const MAX_HTTP_BYTES = 1_000_000;
const CAPABILITY_CALL_PATTERN = /\b(workspace|shell|http|ui|context)\.(\w+)\s*\(/;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;

function spinnerFrame(elapsedMs: number): string {
  const index = Math.floor(Math.max(0, elapsedMs) / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index] as (typeof SPINNER_FRAMES)[number];
}

interface ShellProgress {
  id: number;
  command: string;
  status: "running" | "done";
  output: string;
  code?: number;
}

interface ActiveTimingState {
  startedAt?: number;
  completedAt?: number;
  timer?: ReturnType<typeof setInterval> | undefined;
}

interface TypeScriptRendererState {
  generation?: ActiveTimingState;
  execution?: ActiveTimingState;
}

type HostShellProgressEvent =
  | { phase: "start" }
  | { phase: "output"; stream: "stdout" | "stderr"; chunk: string }
  | { phase: "end"; code: number };

type ShellProgressEvent = HostShellProgressEvent & {
  id: number;
  command: string;
};

interface TypeScriptDetails {
  value: unknown;
  truncated: boolean;
  functions?: FunctionActivity[];
  progress?: ShellProgress[];
}

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
      const progressId = nextShellProgressId++;
      const progress = onShellProgress
        ? (event: HostShellProgressEvent) => onShellProgress({ id: progressId, command, ...event })
        : undefined;
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
      if (!(Array.isArray(args[1]) && args[1].every((value) => typeof value === "string"))) {
        throw new TypeError("args must be an array of strings");
      }
      const processArgs = args[1] as string[];
      const options = args[2] === undefined ? {} : object(args[2], "options");
      const commandDisplay = [
        program,
        ...processArgs.map((argument) => JSON.stringify(argument)),
      ].join(" ");
      const progressId = nextShellProgressId++;
      const progress = onShellProgress
        ? (event: HostShellProgressEvent) =>
            onShellProgress({ id: progressId, command: commandDisplay, ...event })
        : undefined;
      return executeHostProcess(
        pi,
        program,
        processArgs,
        commandDisplay,
        options,
        ctx.cwd,
        progress,
        signal,
      );
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

function sanitizeProgressText(value: string): string {
  let sanitized = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === "\r") {
      sanitized += "\n";
    } else if (character === "\n" || character === "\t" || (code >= 32 && code !== 127)) {
      sanitized += character;
    }
  }
  return sanitized;
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

function normalizedLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const label = sanitizeProgressText(value).replace(/\s+/g, " ").trim();
  return label || undefined;
}

function rendererState(value: unknown): TypeScriptRendererState {
  return value && typeof value === "object" ? (value as TypeScriptRendererState) : {};
}

function timingState(
  state: TypeScriptRendererState,
  phase: keyof TypeScriptRendererState,
): ActiveTimingState {
  const timing = state[phase] ?? {};
  state[phase] = timing;
  return timing;
}

function activeTiming(
  state: ActiveTimingState,
  complete: boolean,
  invalidate?: () => void,
): { duration: string; spinner: string } {
  const now = Date.now();
  state.startedAt ??= now;
  if (complete) {
    state.completedAt ??= now;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = undefined;
    }
  } else if (!state.timer && invalidate) {
    state.timer = setInterval(invalidate, SPINNER_INTERVAL_MS);
    (state.timer as { unref?: () => void }).unref?.();
  }
  const elapsed = (state.completedAt ?? now) - state.startedAt;
  return {
    duration: `${(Math.max(0, elapsed) / 1000).toFixed(1)}s`,
    spinner: spinnerFrame(elapsed),
  };
}

function generationTiming(context: {
  argsComplete: boolean;
  executionStarted?: boolean;
  isPartial?: boolean;
  state?: unknown;
  invalidate?: () => void;
}): { duration: string; complete: boolean; spinner: string } {
  const state = rendererState(context.state);
  const complete =
    context.argsComplete || context.executionStarted === true || context.isPartial === false;
  if (context.executionStarted === true) {
    timingState(state, "execution").startedAt ??= Date.now();
  }
  return {
    ...activeTiming(timingState(state, "generation"), complete, context.invalidate),
    complete,
  };
}

function executionTiming(
  context: { state?: unknown; invalidate?: () => void },
  complete: boolean,
): { duration: string; spinner: string } {
  const state = rendererState(context.state);
  return activeTiming(timingState(state, "execution"), complete, context.invalidate);
}

function describeCall(
  label: unknown,
  code: string,
  saveOnly: boolean,
  registry: FunctionRegistry,
): string {
  const supplied = normalizedLabel(label);
  if (supplied) {
    return supplied;
  }
  const named = getNamedFunctionName(code);
  if (named) {
    return `${saveOnly ? "Save" : "Define and run"} ${named}`;
  }
  const direct = resolveSavedFunctionReferences(code, registry).find(
    (reference) => reference.direct,
  );
  if (direct) {
    return `Run ${direct.name}`;
  }
  const capability = code.match(CAPABILITY_CALL_PATTERN)?.slice(1, 3).join(".");
  const descriptions: Record<string, string> = {
    "workspace.read": "Read workspace files",
    "workspace.search": "Search workspace",
    "workspace.edit": "Edit workspace files",
    "workspace.batch": "Run workspace batch",
    "workspace.glob": "List matching files",
    "workspace.list": "List workspace entries",
    "workspace.stat": "Inspect file metadata",
    "shell.execFile": "Run command",
    "shell.exec": "Run shell command",
    "http.request": "Request remote data",
    "context.get": "Inspect session context",
  };
  return (capability && descriptions[capability]) || "Run workspace task";
}

function describeResult(
  value: unknown,
  structured: RenderedResultValue | undefined,
  truncated: boolean,
  fallback: string,
): string {
  if (truncated) {
    return "Truncated output";
  }
  if (structured) {
    const summary = structured.summary ? ` ${structured.summary}` : "";
    const verbs: Record<string, string> = {
      read: "Read",
      search: "Found",
      edit: "Edit",
      shell: "Command",
      list: "Listed",
      glob: "Listed",
      http: "Received",
      batch: "Batch",
      stat: "Stat",
      compound: "Returned",
    };
    return `${verbs[structured.kind] ?? "Returned"}${summary}`;
  }
  if (value === undefined) {
    return fallback ? "Returned text" : "No returned value";
  }
  if (Array.isArray(value)) {
    return `Returned ${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    const names = keys.slice(0, 3).join(", ");
    return `Returned ${keys.length} field${keys.length === 1 ? "" : "s"}${names ? `: ${names}` : ""}`;
  }
  return `Returned ${typeof value}`;
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
      const code = typeof args.code === "string" ? args.code : "";
      const callLabel = describeCall(args.label, code, args.saveOnly === true, savedFunctions);
      const lines = code ? highlightCode(code, "typescript") : [];
      const shown = context.expanded ? lines : [];
      const generation = generationTiming(context);
      const state = generation.complete
        ? `${lines.length} line${lines.length === 1 ? "" : "s"}, ${generation.duration}`
        : `generating... ${generation.duration}`;
      const callMarker = generation.complete ? "› " : `${generation.spinner} `;
      let text = theme.bold(
        theme.fg("accent", callMarker) +
          theme.fg("toolTitle", callLabel) +
          theme.fg("dim", ` (${state})`),
      );
      if (args.saveOnly === true) {
        text += theme.fg("accent", " save-only");
      }
      if (context.expanded && shown.length > 0) {
        text += `\n${shown.join("\n")}`;
      } else if (context.expanded) {
        text += `\n${theme.fg("dim", context.argsComplete ? "(empty source)" : "(waiting for source…)")}`;
      }

      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const content = result.content[0];
      const fallback = content?.type === "text" ? content.text : "";
      const details = result.details as TypeScriptDetails | undefined;
      const execution = executionTiming(context, !isPartial || context.isError);
      if (isPartial) {
        let text = theme.bold(
          theme.fg("accent", `${execution.spinner} `) +
            theme.fg("toolTitle", "Running...") +
            theme.fg("dim", ` (${execution.duration})`),
        );
        if (expanded) {
          for (const progress of details?.progress?.slice(-4) ?? []) {
            const state = progress.status === "done" ? `done (${progress.code})` : "running";
            text += `\n${theme.fg("accent", `[${state}]`)} ${theme.fg("dim", progress.command)}`;
            if (progress.output) {
              text += `\n${theme.fg("muted", progress.output)}`;
            }
          }
        }
        return new Text(text, 0, 0);
      }
      if (context.isError) {
        const message = fallback || "TypeScript execution failed";
        return new Text(
          `${expanded ? "\n" : ""}${theme.bold(
            theme.fg("error", "✗ Failed") + theme.fg("dim", ` (${execution.duration})`),
          )}\n${theme.fg("error", message)}`,
          0,
          0,
        );
      }

      let lines: string[];
      let hangingIndents: Record<number, number> = {};
      let structuredResult: RenderedResultValue | undefined;
      if (details && !details.truncated) {
        if (details.value === undefined) {
          lines = highlightCode("undefined", "typescript");
        } else {
          structuredResult = renderResultValue(details.value, theme);
          if (structuredResult) {
            lines = structuredResult.lines;
            hangingIndents = structuredResult.hangingIndents ?? {};
          } else {
            let source: string;
            let language = "json";
            try {
              source = JSON.stringify(details.value, null, 2) ?? String(details.value);
            } catch {
              source = String(details.value);
              language = "typescript";
            }
            lines = highlightCode(source, language);
          }
        }
      } else {
        lines = fallback ? highlightCode(fallback, "typescript") : [];
      }
      const shown = expanded ? lines : [];
      const state = details?.truncated
        ? `truncated, ${execution.duration}`
        : `${lines.length} line${lines.length === 1 ? "" : "s"}, ${execution.duration}`;
      const resultLabel = describeResult(
        details?.value,
        structuredResult,
        details?.truncated === true,
        fallback,
      );
      const resultMarker = details?.truncated
        ? theme.fg("warning", "… ")
        : theme.fg("success", "✓ ");
      let text = `${expanded ? "\n" : ""}${theme.bold(
        resultMarker +
          theme.fg("toolTitle", resultLabel) +
          theme.fg(details?.truncated ? "warning" : "dim", ` (${state})`),
      )}`;
      const resultContentStart = text.split("\n").length;
      if (expanded && shown.length > 0) {
        text += `\n${shown.join("\n")}`;
      } else if (expanded) {
        text += `\n${theme.fg("dim", "(no result)")}`;
      }
      const displayedHangingIndents = Object.fromEntries(
        Object.entries(hangingIndents)
          .filter(([index]) => Number(index) < shown.length)
          .map(([index, width]) => [resultContentStart + Number(index), width]),
      );
      return Object.keys(displayedHangingIndents).length > 0
        ? new HangingIndentText(text, displayedHangingIndents)
        : new Text(text, 0, 0);
    },
    async execute(_id, params, signal, update, ctx) {
      const functionActivity: FunctionActivity[] = [];
      const progressById = new Map<number, ShellProgress>();
      let lastProgressUpdate = 0;
      const onShellProgress = update
        ? (event: ShellProgressEvent) => {
            const current = progressById.get(event.id) ?? {
              id: event.id,
              command: sanitizeProgressText(event.command),
              status: "running" as const,
              output: "",
            };
            if (event.phase === "output") {
              const chunk = sanitizeProgressText(event.chunk);
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
