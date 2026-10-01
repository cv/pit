import type { RecoverableCallStore } from "../../execution/completed-calls.js";
import { boundedIntegerValue, recordValue, stringValue } from "../../shared/argument-values.js";
import type { PiControlServices } from "./services.js";

type RuntimeHostHandler = (method: string, args: unknown[]) => unknown | Promise<unknown>;

export function createRuntimeHostHandler({
  ctx,
  recoverableCalls,
}: PiControlServices & { recoverableCalls?: RecoverableCallStore }): RuntimeHostHandler {
  return (method, args) => {
    if (method === "status") {
      return {
        mode: ctx.mode,
        idle: ctx.isIdle(),
        pendingMessages: ctx.hasPendingMessages(),
      };
    }
    if (method === "completedCalls") {
      const toolCallId = stringValue(args[0], "toolCallId");
      const options = args[1] === undefined ? {} : recordValue(args[1], "options");
      const sequence =
        options.sequence === undefined
          ? undefined
          : boundedIntegerValue(options.sequence, "options.sequence", {
              maximum: Number.MAX_SAFE_INTEGER,
              fallback: 1,
            });
      /* v8 ignore next -- the TypeScript tool always provides the store. */
      if (!recoverableCalls) throw new Error("Recoverable calls are unavailable");
      return recoverableCalls.read(toolCallId, sequence);
    }
  };
}
