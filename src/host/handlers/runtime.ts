import type { PiControlServices } from "./services.js";

type RuntimeHostHandler = (method: string) => unknown | Promise<unknown>;

export function createRuntimeHostHandler({ ctx }: PiControlServices): RuntimeHostHandler {
  return (method) => {
    if (method === "status") {
      return {
        mode: ctx.mode,
        idle: ctx.isIdle(),
        pendingMessages: ctx.hasPendingMessages(),
      };
    }
  };
}
