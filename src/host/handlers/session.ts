import { cacheState } from "../../context/cache-state.js";
import { stringValue as string } from "../../shared/argument-values.js";
import { createSessionContextHandlers, type SessionContextServices } from "./session-context.js";
import { createSessionEditHandlers } from "./session-edits.js";

type SessionHostHandler = (method: string, args: unknown[]) => unknown | Promise<unknown>;

export function createSessionHostHandler(services: SessionContextServices): SessionHostHandler {
  const { pi, ctx } = services;
  const contextHandlers = {
    ...createSessionContextHandlers(services),
    ...createSessionEditHandlers(services),
  };
  return (method, args) => {
    const contextHandler = contextHandlers[method];
    if (contextHandler) {
      return contextHandler(args);
    }
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
        cache: cacheState(ctx.sessionManager.getBranch(), ctx.model),
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
