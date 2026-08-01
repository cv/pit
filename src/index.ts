import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_DIR_NAME,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type CAPABILITY_METHODS,
  type CapabilityName,
  validateCapabilityCall,
} from "./capability-registry.js";
import {
  type CapabilityHandler,
  getNamedFunctionName,
  getProjectFunctionMetadata,
  getSavedFunctionCallSignature,
  runInSandbox,
  validateTypeScript,
} from "./sandbox.js";
import {
  FUNCTION_ENTRY_TYPE,
  type FunctionActivity,
  type FunctionEntry,
  type FunctionRegistry,
  functionRunScope,
  functionScopeRegistry,
  reconstructFunctions,
  registerFunctionManager,
  validateRegistryCapacity,
  validateSavedFunctionName,
} from "./saved-functions.js";

export { reconstructFunctions, validateRegistryCapacity } from "./saved-functions.js";

import { ExecutionProgressController } from "./execution-progress.js";
import type { HostShellProgressEvent, ShellProgressEvent } from "./execution-types.js";

import { prepareGhCommand } from "./gh-capability.js";
import { executeStreamingProcess } from "./host-process.js";
import { prepareNpmCommand } from "./npm-capability.js";
import {
  loadProjectFunctionConfig,
  loadProjectFunctions,
  type ProjectFunctionMetadataRegistry,
  projectFunctionCatalog,
  reconcileProjectFunctionsForSession,
  removeProjectFunction,
  savedFunctionDependents,
  saveProjectFunction,
} from "./project-functions.js";
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
} from "./typescript-tool-renderer.js";
import { handleWorkspace, resolveWorkspacePath } from "./workspace.js";

export { CAPABILITY_METHODS } from "./capability-registry.js";

const MAX_HTTP_BYTES = 1_000_000;

type PublicCapabilityHandler = (
  method: string,
  args: unknown[],
  signal: AbortSignal,
) => unknown | Promise<unknown>;

type CapabilityMethodName<Name extends CapabilityName> = (typeof CAPABILITY_METHODS)[Name][number];

type CapabilityMethodHandler = (args: unknown[], signal: AbortSignal) => unknown | Promise<unknown>;

interface FunctionState {
  projectEnabled: boolean;
  project: FunctionRegistry;

  projectCandidates: FunctionRegistry;
  session: FunctionRegistry;
  effective: FunctionRegistry;
  metadata: ProjectFunctionMetadataRegistry;

  candidateMetadata: ProjectFunctionMetadataRegistry;
}

type FunctionStateCommit = <T>(operation: () => Promise<T> | T) => Promise<T>;

function createFunctionStateCommitQueue(): FunctionStateCommit {
  let tail = Promise.resolve();
  return <T>(operation: () => Promise<T> | T): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

function refreshEffectiveFunctions(state: FunctionState): void {
  state.effective.clear();
  for (const [name, source] of state.project) {
    state.effective.set(name, source);
  }
  for (const [name, source] of state.session) {
    state.effective.set(name, source);
  }
}

function reconcileFunctionState(state: FunctionState): string[] {
  const errors = reconcileProjectFunctionsForSession(
    state.projectCandidates,
    state.candidateMetadata,
    state.session,
    state.project,
    state.metadata,
  );
  refreshEffectiveFunctions(state);
  return errors;
}

export function effectiveRegistry(
  project: ReadonlyMap<string, string>,
  session: ReadonlyMap<string, string>,
): FunctionRegistry {
  return new Map([...project, ...session]);
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
  functionState: FunctionState,

  commitFunctionState: FunctionStateCommit,
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

  const shellHandlers: Record<CapabilityMethodName<"shell">, CapabilityMethodHandler> = {
    exec: (args, signal) => {
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
    },
    execFile: (args, signal) => {
      const program = string(args[0], "program");
      const processArgs = stringArray(args[1], "args");
      const options = args[2] === undefined ? {} : object(args[2], "options");
      return runArgumentSafeProcess(program, processArgs, options, signal);
    },
  };

  const uiHandlers: Record<CapabilityMethodName<"ui">, CapabilityMethodHandler> = {
    confirm: (args) => ctx.ui.confirm(string(args[0], "title"), string(args[1], "message")),
    input: (args) =>
      ctx.ui.input(
        string(args[0], "title"),
        args[1] === undefined ? undefined : string(args[1], "placeholder"),
      ),
    select: (args) => {
      if (!Array.isArray(args[1])) {
        throw new Error("options must be an array");
      }
      return ctx.ui.select(string(args[0], "title"), args[1].map(String));
    },
    notify: (args) => {
      ctx.ui.notify(
        string(args[0], "message"),
        (args[1] as "info" | "warning" | "error" | undefined) ?? "info",
      );
      return null;
    },
  };

  const publicHandlers: Record<CapabilityName, PublicCapabilityHandler> = {
    workspace: (method, args, signal) => handleWorkspace(ctx.cwd, method, args, signal),
    shell: (method, args, signal) =>
      shellHandlers[method as CapabilityMethodName<"shell">](args, signal),
    git: (method, args, signal) => {
      const gitArgs = args[0] === undefined ? [] : stringArray(args[0], "args");
      const options = args[1] === undefined ? {} : object(args[1], "options");
      return runArgumentSafeProcess("git", [method, ...gitArgs], options, signal);
    },
    npm: (method, args, signal) => {
      const command = prepareNpmCommand(method as Parameters<typeof prepareNpmCommand>[0], args);
      return runArgumentSafeProcess("npm", command.args, command.options, signal);
    },
    gh: (method, args, signal) => {
      const command = prepareGhCommand(method as Parameters<typeof prepareGhCommand>[0], args);
      return runArgumentSafeProcess("gh", command.args, command.options, signal);
    },
    http: async (_method, args, signal) => {
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
        signal,
      });
      const body = await readHttpBody(response, maxBytes);
      return {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers),
        body: body.body,
        truncated: body.truncated,
      };
    },
    ui: (method, args, signal) => {
      if (!ctx.hasUI) {
        throw new Error("UI is not available in this mode");
      }
      return uiHandlers[method as CapabilityMethodName<"ui">](args, signal);
    },
    context: () => ({
      cwd: ctx.cwd,
      mode: ctx.mode,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      thinkingLevel: ctx.thinkingLevel,
      sessionFile: ctx.sessionManager.getSessionFile(),
      savedFunctions: [...functionState.effective.keys()].sort(),
      projectFunctions: [...functionState.project.keys()].sort(),
      sessionFunctions: [...functionState.session.keys()].sort(),
      projectFunctionsEnabled: functionState.projectEnabled,
    }),
    functions: (method, args) => {
      if (!ctx.isProjectTrusted()) {
        throw new Error("Project functions require a trusted project");
      }
      if (!functionState.projectEnabled) {
        throw new Error(
          `Project functions are disabled. Enable them in ${CONFIG_DIR_NAME}/pit.json with {"projectFunctions":{"enabled":true}}`,
        );
      }
      const name = method === "list" ? undefined : string(args[0], "function name");
      if (name !== undefined) {
        validateSavedFunctionName(name);
      }
      if (method === "list") {
        return [...functionState.metadata.values()].sort((a, b) => a.name.localeCompare(b.name));
      }
      if (method === "get") {
        const source = functionState.project.get(name as string);
        if (!source) {
          throw new Error(`Project function "${name}" is unavailable`);
        }
        return { ...functionState.metadata.get(name as string), source };
      }
      if (method === "remove") {
        return commitFunctionState(async () => {
          const functionName = name as string;
          if (functionState.projectCandidates.has(functionName)) {
            const dependents = savedFunctionDependents(
              functionState.projectCandidates,
              functionState.session,
              functionState.effective,
              functionName,
            );
            if (dependents.direct.length > 0 || dependents.transitive.length > 0) {
              const details = [
                dependents.direct.length > 0 ? `direct: ${dependents.direct.join(", ")}` : "",
                dependents.transitive.length > 0
                  ? `transitive: ${dependents.transitive.join(", ")}`
                  : "",
              ].filter(Boolean);
              throw new Error(
                `Cannot remove project function "${name}"; dependent saved functions remain (${details.join("; ")})`,
              );
            }
          }
          const removed = await removeProjectFunction(ctx.cwd, functionName);
          functionState.project.delete(functionName);
          functionState.projectCandidates.delete(functionName);
          functionState.metadata.delete(functionName);
          functionState.candidateMetadata.delete(functionName);
          reconcileFunctionState(functionState);
          if (removed) {
            activity.push({ action: "remove", name: functionName, scope: "project" });
          }
          return { name, removed };
        });
      }
    },
  };

  return (capability, method, args, signal, functionContext) => {
    if (capability === "__pit" && method === "savedFunctionRun") {
      const name = string(args[0], "saved function name");
      if (!functionState.effective.has(name)) {
        throw new Error(`Saved function "${name}" is unavailable`);
      }
      activity.push({
        action: "run",
        name,
        scope: functionRunScope(
          name,
          functionState.project,
          functionState.session,
          functionContext?.scope,
        ),
      });
      return null;
    }

    validateCapabilityCall(capability, method, args);
    return publicHandlers[capability as CapabilityName](method, args, signal);
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
  const functionState: FunctionState = {
    projectEnabled: false,
    project: new Map(),

    projectCandidates: new Map(),
    session: new Map(),
    effective: new Map(),
    metadata: new Map(),

    candidateMetadata: new Map(),
  };

  const commitFunctionState = createFunctionStateCommitQueue();

  registerFunctionManager(pi, functionState.session, () => {
    reconcileFunctionState(functionState);
  });

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
      return renderTypeScriptToolCall(args, theme, context, functionState.effective);
    },
    renderResult(result, options, theme, context) {
      return renderTypeScriptToolResult(result, options, theme, context);
    },
    async execute(_id, params, signal, update, ctx) {
      const functionActivity: FunctionActivity[] = [];
      const executionProgress = new ExecutionProgressController(
        update
          ? (snapshot) =>
              update({
                content: [{ type: "text", text: "Running TypeScript…" }],
                details: {
                  value: undefined,
                  truncated: false,
                  ...snapshot,
                  ...(functionActivity.length > 0 ? { functions: [...functionActivity] } : {}),
                },
              })
          : undefined,
      );
      const onShellProgress = update
        ? (event: ShellProgressEvent) => executionProgress.recordShell(event)
        : undefined;
      try {
        const namedFunction = getNamedFunctionName(params.code);
        const projectMetadata = getProjectFunctionMetadata(params.code);
        if (params.saveOnly && namedFunction === undefined) {
          throw new Error("saveOnly requires a named top-level function");
        }
        if (params.saveOnly && params.params !== undefined) {
          throw new Error("saveOnly does not accept top-level params");
        }
        let executionRegistry = functionState.effective;
        let candidateProject: FunctionRegistry | undefined;
        let candidateSession: FunctionRegistry | undefined;
        if (namedFunction) {
          validateSavedFunctionName(namedFunction);
          if (projectMetadata) {
            if (!ctx.isProjectTrusted()) {
              throw new Error("Project functions require a trusted project");
            }
            if (!functionState.projectEnabled) {
              throw new Error(
                `Project functions are disabled. Enable them in ${CONFIG_DIR_NAME}/pit.json with {"projectFunctions":{"enabled":true}}`,
              );
            }
            validateRegistryCapacity(functionState.effective, namedFunction, params.code);
            candidateProject = new Map(functionState.project);
            candidateProject.set(namedFunction, params.code);
            validateTypeScript(params.code, candidateProject, params.params);
            candidateSession = new Map(functionState.session);
            candidateSession.delete(namedFunction);
            executionRegistry = effectiveRegistry(candidateProject, candidateSession);
            validateTypeScript(params.code, executionRegistry, params.params);
          } else {
            validateRegistryCapacity(functionState.effective, namedFunction, params.code);
            candidateSession = new Map(functionState.session);
            candidateSession.set(namedFunction, params.code);
            executionRegistry = effectiveRegistry(functionState.project, candidateSession);
            // Validation compiles every candidate signature together, so replacements
            // are rejected when they invalidate any dependent definition.
            validateTypeScript(params.code, executionRegistry, params.params);
          }
        }
        const executionScopes = functionScopeRegistry(
          executionRegistry,
          candidateSession ?? functionState.session,
        );
        let value: unknown;
        if (params.saveOnly) {
          value = { savedFunction: namedFunction, executed: false };
        } else {
          value = await runInSandbox(
            params.code,
            createCapabilities(
              pi,
              ctx,
              functionState,
              commitFunctionState,
              functionActivity,
              onShellProgress,
            ),
            {
              ...(signal ? { signal } : {}),
              timeoutMs: params.timeoutMs ?? 30_000,
              savedFunctions: executionRegistry,
              savedFunctionScopes: executionScopes,
              ...(params.params === undefined ? {} : { input: params.params }),
              onCapabilityTrace: (trace) => executionProgress.recordTrace(trace),
            },
          );
        }
        if (namedFunction && projectMetadata && candidateProject && candidateSession) {
          await commitFunctionState(async () => {
            validateRegistryCapacity(functionState.effective, namedFunction, params.code);
            const currentProject = new Map(functionState.project);
            currentProject.set(namedFunction, params.code);
            validateTypeScript(params.code, currentProject, params.params);
            const currentSession = new Map(functionState.session);
            currentSession.delete(namedFunction);
            validateTypeScript(
              params.code,
              effectiveRegistry(currentProject, currentSession),
              params.params,
            );

            const replaced = functionState.project.has(namedFunction);
            await saveProjectFunction(
              ctx.cwd,
              namedFunction,
              params.code,
              functionState.projectCandidates,
            );
            functionState.project.set(namedFunction, params.code);
            functionState.metadata.set(namedFunction, projectMetadata);
            functionState.candidateMetadata.set(namedFunction, projectMetadata);
            if (functionState.session.has(namedFunction)) {
              pi.appendEntry(FUNCTION_ENTRY_TYPE, {
                name: namedFunction,
                deleted: true,
              } satisfies FunctionEntry);
            }
            functionState.session.delete(namedFunction);
            reconcileFunctionState(functionState);
            functionActivity.push({
              action: "set",
              name: namedFunction,
              replaced,
              scope: "project",
            });
          });
        } else if (namedFunction && candidateSession) {
          await commitFunctionState(() => {
            validateRegistryCapacity(functionState.effective, namedFunction, params.code);
            const currentSession = new Map(functionState.session);
            currentSession.set(namedFunction, params.code);
            validateTypeScript(
              params.code,
              effectiveRegistry(functionState.project, currentSession),
              params.params,
            );

            const replaced = functionState.session.has(namedFunction);
            pi.appendEntry(FUNCTION_ENTRY_TYPE, {
              name: namedFunction,
              source: params.code,
            } satisfies FunctionEntry);
            functionState.session.set(namedFunction, params.code);
            reconcileFunctionState(functionState);
            functionActivity.push({ action: "set", name: namedFunction, replaced });
          });
        }
        const rendered = display(value);
        const output = truncateHead(rendered, {
          maxBytes: DEFAULT_MAX_BYTES,
          maxLines: DEFAULT_MAX_LINES,
        });
        const savedSignature = namedFunction
          ? getSavedFunctionCallSignature(functionState.effective.get(namedFunction) ?? "")
          : undefined;
        const invocationGuidance = savedSignature ? `. Invoke later with: ${savedSignature}` : ".";
        const savedNotice = namedFunction
          ? params.saveOnly
            ? `\n[Saved ${projectMetadata ? "project " : ""}function "${namedFunction}" without executing it${invocationGuidance}]`
            : `\n[Saved ${projectMetadata ? "project " : ""}function "${namedFunction}"${invocationGuidance}]`
          : "";
        return {
          content: [
            {
              type: "text",
              text:
                output.content +
                (output.truncated ? "\n[Result truncated]" : "") +
                savedNotice +
                savedFunctionCatalogNotice(functionState.effective),
            },
          ],
          details: {
            value: output.truncated ? undefined : value,
            truncated: output.truncated,
            ...(functionActivity.length > 0 ? { functions: functionActivity } : {}),
            ...executionProgress.snapshot(),
          },
        };
      } finally {
        executionProgress.flush();
        executionProgress.dispose();
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const config = await loadProjectFunctionConfig(ctx);
    functionState.projectEnabled = config.enabled;
    const errors = config.enabled
      ? await loadProjectFunctions(
          ctx,
          functionState.projectCandidates,
          functionState.candidateMetadata,
        )
      : [];
    if (!config.enabled) {
      functionState.projectCandidates.clear();
      functionState.candidateMetadata.clear();
    }
    reconstructFunctions(
      functionState.session,
      ctx.sessionManager.getBranch(),
      functionState.projectCandidates,
      new Map(),
    );
    errors.push(...reconcileFunctionState(functionState));
    if (config.error && ctx.hasUI) {
      ctx.ui.notify(config.error, "warning");
    }
    if (errors.length > 0 && ctx.hasUI) {
      const shown = errors.slice(0, 3).join("; ");
      const omitted = errors.length > 3 ? `; … ${errors.length - 3} more` : "";
      ctx.ui.notify(`Some project functions could not be loaded: ${shown}${omitted}`, "warning");
    }
    pi.setActiveTools(["typescript"]);
  });
  pi.on("session_tree", (_event, ctx) => {
    reconstructFunctions(
      functionState.session,
      ctx.sessionManager.getBranch(),
      functionState.projectCandidates,
      new Map(),
    );
    reconcileFunctionState(functionState);
  });
  pi.on("before_agent_start", (event) => {
    const catalog = projectFunctionCatalog(functionState.metadata, functionState.session);
    if (catalog) {
      return { systemPrompt: `${event.systemPrompt}\n\n${catalog}` };
    }
  });
}
