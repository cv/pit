import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
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
  type FunctionState,
  reconcileFunctionState,
} from "./function-state.js";
import { createCapabilities } from "./host-capabilities.js";
import {
  loadProjectFunctionConfig,
  loadProjectFunctions,
  projectFunctionCatalog,
} from "./project-functions.js";
import { getSavedFunctionCallSignature, runInSandbox } from "./sandbox.js";
import { SavedFunctionService } from "./saved-function-service.js";
import {
  type FunctionActivity,
  reconstructFunctions,
  registerFunctionManager,
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

interface FunctionManagerRegistration {
  pi: ExtensionAPI;
  functionState: FunctionState;
  savedFunctionService: SavedFunctionService;
}

function registerSavedFunctionManager({
  pi,
  functionState,
  savedFunctionService,
}: FunctionManagerRegistration): void {
  registerFunctionManager(pi, functionState.session, {
    onChange: () => {
      reconcileFunctionState(functionState);
    },
    saveToProject: async (name, ctx) => {
      const summary = await ctx.ui.input(
        `Save ${name} to project`,
        "Short project-function summary",
      );
      if (summary === undefined) {
        return;
      }
      await savedFunctionService.promoteToProject({ name, summary, context: ctx });
      ctx.ui.notify(`Saved function to project: ${name}`, "info");
    },
  });
}

export default function pit(pi: ExtensionAPI) {
  const functionState = createFunctionState();

  const commitFunctionState = createFunctionStateCommitQueue();
  const savedFunctionService = new SavedFunctionService({
    state: functionState,
    commit: commitFunctionState,
    appendEntry: (type, entry) => pi.appendEntry(type, entry),
  });

  registerSavedFunctionManager({ pi, functionState, savedFunctionService });

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
    // biome-ignore lint/complexity/useMaxParams: Pi defines the tool execute callback signature.
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
        const preparedFunction = savedFunctionService.prepare({
          source: params.code,
          ...(params.params === undefined ? {} : { input: params.params }),
          ...(params.saveOnly ? { saveOnly: true } : {}),
          context: ctx,
        });
        const namedFunction = preparedFunction.name;
        const projectMetadata = preparedFunction.projectMetadata;
        const executionRegistry = preparedFunction.registry;
        const executionScopes = preparedFunction.scopes;
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
        await savedFunctionService.commit(preparedFunction, ctx, functionActivity);
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
