import type { PiControlServices } from "./pi-control-services.js";

type RuntimeCapabilityHandler = (method: string) => unknown | Promise<unknown>;

export function createRuntimeCapabilityHandler({
  pi,
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
    if (method === "requestReload") {
      const command = "/pit-reload-runtime";
      pi.sendUserMessage(command, { deliverAs: "followUp" });
      return { queued: true as const, command };
    }
    if (method === "requestShutdown") {
      const command = "/pit-shutdown";
      pi.sendUserMessage(command, { deliverAs: "followUp" });
      return { queued: true as const, command };
    }
  };
}
