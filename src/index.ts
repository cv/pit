import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_DIR_NAME,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ExecutionProgressController } from "./execution-progress.js";
import type { ShellProgressEvent } from "./execution-types.js";
import {
  createFunctionState,
  createFunctionStateCommitQueue,
  effectiveRegistry,
  reconcileFunctionState,
} from "./function-state.js";
import { createCapabilities } from "./host-capabilities.js";
import {
  loadProjectFunctionConfig,
  loadProjectFunctions,
  projectFunctionCatalog,
  saveProjectFunction,
} from "./project-functions.js";
import {
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
  functionScopeRegistry,
  reconstructFunctions,
  registerFunctionManager,
  validateRegistryCapacity,
  validateSavedFunctionName,
} from "./saved-functions.js";
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

export { CAPABILITY_METHODS } from "./capability-registry.js";
export { effectiveRegistry } from "./function-state.js";
export { reconstructFunctions, validateRegistryCapacity } from "./saved-functions.js";

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
  const functionState = createFunctionState();

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
            createCapabilities({
              pi,
              ctx,
              functionState,
              commitFunctionState,
              activity: functionActivity,
              ...(onShellProgress ? { onShellProgress } : {}),
            }),
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
