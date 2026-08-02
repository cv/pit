import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { confirmAndWaitForIdle } from "./control-command-utils.js";

export function registerRuntimeControlCommands(pi: ExtensionAPI): void {
  pi.registerCommand("pit-reload-runtime", {
    description: "Reload Pi resources after confirmation",
    handler: async (_args, ctx) => {
      if (
        !(await confirmAndWaitForIdle(
          ctx,
          "Reload Pi resources?",
          "Reload extensions, skills, prompts, themes, and context files?",
        ))
      ) {
        return;
      }
      await ctx.reload();
      return;
    },
  });
  pi.registerCommand("pit-shutdown", {
    description: "Gracefully stop Pi after confirmation",
    handler: async (_args, ctx) => {
      if (
        !(await confirmAndWaitForIdle(
          ctx,
          "Shut down Pi?",
          "Gracefully stop Pi after pending work completes?",
        ))
      ) {
        return;
      }
      ctx.shutdown();
    },
  });
}
