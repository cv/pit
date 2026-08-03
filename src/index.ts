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
  resetFunctionUsage,
} from "./function-state.js";
import { createCapabilities } from "./host-capabilities.js";
import {
  loadProjectFunctionConfig,
  loadProjectFunctions,
  projectFunctionCatalog,
} from "./project-functions.js";
import { registerRuntimeControlCommands } from "./runtime-control-commands.js";
import { getSavedFunctionCallSignature, runInSandbox } from "./sandbox.js";
import { SavedFunctionService } from "./saved-function-service.js";
import {
  type FunctionActivity,
  reconstructFunctions,
  registerFunctionManager,
} from "./saved-functions.js";
import { registerSessionControlCommands } from "./session-control-commands.js";
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
  captureTypeScriptFailure,
  registerTypeScriptFailureEnrichment,
  type TypeScriptFailureDetails,
} from "./typescript-failure-context.js";
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

interface PitPromptSkill {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation?: boolean;
}

function escapePromptXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function formatPitSkillsForPrompt(skills: readonly PitPromptSkill[]): string {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) {
    return "";
  }

  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the typescript tool's workspace.read capability to load the complete skill file when the task matches its description. Always read skill files in full.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and pass that absolute path to workspace.read or the relevant Pit capability.",
    "",
    "<available_skills>",
  ];
  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapePromptXml(skill.name)}</name>`);
    lines.push(`    <description>${escapePromptXml(skill.description)}</description>`);
    lines.push(`    <location>${escapePromptXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

const MAX_SAVED_FUNCTION_CATALOG_BYTES = 1200;

export function savedFunctionCatalogNotice(registry: ReadonlyMap<string, string>): string {
  const signatures = [...registry.values()]
    .map(getSavedFunctionCallSignature)
    .filter((signature): signature is string => signature !== undefined)
    .sort((a, b) => a.localeCompare(b));
  if (signatures.length === 0) {
    return "";
  }

  const notice = (shown: readonly string[], omitted: number): string => {
    const entries = omitted > 0 ? [...shown, `… ${omitted} more`] : shown;
    return `\n[Session functions: ${entries.join(", ")}]`;
  };
  let catalog = notice([], signatures.length);
  for (let shown = 1; shown <= signatures.length; shown++) {
    const candidate = notice(signatures.slice(0, shown), signatures.length - shown);
    if (Buffer.byteLength(candidate) > MAX_SAVED_FUNCTION_CATALOG_BYTES) {
      break;
    }
    catalog = candidate;
  }
  return catalog;
}

export function promotionSuggestionNotice(names: readonly string[]): string {
  const suggested = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  const shown = suggested.slice(0, 5);
  if (shown.length === 0) {
    return "";
  }
  const omitted =
    suggested.length > shown.length ? `; … ${suggested.length - shown.length} more` : "";
  return `\n[Promotion suggestion: heavily reused session function${shown.length === 1 ? "" : "s"} ${shown.join(", ")}. Use functions.promote(name, summary) explicitly in an enabled, trusted project${omitted}.]`;
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
    projectFunctions: functionState.project,
    planSessionRemoval: (name) => savedFunctionService.planRemoval(name, "session"),
    removeSession: (name) => savedFunctionService.removeSession(name, { cascade: true }),
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
    removeFromProject: async (name, ctx) => {
      const confirmed = await ctx.ui.confirm(
        `Remove ${name} from project?`,
        `Delete .pi/pit/functions/${name}.ts?`,
      );
      if (!confirmed) {
        return;
      }
      const removed = await savedFunctionService.removeFromProject({ name, context: ctx });
      ctx.ui.notify(
        removed ? `Removed project function: ${name}` : `Project function file was absent: ${name}`,
        removed ? "info" : "warning",
      );
    },
  });
}

function registerFunctionLifecycle(pi: ExtensionAPI, functionState: FunctionState): void {
  pi.on("session_start", async (_event, ctx) => {
    resetFunctionUsage(functionState);
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
    resetFunctionUsage(functionState);
    reconstructFunctions(
      functionState.session,
      ctx.sessionManager.getBranch(),
      functionState.projectCandidates,
      new Map(),
    );
    reconcileFunctionState(functionState);
  });
  pi.on("before_agent_start", (event) => {
    const promptAlreadyHasSkills =
      event.systemPromptOptions?.selectedTools?.includes("read") ||
      event.systemPrompt.includes("<available_skills>");
    const additions = [
      promptAlreadyHasSkills
        ? ""
        : formatPitSkillsForPrompt(event.systemPromptOptions?.skills ?? []),
      projectFunctionCatalog(functionState.metadata, functionState.session),
    ].filter(Boolean);
    if (additions.length > 0) {
      return { systemPrompt: `${event.systemPrompt}\n\n${additions.join("\n\n")}` };
    }
  });
}

export default function pit(pi: ExtensionAPI) {
  registerRuntimeControlCommands(pi);
  registerSessionControlCommands(pi);
  const functionState = createFunctionState();
  const pendingFailures = new Map<string, TypeScriptFailureDetails>();
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
    async execute(id, params, signal, update, ctx) {
      const functionActivity: FunctionActivity[] = [];
      const promotionSuggestions: string[] = [];
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
              promotionSuggestions,
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
        const promotionNotice = promotionSuggestionNotice(promotionSuggestions);
        return {
          content: [
            {
              type: "text",
              text:
                output.content +
                (output.truncated ? "\n[Result truncated]" : "") +
                savedNotice +
                promotionNotice +
                savedFunctionCatalogNotice(functionState.session),
            },
          ],
          details: {
            value: output.truncated ? undefined : value,
            truncated: output.truncated,
            ...(functionActivity.length > 0 ? { functions: functionActivity } : {}),
            ...executionProgress.snapshot(),
          },
        };
      } catch (error) {
        pendingFailures.set(
          id,
          captureTypeScriptFailure(error, functionActivity, executionProgress.snapshot()),
        );
        throw error;
      } finally {
        executionProgress.flush();
        executionProgress.dispose();
      }
    },
  });

  registerTypeScriptFailureEnrichment(pi, pendingFailures);
  registerFunctionLifecycle(pi, functionState);
}
