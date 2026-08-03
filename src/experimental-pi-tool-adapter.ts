import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  AgentSession,
  type AgentToolResult,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type {
  PiToolErrorKind,
  PiToolExecutionApi,
  PiToolExecutionOptions,
  PiToolExecutionResult,
  PiToolScope,
} from "./pi-tool-api.js";

const SESSION_CAPTURE = Symbol.for("@pit/pi-tool-session-capture");
const TOOL_EXECUTION_STACK = new AsyncLocalStorage<readonly string[]>();
const MAX_TOOL_EXECUTION_DEPTH = 16;

interface CaptureState {
  current?: AgentSession;
  promptPatched?: boolean;
}

type CapturedPrototype = typeof AgentSession.prototype & {
  [SESSION_CAPTURE]?: CaptureState;
};

interface ValidationTool {
  name: string;
  parameters: Record<PropertyKey, unknown>;
}

interface ValidationToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

type ToolValidator = (tool: ValidationTool, toolCall: ValidationToolCall) => unknown;

let validatorPromise: Promise<ToolValidator> | undefined;

function toolValidator(): Promise<ToolValidator> {
  validatorPromise ??= (async () => {
    const packageName = "@earendil-works/pi-ai";
    try {
      const module = await import(packageName);
      return module.validateToolArguments as ToolValidator;
    } catch {
      const codingAgentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
      const bundledValidation = new URL(
        "../node_modules/@earendil-works/pi-ai/dist/utils/validation.js",
        codingAgentEntry,
      );
      const module = await import(bundledValidation.href);
      return module.validateToolArguments as ToolValidator;
    }
  })();
  return validatorPromise;
}
type ExecutableTool = ValidationTool & {
  prepareArguments?: (args: unknown) => unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
  ): Promise<AgentToolResult<unknown>>;
};

type InternalAgentSession = {
  _toolRegistry: Map<string, ExecutableTool>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolScope(value: unknown): PiToolScope {
  if (value === undefined) {
    return "active";
  }
  if (value !== "active" && value !== "registered") {
    throw new TypeError('Tool scope must be "active" or "registered"');
  }
  return value;
}

function errorResult(
  toolCallId: string,
  message: string,
  errorKind: PiToolErrorKind,
): PiToolExecutionResult {
  return {
    toolCallId,
    content: [{ type: "text", text: message }],
    details: {},
    isError: true,
    errorKind,
  };
}

async function emitEnd(input: {
  session: AgentSession;
  toolCallId: string;
  toolName: string;
  result: AgentToolResult<unknown>;
  isError: boolean;
  errorKind?: PiToolErrorKind;
}): Promise<PiToolExecutionResult> {
  await input.session.extensionRunner.emit({
    type: "tool_execution_end",
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    result: input.result,
    isError: input.isError,
  });
  return {
    ...input.result,
    content: input.result.content ?? [],
    toolCallId: input.toolCallId,
    isError: input.isError,
    ...(input.errorKind ? { errorKind: input.errorKind } : {}),
  };
}

async function dispatchToolCall(input: {
  session: AgentSession;
  tool: ExecutableTool;
  name: string;
  rawArgs: Record<string, unknown>;
  options: PiToolExecutionOptions;
}): Promise<PiToolExecutionResult> {
  const { session, tool, name, rawArgs, options } = input;
  const toolCallId = `pit:${randomUUID()}`;
  await session.extensionRunner.emit({
    type: "tool_execution_start",
    toolCallId,
    toolName: name,
    args: rawArgs,
  });
  const finish = (
    finalResult: AgentToolResult<unknown>,
    finalIsError: boolean,
    finalErrorKind?: PiToolErrorKind,
  ) =>
    emitEnd({
      session,
      toolCallId,
      toolName: name,
      result: finalResult,
      isError: finalIsError,
      ...(finalErrorKind ? { errorKind: finalErrorKind } : {}),
    });

  let validatedArgs: Record<string, unknown>;
  try {
    const preparedArgs = (
      tool.prepareArguments ? tool.prepareArguments(rawArgs) : rawArgs
    ) as Record<string, unknown>;
    const validationCall: ValidationToolCall = {
      type: "toolCall",
      id: toolCallId,
      name,
      arguments: preparedArgs,
    };
    const validateToolArguments = await toolValidator();
    validatedArgs = validateToolArguments(tool, validationCall) as Record<string, unknown>;
  } catch (error) {
    return await finish(
      errorResult(toolCallId, errorMessage(error), "validation"),
      true,
      "validation",
    );
  }

  try {
    const runner = session.extensionRunner;
    if (runner.hasHandlers("tool_call")) {
      const beforeResult = await runner.emitToolCall({
        type: "tool_call",
        toolName: name,
        toolCallId,
        input: validatedArgs,
      });
      if (options.signal?.aborted) {
        return await finish(
          errorResult(toolCallId, "Operation aborted", "aborted"),
          true,
          "aborted",
        );
      }
      if (beforeResult?.block) {
        return await finish(
          errorResult(toolCallId, beforeResult.reason || "Tool execution was blocked", "blocked"),
          true,
          "blocked",
        );
      }
    }
  } catch (error) {
    return await finish(errorResult(toolCallId, errorMessage(error), "hook"), true, "hook");
  }
  if (options.signal?.aborted) {
    return await finish(errorResult(toolCallId, "Operation aborted", "aborted"), true, "aborted");
  }

  const updateEvents: Promise<unknown>[] = [];
  let acceptingUpdates = true;
  let result: AgentToolResult<unknown>;
  let isError = false;
  let errorKind: PiToolErrorKind | undefined;
  try {
    result = await tool.execute(
      toolCallId,
      validatedArgs,
      options.signal,
      (partialResult: AgentToolResult<unknown>) => {
        if (!acceptingUpdates) {
          return;
        }
        const context = { toolCallId };
        updateEvents.push(
          Promise.allSettled([
            Promise.resolve().then(() =>
              session.extensionRunner.emit({
                type: "tool_execution_update",
                toolCallId,
                toolName: name,
                args: rawArgs,
                partialResult,
              }),
            ),
            Promise.resolve().then(() => options.onUpdate?.(partialResult, context)),
          ]),
        );
      },
    );
  } catch (error) {
    errorKind = options.signal?.aborted ? "aborted" : "execution";
    result = errorResult(
      toolCallId,
      errorKind === "aborted" ? "Operation aborted" : errorMessage(error),
      errorKind,
    );
    isError = true;
  } finally {
    acceptingUpdates = false;
    await Promise.all(updateEvents);
  }

  const runner = session.extensionRunner;
  if (runner.hasHandlers("tool_result")) {
    try {
      const afterResult = await runner.emitToolResult({
        type: "tool_result",
        toolName: name,
        toolCallId,
        input: validatedArgs,
        content: result.content,
        details: result.details,
        isError,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      });
      if (afterResult) {
        const usage = afterResult.usage ?? result.usage;
        result = {
          ...result,
          content: afterResult.content ?? result.content,
          details: afterResult.details ?? result.details,
          ...(usage === undefined ? {} : { usage }),
        };
        isError = afterResult.isError ?? isError;
      }
    } catch (error) {
      result = errorResult(toolCallId, errorMessage(error), "hook");
      isError = true;
      errorKind = "hook";
    }
  }

  return await finish(result, isError, errorKind);
}

function captureSession(): () => AgentSession | undefined {
  const prototype = AgentSession.prototype as CapturedPrototype;
  let state = prototype[SESSION_CAPTURE];
  if (!state) {
    const captureState: CaptureState = {};
    state = captureState;
    Object.defineProperty(prototype, SESSION_CAPTURE, { value: captureState });
    const originalBindExtensions = prototype.bindExtensions;
    prototype.bindExtensions = async function (bindings): Promise<void> {
      await originalBindExtensions.call(this, bindings);
      captureState.current = this;
    };
  }
  const captureState = state;
  if (!captureState.promptPatched) {
    captureState.promptPatched = true;
    const originalPrompt = prototype.prompt;
    prototype.prompt = async function (text, options): Promise<void> {
      captureState.current = this;
      await originalPrompt.call(this, text, options);
    };
  }
  return () => captureState.current;
}

export function createExperimentalPiToolApi(
  pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
  getSession: () => AgentSession | undefined,
): PiToolExecutionApi {
  const requireSession = (): AgentSession => {
    const session = getSession();
    if (!session) {
      throw new Error(
        "Experimental Pi tool execution is unavailable before the agent session is bound",
      );
    }
    return session;
  };
  const toolError = (name: string, scope: PiToolScope): PiToolExecutionResult | undefined => {
    const toolCallId = `pit:${randomUUID()}`;
    const registered = pi.getAllTools().some((tool) => tool.name === name);
    if (!registered) {
      return errorResult(toolCallId, `Tool ${name} not found`, "not_found");
    }
    if (scope === "active" && !pi.getActiveTools().includes(name)) {
      return errorResult(toolCallId, `Tool ${name} is not active`, "inactive");
    }
  };
  return {
    listTools: ({ scope: requestedScope } = {}) => {
      const scope = toolScope(requestedScope);
      const active = new Set(pi.getActiveTools());
      return pi
        .getAllTools()
        .map((tool) => ({ ...tool, active: active.has(tool.name) }))
        .filter((tool) => scope === "registered" || tool.active);
    },
    executeTool: async (name, args, options = {}) => {
      const scope = toolScope(options.scope);
      const unavailable = toolError(name, scope);
      if (unavailable) {
        return unavailable;
      }
      const stack = TOOL_EXECUTION_STACK.getStore() ?? [];
      if (stack.includes(name) || stack.length >= MAX_TOOL_EXECUTION_DEPTH) {
        return errorResult(
          `pit:${randomUUID()}`,
          stack.includes(name)
            ? `Recursive tool execution is not allowed: ${[...stack, name].join(" -> ")}`
            : `Tool execution depth exceeds ${MAX_TOOL_EXECUTION_DEPTH}`,
          "recursion",
        );
      }
      const session = requireSession();
      const tool = (session as unknown as InternalAgentSession)._toolRegistry.get(name);
      if (!tool) {
        return errorResult(`pit:${randomUUID()}`, `Tool ${name} not found`, "not_found");
      }
      return await TOOL_EXECUTION_STACK.run(
        [...stack, name],
        async () =>
          await dispatchToolCall({
            session,
            tool,
            name,
            rawArgs: args,
            options: { ...options, scope },
          }),
      );
    },
  };
}

/**
 * Experimental fallback until Pi exposes PiToolExecutionApi on ExtensionContext.
 * All unsupported AgentSession access and prototype instrumentation is isolated here.
 */
export function installExperimentalPiToolApi(pi: ExtensionAPI): PiToolExecutionApi {
  return createExperimentalPiToolApi(pi, captureSession());
}
