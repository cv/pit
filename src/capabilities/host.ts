import { AsyncLocalStorage } from "node:async_hooks";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { HostShellProgressEvent, ShellProgressEvent } from "../execution/types.js";
import { createFunctionCapabilityHandler } from "../functions/capability-handler.js";
import { type FunctionActivity, functionRunScope } from "../functions/core.js";
import { globalFunctionDefinitions } from "../functions/definitions.js";
import type { FunctionState, FunctionStateCommit } from "../functions/state.js";
import { createProcessRunner, formatProcessCommand } from "../process/runner.js";
import type { CapabilityHandler } from "../sandbox/dispatcher.js";
import {
  boundedIntegerValue as boundedInteger,
  recordValue as object,
  stringValue as string,
  stringArrayValue as stringArray,
} from "../shared/argument-values.js";
import { completeUtf8Length, LIMITS } from "../shared/bounds.js";
import { handleWorkspace } from "../workspace/capability.js";
import { createCommandsCapabilityHandler } from "./handlers/commands.js";
import { prepareGhCommand } from "./handlers/gh.js";
import { createModelsCapabilityHandler } from "./handlers/models.js";
import { prepareNpmCommand } from "./handlers/npm.js";
import { createRuntimeCapabilityHandler } from "./handlers/runtime.js";
import { createSessionCapabilityHandler } from "./handlers/session.js";
import {
  type CAPABILITY_METHODS,
  type CapabilityName,
  validateCapabilityCall,
} from "./registry.js";

// One storage instance; each host dispatch owns its async scope, including overlapping tools.
const processTraceContext = new AsyncLocalStorage<number | undefined>();

type PublicCapabilityHandler = (
  method: string,
  args: unknown[],
  signal: AbortSignal,
) => unknown | Promise<unknown>;

type CapabilityMethodName<Name extends CapabilityName> = (typeof CAPABILITY_METHODS)[Name][number];

type CapabilityMethodHandler = (args: unknown[], signal: AbortSignal) => unknown | Promise<unknown>;

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

export interface HostCapabilityServices {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  functionState: FunctionState;
  commitFunctionState: FunctionStateCommit;
  activity: FunctionActivity[];
  onShellProgress?: (event: ShellProgressEvent) => void;
  promotionSuggestions: string[];
}

interface ProcessCapabilityHandlers {
  withTrace<T>(sequence: number | undefined, operation: () => T): T;
  shell: Record<CapabilityMethodName<"shell">, CapabilityMethodHandler>;
  run(
    program: string,
    args: string[],
    options: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

function createProcessCapabilityHandlers(input: {
  pi: ExtensionAPI;
  cwd: string;
  onShellProgress?: (event: ShellProgressEvent) => void;
}): ProcessCapabilityHandlers {
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
    run,
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
function createUiHandlers(
  ctx: ExtensionContext,
): Record<CapabilityMethodName<"ui">, CapabilityMethodHandler> {
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

export function createCapabilities({
  pi,
  ctx,
  functionState,
  commitFunctionState,
  activity,
  promotionSuggestions,
  onShellProgress,
}: HostCapabilityServices): CapabilityHandler {
  const processHandlers = createProcessCapabilityHandlers({
    pi,
    cwd: ctx.cwd,
    ...(onShellProgress ? { onShellProgress } : {}),
  });
  const runArgumentSafeProcess = processHandlers.run;
  const shellHandlers = processHandlers.shell;

  const uiHandlers = createUiHandlers(ctx);

  const publicHandlers: Record<CapabilityName, PublicCapabilityHandler> = {
    workspace: (method, args, signal) => handleWorkspace(ctx.cwd, method, args, signal),
    shell: (method, args, signal) =>
      shellHandlers[method as CapabilityMethodName<"shell">](args, signal),
    git: (method, args, signal) => {
      const gitArgs = args[0] === undefined ? [] : stringArray(args[0], "args");
      const options = args[1] === undefined ? {} : object(args[1], "options");
      return runArgumentSafeProcess("git", [method, ...gitArgs], options, signal);
    },
    npm: (method, args, signal) => {
      const command = prepareNpmCommand(method as Parameters<typeof prepareNpmCommand>[0], args);
      return runArgumentSafeProcess("npm", command.args, command.options, signal);
    },
    gh: (method, args, signal) => {
      const command = prepareGhCommand(method as Parameters<typeof prepareGhCommand>[0], args);
      return runArgumentSafeProcess("gh", command.args, command.options, signal);
    },
    http: async (_method, args, signal) => {
      const url = string(args[0], "url");
      const options = args[1] === undefined ? {} : object(args[1], "options");
      const maxBytes = boundedInteger(
        options.maxBytes,
        "options.maxBytes",
        LIMITS.httpBody.maxBytes,
        LIMITS.httpBody.maxBytes,
      );
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
      return uiHandlers[method as CapabilityMethodName<"ui">](args, signal);
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
    functions: createFunctionCapabilityHandler({
      pi,
      ctx,
      functionState,
      commitFunctionState,
      activity,
    }),
    session: createSessionCapabilityHandler({ pi, ctx }),
    commands: createCommandsCapabilityHandler({ pi }),
    models: createModelsCapabilityHandler({ pi, ctx }),
    runtime: createRuntimeCapabilityHandler({ pi, ctx }),
  };

  return ({ capability, method, args, signal, functionContext, traceSequence }) =>
    processHandlers.withTrace(traceSequence, () => {
      if (capability === "__pit" && method === "savedFunctionRun") {
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

      validateCapabilityCall(capability, method, args);
      return publicHandlers[capability as CapabilityName](method, args, signal);
    });
}
