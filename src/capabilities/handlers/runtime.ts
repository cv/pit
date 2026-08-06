import type { PiControlServices } from "./services.js";

type RuntimeCapabilityHandler = (method: string) => unknown | Promise<unknown>;

export function createRuntimeCapabilityHandler({
  ctx,
}: PiControlServices): RuntimeCapabilityHandler {
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
