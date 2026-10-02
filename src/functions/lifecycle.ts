import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatPitSkillsForPrompt } from "../skill-prompt.js";
import { reconstructFunctions } from "./core.js";
import { functionRelativePath } from "./identifier.js";
import { registerFunctionManager } from "./manager.js";
import { userFunctionCatalog, projectFunctionCatalog } from "./persistent-functions.js";
import type { SavedFunctionService } from "./service.js";
import type { FunctionState } from "./state.js";
import { reconcileFunctionState, resetFunctionUsage, stateFunctionEnvironment } from "./state.js";
import { loadPitProjectConfig, loadProjectFunctions } from "./storage/project.js";
import { userFunctionDirectory, userFunctionPath, loadUserFunctions } from "./storage/user.js";
import {
  activatePitTools,
  compileToolPatterns,
  supportsToolLoadouts,
  type PitToolSelection,
} from "./tool-loadout.js";

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
    invalidUser: functionState.invalidUser,
    invalidProject: functionState.invalidProject,
    toolCatalog: () => functionState.toolCatalog,
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

function registerFunctionLifecycle(
  pi: ExtensionAPI,
  functionState: FunctionState,
  selection: PitToolSelection,
): void {
  pi.on("session_start", async (_event, ctx) => {
    resetFunctionUsage(functionState);
    const projectConfig = await loadPitProjectConfig(ctx);
    const errors = await loadUserFunctions(
      functionState.user,
      functionState.userMetadata,
      functionState.invalidUser,
    );
    // Project functions load in every trusted project; loadProjectFunctions checks trust.
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
    // Resolved at session start; configuration edits apply after /reload.
    selection.allowedTools = compileToolPatterns(projectConfig.allowedTools ?? []);
    activatePitTools(pi, selection);
    if (ctx.hasUI && !supportsToolLoadouts(pi)) {
      ctx.ui.notify(
        "Pit requires Pi 0.99 or newer. This Pi version cannot hide other tools, so the model sees them beside typescript. Update Pi with `pi update`.",
        "warning",
      );
    }
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
    // Pi restores the destination branch's recorded tools before this event. A branch recorded
    // before Pit or an allowedTools change can lack them; add them back without deactivating tools
    // other extensions activated.
    activatePitTools(pi, selection);
  });
  pi.on("before_agent_start", (event) => {
    // Pi renders its own list only while a file-reading tool is selected, and an earlier handler
    // can replace the prompt entirely, so the rendered prompt is the reliable record.
    const promptAlreadyHasSkills = event.systemPrompt.includes("<available_skills>");
    const sections = Object.entries({
      pit_skills: promptAlreadyHasSkills
        ? ""
        : formatPitSkillsForPrompt(event.systemPromptOptions?.skills ?? []),
      pit_user_functions: userFunctionCatalog(
        functionState.userMetadata,
        functionState.project,
        functionState.session,
      ),
      pit_project_functions: projectFunctionCatalog(functionState.metadata, functionState.session),
    }).filter(([, content]) => content);
    const options = event.systemPromptOptions;
    if (options?.sections && options.forceSystemPrompt === undefined) {
      // Pi records section changes as transcript deltas, so a catalog change patches one section
      // and keeps the cached prompt prefix. An empty section stays unset, and Pi records its removal.
      for (const [name, content] of sections) {
        options.sections[name] = content;
      }
    } else if (sections.length > 0) {
      // An earlier handler replaced the prompt, or Pi predates prompt sections (0.86). Pi then sends
      // only the replacement text, so Pit's additions must extend it.
      const additions = sections.map(([, content]) => content).join("\n\n");
      return { systemPrompt: `${event.systemPrompt}\n\n${additions}` };
    }
  });
}

export function registerSavedFunctionFeatures(
  pi: ExtensionAPI,
  functionState: FunctionState,
  savedFunctionService: SavedFunctionService,
  toolSelection: PitToolSelection,
): void {
  registerSavedFunctionManager({ pi, functionState, savedFunctionService });
  registerFunctionLifecycle(pi, functionState, toolSelection);
}
