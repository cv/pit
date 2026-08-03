import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FunctionState } from "./function-state.js";
import { reconcileFunctionState, resetFunctionUsage } from "./function-state.js";
import {
  loadProjectFunctionConfig,
  loadProjectFunctions,
  projectFunctionCatalog,
} from "./project-functions.js";
import { registerFunctionManager } from "./saved-function-manager.js";
import type { SavedFunctionService } from "./saved-function-service.js";
import { reconstructFunctions } from "./saved-functions.js";
import { formatPitSkillsForPrompt } from "./skill-prompt.js";

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

export function registerSavedFunctionFeatures(
  pi: ExtensionAPI,
  functionState: FunctionState,
  savedFunctionService: SavedFunctionService,
): void {
  registerSavedFunctionManager({ pi, functionState, savedFunctionService });
  registerFunctionLifecycle(pi, functionState);
}
