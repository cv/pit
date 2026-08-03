import { randomUUID } from "node:crypto";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { AgentSession, type AgentToolResult, type ToolInfo } from "@earendil-works/pi-coding-agent";

const SESSION_CAPTURE = Symbol.for("@pit/pi-tool-session-capture");

interface CaptureState {
  current?: AgentSession;
  promptPatched?: boolean;
}

type CapturedPrototype = typeof AgentSession.prototype & {
  [SESSION_CAPTURE]?: CaptureState;
};

type ValidationTool = Parameters<typeof validateToolArguments>[0];
type ValidationToolCall = Parameters<typeof validateToolArguments>[1];
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

export interface PiToolCallResult extends AgentToolResult<unknown> {
  isError: boolean;
}

export interface PiToolBridge {
  list(): Array<ToolInfo & { active: boolean }>;
  call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PiToolCallResult>;
}

function errorResult(message: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: message }],
    details: {},
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function emitEnd(input: {
  session: AgentSession;
  toolCallId: string;
  toolName: string;
  result: AgentToolResult<unknown>;
  isError: boolean;
}): Promise<PiToolCallResult> {
  await input.session.extensionRunner.emit({
    type: "tool_execution_end",
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    result: input.result,
    isError: input.isError,
  });
  return { ...input.result, isError: input.isError };
}

async function dispatchToolCall(
  session: AgentSession,
  name: string,
  rawArgs: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<PiToolCallResult> {
  const toolCallId = `pit:${randomUUID()}`;
  const runner = session.extensionRunner;
  await runner.emit({
    type: "tool_execution_start",
    toolCallId,
    toolName: name,
    args: rawArgs,
  });
  const finish = (finalResult: AgentToolResult<unknown>, finalIsError: boolean) =>
    emitEnd({
      session,
      toolCallId,
      toolName: name,
      result: finalResult,
      isError: finalIsError,
    });

  const tool = (session as unknown as InternalAgentSession)._toolRegistry.get(name);
  if (!tool) {
    return await finish(errorResult(`Tool ${name} not found`), true);
  }

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
    validatedArgs = validateToolArguments(tool, validationCall) as Record<string, unknown>;
    if (runner.hasHandlers("tool_call")) {
      const beforeResult = await runner.emitToolCall({
        type: "tool_call",
        toolName: name,
        toolCallId,
        input: validatedArgs,
      });
      if (signal?.aborted) {
        return await finish(errorResult("Operation aborted"), true);
      }
      if (beforeResult?.block) {
        return await finish(errorResult(beforeResult.reason || "Tool execution was blocked"), true);
      }
    }
    if (signal?.aborted) {
      return await finish(errorResult("Operation aborted"), true);
    }
  } catch (error) {
    return await finish(errorResult(errorMessage(error)), true);
  }

  const updateEvents: Promise<unknown>[] = [];
  let acceptingUpdates = true;
  let result: AgentToolResult<unknown>;
  let isError = false;
  try {
    result = await tool.execute(
      toolCallId,
      validatedArgs,
      signal,
      (partialResult: AgentToolResult<unknown>) => {
        if (!acceptingUpdates) {
          return;
        }
        updateEvents.push(
          Promise.resolve(
            runner.emit({
              type: "tool_execution_update",
              toolCallId,
              toolName: name,
              args: rawArgs,
              partialResult,
            }),
          ),
        );
      },
    );
  } catch (error) {
    result = errorResult(errorMessage(error));
    isError = true;
  } finally {
    acceptingUpdates = false;
    await Promise.all(updateEvents);
  }

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
      result = errorResult(errorMessage(error));
      isError = true;
    }
  }

  return await finish(result, isError);
}

export function createPiToolBridge(getSession: () => AgentSession | undefined): PiToolBridge {
  const requireSession = (): AgentSession => {
    const session = getSession();
    if (!session) {
      throw new Error("Pi tool bridge is unavailable before the agent session is bound");
    }
    return session;
  };
  return {
    list: () => {
      const session = requireSession();
      const active = new Set(session.getActiveToolNames());
      return session.getAllTools().map((tool) => ({ ...tool, active: active.has(tool.name) }));
    },
    call: async (name, args, signal) =>
      await dispatchToolCall(requireSession(), name, args, signal),
  };
}

export function installPiToolBridge(): PiToolBridge {
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
  return createPiToolBridge(() => captureState.current);
}
