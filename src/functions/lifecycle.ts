import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatPitSkillsForPrompt } from "../skill-prompt.js";
import { reconstructFunctions } from "./core.js";
import { functionRelativePath } from "./identifier.js";
import { registerFunctionManager } from "./manager.js";
import { userFunctionCatalog, projectFunctionCatalog } from "./persistent-functions.js";
import type { SavedFunctionService } from "./service.js";
import type { FunctionState } from "./state.js";
import { reconcileFunctionState, resetFunctionUsage, stateFunctionEnvironment } from "./state.js";
import { loadProjectFunctionConfig, loadProjectFunctions } from "./storage/project.js";
import { userFunctionDirectory, userFunctionPath, loadUserFunctions } from "./storage/user.js";

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
    userFunctions: functionState.user,
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
    saveToUser: async (name, ctx) => {
      const summary = await ctx.ui.input(
        `Save ${name} to user scope`,
        "Short user-function summary",
      );
      if (summary === undefined) {
        return;
      }
      const confirmed = await ctx.ui.confirm(
        `Save ${name} to user scope?`,
        `Make ${name} available in every Pit project under ${userFunctionDirectory()}?`,
      );
      if (!confirmed) {
        return;
      }
      await savedFunctionService.promoteToUser({ name, summary, context: ctx });
      ctx.ui.notify(`Saved function to user scope: ${name}`, "info");
    },

    removeFromProject: async (name, ctx) => {
      const confirmed = await ctx.ui.confirm(
        `Remove ${name} from project?`,
        `Delete .pi/functions/${functionRelativePath(name)}?`,
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
    removeFromUser: async (name, ctx) => {
      const confirmed = await ctx.ui.confirm(
        `Remove ${name} from user scope?`,
        `Delete ${userFunctionPath(name)} for every project?`,
      );
      if (!confirmed) {
        return;
      }
      const removed = await savedFunctionService.removeFromUser(name);
      ctx.ui.notify(
        removed ? `Removed user function: ${name}` : `User function file was absent: ${name}`,
        removed ? "info" : "warning",
      );
    },
  });
}

function registerFunctionLifecycle(pi: ExtensionAPI, functionState: FunctionState): void {
  pi.on("session_start", async (_event, ctx) => {
    resetFunctionUsage(functionState);
    const projectConfig = await loadProjectFunctionConfig(ctx);
    functionState.projectEnabled = projectConfig.enabled;
    const errors = await loadUserFunctions(
      functionState.user,
      functionState.userMetadata,
      functionState.invalidUser,
    );
    if (projectConfig.enabled) {
      errors.push(
        ...(await loadProjectFunctions(
          ctx,
          functionState.projectCandidates,
          functionState.candidateMetadata,
          {
            user: functionState.user,
            invalidDefinitions: functionState.invalidProject,
            invalidUser: functionState.invalidUser,
          },
        )),
      );
    } else {
      functionState.invalidProject.clear();
      functionState.projectCandidates.clear();
      functionState.candidateMetadata.clear();
    }
    reconstructFunctions(
      functionState.session,
      ctx.sessionManager.getBranch(),
      new Map([...functionState.user, ...functionState.projectCandidates]),
      {
        capacityBaseFunctions: new Map(),
        environment: stateFunctionEnvironment(functionState, {
          projectFunctions: functionState.projectCandidates,
        }),
      },
    );
    errors.push(...reconcileFunctionState(functionState));
    for (const error of [projectConfig.error].filter(Boolean)) {
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
      new Map([...functionState.user, ...functionState.projectCandidates]),
      {
        capacityBaseFunctions: new Map(),
        environment: stateFunctionEnvironment(functionState, {
          projectFunctions: functionState.projectCandidates,
        }),
      },
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
      userFunctionCatalog(functionState.userMetadata, functionState.project, functionState.session),
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
