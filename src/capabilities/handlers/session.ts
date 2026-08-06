import { stringValue as string } from "../../cli.js";
import type { PiControlServices } from "./services.js";

type SessionCapabilityHandler = (method: string, args: unknown[]) => unknown | Promise<unknown>;

export function createSessionCapabilityHandler({
  pi,
  ctx,
}: PiControlServices): SessionCapabilityHandler {
  return (method, args) => {
    if (method === "info") {
      const usage = ctx.getContextUsage();
      return {
        id: ctx.sessionManager.getSessionId(),
        file: ctx.sessionManager.getSessionFile(),
        name: pi.getSessionName(),
        leafId: ctx.sessionManager.getLeafId(),
        entryCount: ctx.sessionManager.getEntries().length,
        branchEntryCount: ctx.sessionManager.getBranch().length,
        contextTokens: usage?.tokens,
        contextWindow: usage?.contextWindow,
        contextPercent: usage?.percent,
      };
    }
    if (method === "getName") {
      return pi.getSessionName();
    }
    if (method === "setName") {
      const name = string(args[0], "session name").trim();
      if (!name) {
        throw new Error("Session name must not be empty");
      }
      pi.setSessionName(name);
      return { name };
    }
    if (method === "compact") {
      const instructions =
        args[0] === undefined ? undefined : string(args[0], "compaction instructions").trim();
      return new Promise((resolve, reject) => {
        ctx.compact({
          ...(instructions ? { customInstructions: instructions } : {}),
          onComplete: (result) =>
            resolve({
              firstKeptEntryId: result.firstKeptEntryId,
              tokensBefore: result.tokensBefore,
              estimatedTokensAfter: result.estimatedTokensAfter,
            }),
          onError: reject,
        });
      });
    }
  };
}
