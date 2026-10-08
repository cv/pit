import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import type { ContextEditQueue } from "../context/queue.js";
import { CompletedCallJournal, RecoverableCallStore } from "../execution/completed-calls.js";
import type { HostCallTrace } from "../execution/host-call-trace.js";
import { ExecutionProgressController } from "../execution/progress.js";
import { ExecutionTimingRecorder } from "../execution/timings.js";
import type { ExecutionProgressSnapshot, ShellProgressEvent } from "../execution/types.js";
import type { FunctionActivity } from "../functions/core.js";
import { createPiToolCatalog, type PiToolCatalog } from "../functions/pi-tools.js";
import type { PreparedSavedFunctionExecution, SavedFunctionService } from "../functions/service.js";
import type { FunctionState, FunctionStateCommit } from "../functions/state.js";
import { pitLoadout, type PitToolSelection } from "../functions/tool-loadout.js";
import { createHostDispatcher } from "../host/dispatcher.js";
import type { PiToolCallServices } from "../host/handlers/pi-tools.js";
import { renderTypeScriptToolCall } from "../renderers/typescript-tool-call.js";
import { renderTypeScriptToolResult } from "../renderers/typescript-tool.js";
import type { FunctionExecutor } from "../sandbox/executor.js";
import { runWithFunctionExecutor } from "../sandbox/run.js";
import { LIMITS } from "../shared/bounds.js";
import { createImageCollector, type ImageCollector } from "../workspace/view-image.js";
import {
  captureTypeScriptFailure,
  registerTypeScriptFailureEnrichment,
  type TypeScriptFailureDetails,
} from "./failure-context.js";
import { omitNullArguments, rejectCopiedElisionStub, resolveToolInput } from "./input.js";
import {
  CODE_DESCRIPTION,
  FUNCTION_ID_DESCRIPTION,
  createToolDescription,
  LABEL_DESCRIPTION,
  PARAMS_DESCRIPTION,
  PROMPT_GUIDELINES,
  PROMPT_SNIPPET,
  SAVE_ONLY_DESCRIPTION,
} from "./metadata.js";
import { appliedEditDetails, buildToolResult } from "./result.js";
import { formatTypeScriptSource } from "./source-formatter.js";

interface TypeScriptToolServices {
  contextEdits: ContextEditQueue;
  pi: ExtensionAPI;
  functionState: FunctionState;
  commitFunctionState: FunctionStateCommit;
  savedFunctionService: SavedFunctionService;
  functionExecutor: FunctionExecutor;
  toolSelection: PitToolSelection;
}

interface TypeScriptToolParams {
  code: string;
  functionId?: string;
  params?: unknown;
  saveOnly?: boolean;
  timeoutMs?: number;
}

interface TypeScriptProgressDetails extends ExecutionProgressSnapshot {
  value: undefined;
  truncated: false;
  functions?: FunctionActivity[];
}

type TypeScriptToolUpdate = (result: AgentToolResult<TypeScriptProgressDetails>) => void;

interface TypeScriptToolExecution extends TypeScriptToolServices {
  id: string;
  params: TypeScriptToolParams;
  signal?: AbortSignal;
  update?: TypeScriptToolUpdate;
  ctx: ExtensionToolContext;
  pendingFailures: Map<string, TypeScriptFailureDetails>;
  /** Journals of recent failed programs, readable through `runtime.completedCalls`. */
  recoverableCalls: RecoverableCallStore;
}

function createExecutionProgress(
  update: TypeScriptToolExecution["update"],
  functionActivity: FunctionActivity[],
  timings: ExecutionTimingRecorder,
): ExecutionProgressController {
  return new ExecutionProgressController(
    update
      ? (snapshot) =>
          update({
            content: [{ type: "text", text: "Running TypeScript…" }],
            details: {
              value: undefined,
              truncated: false,
              ...snapshot,
              timings: timings.snapshot(),
              ...(functionActivity.length > 0 ? { functions: [...functionActivity] } : {}),
            },
          })
      : undefined,
  );
}

interface SandboxValueExecution {
  input: unknown;
  request: TypeScriptToolExecution;
  preparedFunction: PreparedSavedFunctionExecution;
  functionActivity: FunctionActivity[];
  promotionSuggestions: string[];
  executionProgress: ExecutionProgressController;
  timings: ExecutionTimingRecorder;
  images: ImageCollector;
  /** The Pi tools Pi lets this call use, possibly none. */
  toolCatalog: PiToolCatalog;
  /** Pi tools the program may call; absent when Pi lets this call use none. */
  toolCalls: PiToolCallServices | undefined;
  /** This program's completed calls, kept if it fails. */
  completedCalls: CompletedCallJournal;
}

async function executeSandboxValue({
  request,
  input,
  preparedFunction,
  functionActivity,
  promotionSuggestions,
  executionProgress,
  timings,
  images,
  toolCatalog,
  toolCalls,
  completedCalls,
}: SandboxValueExecution): Promise<unknown> {
  if (request.params.saveOnly) {
    return { savedFunction: preparedFunction.name, executed: false };
  }
  const onShellProgress = request.update
    ? (event: ShellProgressEvent) => executionProgress.recordShell(event)
    : undefined;
  const handler = createHostDispatcher({
    pi: request.pi,
    ctx: request.ctx,
    functionState: request.functionState,
    commitFunctionState: request.commitFunctionState,
    activity: functionActivity,
    promotionSuggestions,
    ...(onShellProgress ? { onShellProgress } : {}),
    images,
    ...(toolCalls ? { toolCalls } : {}),
    toolCallId: request.id,
    contextEdits: request.contextEdits,
    completedCalls,
    recoverableCalls: request.recoverableCalls,
  });
  const options = {
    timings,
    ...(request.signal ? { signal: request.signal } : {}),
    timeoutMs: request.params.timeoutMs ?? 30_000,
    ...(preparedFunction.name
      ? {
          definition: {
            id: preparedFunction.name,
            layer: preparedFunction.projectMetadata ? ("project" as const) : ("session" as const),
          },
        }
      : {}),
    invalidDefinitions: new Map([
      ...request.functionState.invalidUser,
      ...request.functionState.invalidProject,
    ]),
    userFunctions: preparedFunction.userFunctions,
    projectFunctions: preparedFunction.projectFunctions,
    sessionFunctions: preparedFunction.sessionFunctions,
    toolCatalog,
    ...(input === undefined ? {} : { input }),
    onHostCallTrace: (trace: HostCallTrace) => executionProgress.recordTrace(trace),
  };
  return runWithFunctionExecutor(
    preparedFunction.source,
    handler,
    options,
    request.functionExecutor,
  );
}

async function executeTypeScriptTool(request: TypeScriptToolExecution) {
  const completedCalls = new CompletedCallJournal();
  const functionActivity: FunctionActivity[] = [];
  const promotionSuggestions: string[] = [];
  const timings = new ExecutionTimingRecorder();
  const executionProgress = createExecutionProgress(request.update, functionActivity, timings);

  const images = createImageCollector(request.ctx);
  // Only the tools Pi lets this call use; rebuilt per call, so a changed tool set never leaks.
  const catalog = createPiToolCatalog(request.ctx.tools);
  // Saving and committing check saved functions against the tools this call can use.
  request.functionState.toolCatalog = catalog;
  let terminate = false;
  const toolCalls: PiToolCallServices | undefined =
    catalog.bindings.size > 0
      ? {
          ctx: request.ctx,
          catalog,
          onTerminate: () => {
            terminate = true;
          },
          attachImage: (image, source) => images.attachBlock(image, source),
        }
      : undefined;
  try {
    const source = await formatTypeScriptSource(request.params.code);
    const input = resolveToolInput(source, request.params.params);
    timings.enter("preparation");
    const preparedFunction = request.savedFunctionService.prepare({
      source,
      ...(request.params.functionId === undefined ? {} : { functionId: request.params.functionId }),
      ...(input === undefined ? {} : { input }),
      ...(request.params.saveOnly ? { saveOnly: true } : {}),
      context: request.ctx,
    });
    const value = await executeSandboxValue({
      request,
      completedCalls,
      preparedFunction,
      input,
      functionActivity,
      promotionSuggestions,
      executionProgress,
      timings,
      images,
      toolCatalog: catalog,
      toolCalls,
    });
    timings.enter("commit");
    await request.savedFunctionService.commit(preparedFunction, request.ctx, functionActivity);
    timings.enter("result");
    // One snapshot keeps the image notes in the text aligned with the attached blocks.
    const attached = images.attached();
    const result = buildToolResult({
      value,
      ...(preparedFunction.name ? { namedFunction: preparedFunction.name } : {}),
      projectFunction: preparedFunction.projectMetadata !== undefined,
      saveOnly: request.params.saveOnly === true,
      functionState: request.functionState,
      functionActivity,
      imageMetadata: attached.map(({ info }) => info),
      imageOmissions: images.omissions(),
      promotionSuggestions,
      executionProgress,
    });
    return {
      ...result,
      content: [...result.content, ...attached.map(({ image }) => image)],
      details: {
        ...result.details,
        timings: timings.finish(),
        ...appliedEditDetails(completedCalls),
      },
      // A nested tool asked to end the turn, for example pi-goal's goal_complete, and the
      // program that called it succeeded.
      ...(terminate ? { terminate: true } : {}),
    };
  } catch (error) {
    // A later program can recover what this one consumed before failing.
    request.recoverableCalls.retain(request.id, completedCalls);
    request.pendingFailures.set(
      request.id,
      captureTypeScriptFailure(
        error,
        functionActivity,
        { ...executionProgress.snapshot(), timings: timings.finish() },
        completedCalls.size > 0
          ? { toolCallId: request.id, calls: completedCalls.size, omitted: completedCalls.omitted }
          : undefined,
      ),
    );
    throw error;
  } finally {
    executionProgress.flush();
    executionProgress.dispose();
  }
}

const TOOL_PARAMETERS = Type.Object({
  label: Type.Optional(Type.String({ description: LABEL_DESCRIPTION })),
  code: Type.String({ description: CODE_DESCRIPTION }),
  functionId: Type.Optional(Type.String({ description: FUNCTION_ID_DESCRIPTION })),
  // Each branch declares a JSON type. With an untyped schema, some models send every value
  // as a JSON-encoded string.
  params: Type.Optional(
    Type.Union(
      [
        Type.Object({}, { additionalProperties: true }),
        Type.Array(Type.Unknown()),
        Type.String(),
        Type.Number(),
        Type.Boolean(),
        Type.Null(),
      ],
      { description: PARAMS_DESCRIPTION },
    ),
  ),
  saveOnly: Type.Optional(Type.Boolean({ description: SAVE_ONLY_DESCRIPTION })),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 300_000,
      description: "Invocation timeout in ms: 1–300000; default 30000.",
    }),
  ),
});

export function registerTypeScriptTool(services: TypeScriptToolServices): void {
  const { pi, functionState } = services;
  const pendingFailures = new Map<string, TypeScriptFailureDetails>();
  const recoverableCalls = new RecoverableCallStore();
  // Recoverable values stay in memory only, for the Pi session that produced them.
  pi.on("session_start", () => recoverableCalls.clear());
  pi.registerTool({
    name: "typescript",
    label: "TypeScript Workspace",
    description: createToolDescription(LIMITS.result.maxBytes),
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: [...PROMPT_GUIDELINES],
    parameters: TOOL_PARAMETERS,
    // Pi validates the prepared arguments against TOOL_PARAMETERS afterwards.
    prepareArguments: (args) => {
      rejectCopiedElisionStub(args);
      return omitNullArguments(args) as Static<typeof TOOL_PARAMETERS>;
    },
    // Pit orchestrates the other tools and must not be callable from them, for example from
    // codemode scripts, which would also hide its declaration in codemode's `only` mode.
    exposure: "model-only",
    prepareLoadout: (loadout) => {
      // Pi reruns this whenever tools register, so the session catalog follows MCP connections.
      const catalog = createPiToolCatalog(loadout.callable);
      functionState.toolCatalog = catalog;
      return pitLoadout(loadout, services.toolSelection, catalog);
    },
    renderCall(args, theme, context) {
      return renderTypeScriptToolCall(args, theme, context, functionState.effective);
    },
    renderResult(result, options, theme, context) {
      return renderTypeScriptToolResult(result, options, theme, context);
    },
    // oxlint-disable-next-line max-params -- Pi defines the tool execute signature.
    execute(id, params, signal, update, ctx) {
      return executeTypeScriptTool({
        ...services,
        id,
        params,
        ...(signal ? { signal } : {}),
        ...(update ? { update } : {}),
        ctx,
        pendingFailures,
        recoverableCalls,
      });
    },
  });
  registerTypeScriptFailureEnrichment(pi, pendingFailures);
}
