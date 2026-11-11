import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ContextEditQueue } from "../context/queue.js";
import type { RecoverableCallStore } from "../execution/completed-calls.js";
import type { HostCallHandler } from "../sandbox/dispatcher.js";
import { createCommandsHostHandler } from "./handlers/commands.js";
import { createModelsHostHandler } from "./handlers/models.js";
import { callPiTool, type PiToolCallServices } from "./handlers/pi-tools.js";
import { createRuntimeHostHandler } from "./handlers/runtime.js";
import { createSessionHostHandler } from "./handlers/session.js";
import { createNativeHostDispatcher, type NativeHostServices } from "./native-dispatcher.js";

interface HostServices extends NativeHostServices {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  /** Pi tools this invocation may call through `tools.*`; absent when none are callable. */
  toolCalls?: PiToolCallServices;
  /** The tool call running this program; its turn is protected from context edits. */
  toolCallId?: string;
  /** Context edits staged by the running turn. */
  contextEdits?: ContextEditQueue;
  /** Journals of recent failed programs, read by `runtime.completedCalls`. */
  recoverableCalls?: RecoverableCallStore;
}

/** Dispatches a program's host calls on Pi: its session, commands, models, runtime, and tools. */
export function createHostDispatcher(services: HostServices): HostCallHandler {
  const { pi, ctx, images, toolCalls, toolCallId, contextEdits, recoverableCalls } = services;
  return createNativeHostDispatcher(services, {
    session: createSessionHostHandler({
      pi,
      ctx,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(contextEdits ? { contextEdits } : {}),
    }),
    commands: createCommandsHostHandler({ pi }),
    models: createModelsHostHandler({ pi, ctx, loadImage: images.load }),
    runtime: createRuntimeHostHandler({
      pi,
      ctx,
      ...(recoverableCalls ? { recoverableCalls } : {}),
    }),
    ...(toolCalls ? { tools: (call) => callPiTool(toolCalls, call) } : {}),
  });
}
