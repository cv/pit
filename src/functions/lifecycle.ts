import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatPitSkillsForPrompt } from "../skill-prompt.js";
import { reconstructFunctions } from "./core.js";
import { registerFunctionManager } from "./manager.js";
import { globalFunctionCatalog, projectFunctionCatalog } from "./persistent-functions.js";
import type { SavedFunctionService } from "./service.js";
import type { FunctionState } from "./state.js";
import { reconcileFunctionState, resetFunctionUsage } from "./state.js";
import {
  globalFunctionDirectory,
  globalFunctionPath,
  loadGlobalFunctionConfig,
  loadGlobalFunctions,
} from "./storage/global.js";
import { loadProjectFunctionConfig, loadProjectFunctions } from "./storage/project.js";

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
    globalFunctions: functionState.global,
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
    saveToGlobal: async (name, ctx) => {
      const summary = await ctx.ui.input(`Save ${name} globally`, "Short global-function summary");
      if (summary === undefined) {
        return;
      }
      const confirmed = await ctx.ui.confirm(
        `Save ${name} globally?`,
        `Make ${name} available in every Pit project under ${globalFunctionDirectory()}?`,
      );
      if (!confirmed) {
        return;
      }
      await savedFunctionService.promoteToGlobal({ name, summary, context: ctx });
      ctx.ui.notify(`Saved function globally: ${name}`, "info");
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
    removeFromGlobal: async (name, ctx) => {
      const confirmed = await ctx.ui.confirm(
        `Remove ${name} globally?`,
        `Delete ${globalFunctionPath(name)} for every project?`,
      );
      if (!confirmed) {
        return;
      }
      const removed = await savedFunctionService.removeFromGlobal(name);
      ctx.ui.notify(
        removed ? `Removed global function: ${name}` : `Global function file was absent: ${name}`,
        removed ? "info" : "warning",
      );
    },
  });
}

function registerFunctionLifecycle(pi: ExtensionAPI, functionState: FunctionState): void {
  pi.on("session_start", async (_event, ctx) => {
    resetFunctionUsage(functionState);
    const [globalConfig, projectConfig] = await Promise.all([
      loadGlobalFunctionConfig(),
      loadProjectFunctionConfig(ctx),
    ]);
    functionState.globalEnabled = globalConfig.enabled && projectConfig.globalEnabled !== false;
    functionState.projectEnabled = projectConfig.enabled;
    const errors: string[] = [];
    if (functionState.globalEnabled) {
      errors.push(
        ...(await loadGlobalFunctions(functionState.global, functionState.globalMetadata)),
      );
    } else {
      functionState.global.clear();
      functionState.globalMetadata.clear();
    }
    if (projectConfig.enabled) {
      errors.push(
        ...(await loadProjectFunctions(
          ctx,
          functionState.projectCandidates,
          functionState.candidateMetadata,
          functionState.global,
        )),
      );
    } else {
      functionState.projectCandidates.clear();
      functionState.candidateMetadata.clear();
    }
    reconstructFunctions(
      functionState.session,
      ctx.sessionManager.getBranch(),
      new Map([...functionState.global, ...functionState.projectCandidates]),
      new Map(),
    );
    errors.push(...reconcileFunctionState(functionState));
    for (const error of [globalConfig.error, projectConfig.error].filter(Boolean)) {
      if (ctx.hasUI) {
        ctx.ui.notify(error as string, "warning");
      }
    }
    if (errors.length > 0 && ctx.hasUI) {
      const shown = errors.slice(0, 3).join("; ");
      const omitted = errors.length > 3 ? `; … ${errors.length - 3} more` : "";
      ctx.ui.notify(`Some saved functions could not be loaded: ${shown}${omitted}`, "warning");
    }
    pi.setActiveTools(["typescript"]);
  });
  pi.on("session_tree", (_event, ctx) => {
    resetFunctionUsage(functionState);
    reconstructFunctions(
      functionState.session,
      ctx.sessionManager.getBranch(),
      new Map([...functionState.global, ...functionState.projectCandidates]),
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
      globalFunctionCatalog(
        functionState.globalMetadata,
        functionState.project,
        functionState.session,
      ),
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
