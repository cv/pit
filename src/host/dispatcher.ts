import { AsyncLocalStorage } from "node:async_hooks";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ContextEditQueue } from "../context/queue.js";
import type { CompletedCallJournal, RecoverableCallStore } from "../execution/completed-calls.js";
import type { HostShellProgressEvent, ShellProgressEvent } from "../execution/types.js";
import { type FunctionActivity, functionRunScope } from "../functions/core.js";
import {
  globalFunctionDefinitions,
  type NativeMethod,
  type NativeNamespace,
  validateNativeCall,
} from "../functions/globals.js";
import { createFunctionHostHandler } from "../functions/host-handler.js";
import { isPiToolNamespace } from "../functions/pi-tools.js";
import type { FunctionState, FunctionStateCommit } from "../functions/state.js";
import { createProcessRunner, formatProcessCommand } from "../process/runner.js";
import type { HostCallHandler } from "../sandbox/dispatcher.js";
import {
  boundedIntegerValue as boundedInteger,
  recordValue as object,
  stringValue as string,
  stringArrayValue as stringArray,
} from "../shared/argument-values.js";
import { completeUtf8Length, LIMITS } from "../shared/bounds.js";
import { handleWorkspace } from "../workspace/host-handler.js";
import type { ImageCollector } from "../workspace/view-image.js";
import { createCommandsHostHandler } from "./handlers/commands.js";
import { createModelsHostHandler } from "./handlers/models.js";
import { callPiTool, type PiToolCallServices } from "./handlers/pi-tools.js";
import { createRuntimeHostHandler } from "./handlers/runtime.js";
import { createSessionHostHandler } from "./handlers/session.js";

// One storage instance; each host dispatch owns its async scope, including overlapping tools.
const processTraceContext = new AsyncLocalStorage<number | undefined>();

type NativeFunctionHandler = (
  method: string,
  args: unknown[],
  signal: AbortSignal,
) => unknown | Promise<unknown>;

type HostMethodHandler = (args: unknown[], signal: AbortSignal) => unknown | Promise<unknown>;

async function readHttpBody(
  response: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) {
    return { body: "", truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const remaining = maxBytes - bytes;
    if (value.byteLength > remaining) {
      chunks.push(Buffer.from(value.subarray(0, remaining)));
      bytes += Math.max(0, remaining);
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(Buffer.from(value));
    bytes += value.byteLength;
    if (bytes === maxBytes) {
      const next = await reader.read();
      if (!next.done) {
        truncated = true;
        await reader.cancel();
      }
      break;
    }
  }
  const body = Buffer.concat(chunks, bytes);
  // A byte cut can end inside a character; return only complete characters.
  const complete = truncated ? body.subarray(0, completeUtf8Length(body)) : body;
  return { body: complete.toString("utf8"), truncated };
}

const PROMOTION_SUGGESTION_RUNS = 5;
const TEMPORARY_FUNCTION_NAME = /(?:smoke|scratch|temp|tmp|debug|test)/i;

export interface HostServices {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  functionState: FunctionState;
  commitFunctionState: FunctionStateCommit;
  activity: FunctionActivity[];
  onShellProgress?: (event: ShellProgressEvent) => void;
  promotionSuggestions: string[];
  /** Collects the images this invocation's workspace.viewImage calls attach to its result. */
  images: ImageCollector;
  /** Pi tools this invocation may call through `tools.*`; absent when none are callable. */
  toolCalls?: PiToolCallServices;
  /** The tool call running this program; its turn is protected from context edits. */
  toolCallId?: string;
  /** Context edits staged by the running turn. */
  contextEdits?: ContextEditQueue;
  /** Records the results of this program's completed calls, kept if the program fails. */
  completedCalls?: CompletedCallJournal;
  /** Journals of recent failed programs, read by `runtime.completedCalls`. */
  recoverableCalls?: RecoverableCallStore;
}

interface ProcessHostHandlers {
  withTrace<T>(sequence: number | undefined, operation: () => T): T;
  shell: Record<NativeMethod<"shell">, HostMethodHandler>;
}

function createProcessHostHandlers(input: {
  pi: ExtensionAPI;
  cwd: string;
  onShellProgress?: (event: ShellProgressEvent) => void;
}): ProcessHostHandlers {
  const processRunner = createProcessRunner(input.pi, input.cwd);
  let nextShellProgressId = 1;
  const progressFor = (command: string) => {
    const id = nextShellProgressId++;
    const traceSequence = processTraceContext.getStore();
    return input.onShellProgress
      ? (event: HostShellProgressEvent) =>
          input.onShellProgress?.({
            id,
            command,
            ...event,
            ...(traceSequence === undefined ? {} : { traceSequence }),
          })
      : undefined;
  };
  const run = (
    program: string,
    args: string[],
    options: Record<string, unknown>,
    signal: AbortSignal,
  ) => {
    const command = formatProcessCommand(program, args);
    const progress = progressFor(command);
    return processRunner.run({
      program,
      args,
      displayCommand: command,
      options,
      ...(progress ? { onProgress: progress } : {}),
      signal,
    });
  };
  return {
    withTrace: (sequence, operation) => processTraceContext.run(sequence, operation),
    shell: {
      exec: (args, signal) => {
        const command = string(args[0], "command");
        const options = args[1] === undefined ? {} : object(args[1], "options");
        const progress = progressFor(command);
        return processRunner.run({
          program: "/bin/sh",
          args: ["-lc", command],
          displayCommand: command,
          options,
          ...(progress ? { onProgress: progress } : {}),
          signal,
        });
      },
      execFile: (args, signal) => {
        const program = string(args[0], "program");
        const processArgs = stringArray(args[1], "args");
        const options = args[2] === undefined ? {} : object(args[2], "options");
        return run(program, processArgs, options, signal);
      },
    },
  };
}

/**
 * A program's dialogs end with its call: the call's signal dismisses them on cancellation, at the
 * deadline, or on a session change.
 */
function createUiHandlers(ctx: ExtensionContext): Record<NativeMethod<"ui">, HostMethodHandler> {
  return {
    confirm: (args, signal) =>
      ctx.ui.confirm(string(args[0], "title"), string(args[1], "message"), { signal }),
    input: (args, signal) =>
      ctx.ui.input(
        string(args[0], "title"),
        args[1] === undefined ? undefined : string(args[1], "placeholder"),
        { signal },
      ),
    select: (args, signal) => {
      if (!Array.isArray(args[1])) {
        throw new Error("options must be an array");
      }
      return ctx.ui.select(string(args[0], "title"), args[1].map(String), { signal });
    },
    notify: (args) => {
      ctx.ui.notify(
        string(args[0], "message"),
        (args[1] as "info" | "warning" | "error" | undefined) ?? "info",
      );
      return null;
    },
  };
}

export function createHostDispatcher({
  pi,
  ctx,
  functionState,
  commitFunctionState,
  activity,
  promotionSuggestions,
  onShellProgress,
  images,
  toolCalls,
  toolCallId,
  contextEdits,
  completedCalls,
  recoverableCalls,
}: HostServices): HostCallHandler {
  const processHandlers = createProcessHostHandlers({
    pi,
    cwd: ctx.cwd,
    ...(onShellProgress ? { onShellProgress } : {}),
  });
  const shellHandlers = processHandlers.shell;

  const uiHandlers = createUiHandlers(ctx);

  const publicHandlers: Record<NativeNamespace, NativeFunctionHandler> = {
    workspace: (method, args, signal) =>
      handleWorkspace({ cwd: ctx.cwd, images }, method, args, signal),
    shell: (method, args, signal) => shellHandlers[method as NativeMethod<"shell">](args, signal),
    http: async (_method, args, signal) => {
      const url = string(args[0], "url");
      const options = args[1] === undefined ? {} : object(args[1], "options");
      const maxBytes = boundedInteger(options.maxBytes, "options.maxBytes", {
        maximum: LIMITS.httpBody.maxBytes,
        fallback: LIMITS.httpBody.maxBytes,
      });
      const response = await fetch(url, {
        ...(options.method === undefined ? {} : { method: string(options.method, "method") }),
        ...(options.headers === undefined
          ? {}
          : { headers: options.headers as Record<string, string> }),
        ...(options.body === undefined ? {} : { body: string(options.body, "body") }),
        signal,
      });
      const body = await readHttpBody(response, maxBytes);
      return {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers),
        body: body.body,
        truncated: body.truncated,
      };
    },
    ui: (method, args, signal) => {
      if (!ctx.hasUI) {
        throw new Error("UI is not available in this mode");
      }
      return uiHandlers[method as NativeMethod<"ui">](args, signal);
    },
    context: () => ({
      cwd: ctx.cwd,
      mode: ctx.mode,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      thinkingLevel: ctx.thinkingLevel,
      sessionFile: ctx.sessionManager.getSessionFile(),
      savedFunctions: [...functionState.effective.keys()].sort(),
      globalFunctions: globalFunctionDefinitions()
        .map((definition) => definition.id)
        .sort(),
      userFunctions: [...functionState.user.keys()].sort(),
      projectFunctions: [...functionState.project.keys()].sort(),
      sessionFunctions: [...functionState.session.keys()].sort(),
      projectFunctionsEnabled: functionState.projectEnabled,
    }),
    functions: createFunctionHostHandler({
      pi,
      ctx,
      functionState,
      commitFunctionState,
      activity,
    }),
    session: createSessionHostHandler({
      pi,
      ctx,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(contextEdits ? { contextEdits } : {}),
    }),
    commands: createCommandsHostHandler({ pi }),
    models: createModelsHostHandler({ pi, ctx }),
    runtime: createRuntimeHostHandler({
      pi,
      ctx,
      ...(recoverableCalls ? { recoverableCalls } : {}),
    }),
  };

  return ({ namespace, method, args, signal, functionContext, traceSequence }) =>
    processHandlers.withTrace(traceSequence, () => {
      if (namespace === "__pit" && method === "savedFunctionRun") {
        const name = string(args[0], "saved function name");
        if (!functionState.effective.has(name)) {
          throw new Error(`Saved function "${name}" is unavailable`);
        }
        const scope = functionRunScope(
          name,
          {
            user: functionState.user,
            project: functionState.project,
            session: functionState.session,
          },
          functionContext?.scope,
        );
        activity.push({ action: "run", name, scope });
        if (
          scope === "session" &&
          !functionState.project.has(name) &&
          !functionState.user.has(name) &&
          !TEMPORARY_FUNCTION_NAME.test(name)
        ) {
          const runs = (functionState.sessionRunCounts.get(name) ?? 0) + 1;
          functionState.sessionRunCounts.set(name, runs);
          if (runs >= PROMOTION_SUGGESTION_RUNS && !functionState.promotionSuggested.has(name)) {
            functionState.promotionSuggested.add(name);
            promotionSuggestions.push(name);
          }
        }
        return null;
      }

      const result = isPiToolNamespace(namespace)
        ? (() => {
            /* v8 ignore next -- validation rejects tools.* when the call has no callable tools. */
            if (!toolCalls) throw new Error(`Unknown host function: ${namespace}.${method}`);
            return callPiTool(toolCalls, { namespace, method, args, signal });
          })()
        : (() => {
            validateNativeCall(namespace, method, args);
            return publicHandlers[namespace as NativeNamespace](method, args, signal);
          })();
      if (!completedCalls) return result;
      return Promise.resolve(result).then((value) => {
        // A call that settles after its program was cancelled or timed out was interrupted, not
        // completed: the process runner, for example, reports an aborted command as exit 130.
        if (!signal.aborted) completedCalls.record(traceSequence, `${namespace}.${method}`, value);
        return value;
      });
    });
}
