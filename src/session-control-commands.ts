import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

async function confirmReplacement(
  ctx: ExtensionCommandContext,
  title: string,
  message: string,
): Promise<boolean> {
  const confirmed = await ctx.ui.confirm(title, message);
  if (confirmed) {
    await ctx.waitForIdle();
  }
  return confirmed;
}

async function forkSession(
  ctx: ExtensionCommandContext,
  entryId: string,
  position: "before" | "at",
): Promise<void> {
  const action = position === "before" ? "Fork" : "Clone";
  if (!entryId) {
    ctx.ui.notify(`${action} requires an entry ID`, "error");
    return;
  }
  if (
    !(await confirmReplacement(
      ctx,
      `${action} from ${entryId}?`,
      `${action} the session at this entry and replace the active session?`,
    ))
  ) {
    return;
  }
  await ctx.fork(entryId, { position });
}

export function registerSessionControlCommands(pi: ExtensionAPI): void {
  pi.registerCommand("pit-new-session", {
    description: "Start a confirmed new session",
    handler: async (_args, ctx) => {
      if (
        !(await confirmReplacement(
          ctx,
          "Start a new session?",
          "Replace the active session with a new session?",
        ))
      ) {
        return;
      }
      const parentSession = ctx.sessionManager.getSessionFile();
      await ctx.newSession(parentSession ? { parentSession } : {});
    },
  });
  pi.registerCommand("pit-fork-session", {
    description: "Fork before a session entry after confirmation",
    handler: async (args, ctx) => forkSession(ctx, args.trim(), "before"),
  });
  pi.registerCommand("pit-clone-session", {
    description: "Clone through a session entry after confirmation",
    handler: async (args, ctx) => forkSession(ctx, args.trim(), "at"),
  });
}
