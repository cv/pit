import type {
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";

import { CompletedCallJournal } from "../execution/completed-calls.js";
import type { HostCallTrace } from "../execution/host-call-trace.js";
import { ExecutionProgressController } from "../execution/progress.js";
import { ExecutionTimingRecorder } from "../execution/timings.js";
import type { ShellProgressEvent } from "../execution/types.js";
import type { FunctionActivity } from "../functions/core.js";
import { createNativeHostDispatcher, describeContext } from "../host/native-dispatcher.js";
import { ExecutionDeadline } from "../sandbox/deadline.js";
import type { FunctionExecutor } from "../sandbox/executor.js";
import { runWithFunctionExecutor } from "../sandbox/run.js";
import { LIMITS } from "../shared/bounds.js";
import { captureTypeScriptFailure, recoverableNotice } from "../tool/failure-context.js";
import { omitNullArguments, resolveToolInput } from "../tool/input.js";
import {
  CODE_DESCRIPTION,
  createToolDescription,
  FUNCTION_ID_DESCRIPTION,
  LABEL_DESCRIPTION,
  PARAMS_DESCRIPTION,
  SAVE_ONLY_DESCRIPTION,
} from "../tool/metadata.js";
import { appliedEditDetails, buildToolResult } from "../tool/result.js";
import { formatTypeScriptSource } from "../tool/source-formatter.js";
import { applySourceOptions } from "../tool/source-options.js";
import { TYPESCRIPT_PRESENTATION, type ToolPresentation } from "./present.js";
import { StagedContextChanges } from "./context/staging.js";
import { createDurableModelsHandler, createDurableRuntimeHandler } from "./handlers.js";
import {
  createDurableHostApi,
  answersDialogs,
  askingDialogs,
  createDurableHostContext,
  pauseWhileAsking,
  conversationCwd,
  type PitDurableLog,
  type PitDurableUi,
  unavailableNamespace,
} from "./host.js";
import { createDurableImageCollector } from "./images.js";
import { DurableQuestions, type QuestionPosted } from "./questions.js";
import { createDurableSessionHandler } from "./session.js";
import {
  type ConversationFunctions,
  DurableEntryWrites,
  type DurableFunctionStore,
} from "./state.js";
import { callDurableTool, createDurableToolCatalog } from "./tools.js";

type ToolContext = Parameters<ToolRegistration["execute"]>[2];
type JsonValue = Exclude<ToolExecutionResult["details"], undefined>;

/** The `typescript` parameters: the JSON Schema Pi's tool declares with TypeBox. */
export const DURABLE_TOOL_PARAMETERS = {
  type: "object",
  required: ["code"],
  properties: {
    label: { type: "string", description: LABEL_DESCRIPTION },
    code: { type: "string", description: CODE_DESCRIPTION },
    functionId: { type: "string", description: FUNCTION_ID_DESCRIPTION },
    // Each branch declares a JSON type. With an untyped schema, some models send every value
    // as a JSON-encoded string.
    params: {
      anyOf: [
        { type: "object", properties: {}, additionalProperties: true },
        { type: "array", items: {} },
        { type: "string" },
        { type: "number" },
        { type: "boolean" },
        { type: "null" },
      ],
      description: PARAMS_DESCRIPTION,
    },
    saveOnly: { type: "boolean", description: SAVE_ONLY_DESCRIPTION },
    timeoutMs: {
      type: "integer",
      minimum: 1,
      maximum: 300_000,
      description: "Invocation timeout in ms: 1–300000; default 30000.",
    },
  },
} as const;

interface DurableToolParams {
  code: string;
  functionId?: string;
  params?: unknown;
  saveOnly?: boolean;
  timeoutMs?: number;
}

const HOST_NOTES = [
  "",
  "ON PI-DURABLE",
  "Commands and host effects run in the host process, in the conversation's working directory. session.getName, session.setName, session.compact, commands.*, models.set, and model requests are unavailable and throw.",
].join("\n");

export interface DurableToolServices {
  store: DurableFunctionStore;
  functionExecutor: FunctionExecutor;
  /** Overrides the working directory the host's environment or agent reports. */
  cwd: string | undefined;
  trustProject: boolean;
  ui: PitDurableUi | undefined;
  log: PitDurableLog | undefined;
  /** Prepares the images `workspace.viewImage` attaches; without one, they pass as they are. */
  images: ImageProcessor | undefined;
}

interface DurableCall {
  services: DurableToolServices;
  params: DurableToolParams;
  api: ToolExecutionApi;
  context: ToolContext;
  cwd: string;
  functions: ConversationFunctions;
  writes: DurableEntryWrites;
}

function jsonValue(value: unknown): JsonValue {
  // Details travel through durable storage, which keeps JSON only.
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/**
 * What a call needs from its host: the agent and model, the deadline, the dialogs, and the images. A question
 * posted to an asynchronous host stops the program through `stop`; the answer comes in a later run.
 */
async function prepareHost(call: DurableCall) {
  const { api, context, params } = call;
  // A person may take minutes to answer a blocking dialog; that wait does not count.
  const deadline = new ExecutionDeadline(params.timeoutMs ?? 30_000);
  const stop = new AbortController();
  const ui = call.services.ui;
  const questions = ui?.ask
    ? new DurableQuestions({
        api,
        context,
        ask: ui.ask.bind(ui),
        onPosted: (posted) => stop.abort(posted),
      })
    : undefined;
  const agent = await api.agent(context);
  /* v8 ignore next 3 -- a conversation that generates, and so calls tools, has a model. */
  const model = agent.model
    ? api.models.getModel(agent.model.provider, agent.model.modelId)
    : undefined;
  const ctx = createDurableHostContext({
    cwd: call.cwd,
    model,
    thinkingLevel: agent.thinkingLevel,
    projectTrusted: call.services.trustProject,
    ui: !answersDialogs(ui)
      ? undefined
      : questions
        ? askingDialogs(questions, ui)
        : pauseWhileAsking(ui, deadline),
  });
  // The images the program attaches, prepared for this conversation's model.
  const images = createDurableImageCollector({
    cwd: call.cwd,
    model,
    processor: call.services.images,
  });
  return { deadline, stop, questions, ctx, agent, model, images };
}

async function runDurableProgram(call: DurableCall) {
  const { api, context, params, functions } = call;
  const { functionState, commitFunctionState, savedFunctionService, recoverableCalls } = functions;
  const completedCalls = new CompletedCallJournal();
  const functionActivity: FunctionActivity[] = [];
  const promotionSuggestions: string[] = [];
  const timings = new ExecutionTimingRecorder();
  const executionProgress = new ExecutionProgressController();
  const { deadline, stop, questions, ctx, agent, model, images } = await prepareHost(call);
  // Context edits and notes wait here, as on Pi, until the program succeeds.
  const staging = new StagedContextChanges();
  // Only the tools this call may run; rebuilt per call, so a changed tool set never leaks.
  const catalog = createDurableToolCatalog(agent.callable);
  functionState.toolCatalog = catalog;
  try {
    const source = await formatTypeScriptSource(params.code);
    const input = resolveToolInput(source, params.params);
    timings.enter("preparation");
    const prepared = savedFunctionService.prepare({
      source,
      ...(params.functionId === undefined ? {} : { functionId: params.functionId }),
      ...(input === undefined ? {} : { input }),
      ...(params.saveOnly ? { saveOnly: true } : {}),
      context: ctx,
    });
    let value: unknown;
    if (params.saveOnly) {
      value = { savedFunction: prepared.name, executed: false };
    } else {
      const handler = createNativeHostDispatcher(
        {
          pi: createDurableHostApi(functions.appendEntry),
          ctx,
          functionState,
          commitFunctionState,
          activity: functionActivity,
          promotionSuggestions,
          onShellProgress: (event: ShellProgressEvent) => {
            executionProgress.recordShell(event);
            // Running output for the host's observers; the result replaces it.
            if (event.phase === "output") api.output(event.chunk);
          },
          images,
          completedCalls,
          // Hosts such as pi-action run unattended on shared repositories: project files ask first.
          confirmProjectWrites: true,
          projectPromotionNote:
            "Written to .pi/functions in this host's working tree; commit it, or a host that checks the repository out again will not have it.",
        },
        {
          session: createDurableSessionHandler({
            api,
            context,
            contextWindow: model?.contextWindow,
            staging,
          }),
          commands: unavailableNamespace("commands", "the host has no slash commands"),
          models: createDurableModelsHandler({ models: api.models, current: model }),
          runtime: createDurableRuntimeHandler(recoverableCalls),
          // Hosts choose whether to answer dialogs, so programs can check before asking.
          context: () => ({ ...describeContext(ctx, functionState), hasUI: ctx.hasUI }),
          ...(catalog.bindings.size > 0
            ? { tools: (toolCall) => callDurableTool({ api, context, catalog, images }, toolCall) }
            : {}),
        },
      );
      value = await runWithFunctionExecutor(
        prepared.source,
        handler,
        {
          timings,
          // The Harness's cancellation, and the stop a posted question sends.
          signal: AbortSignal.any(
            [context.abortSignal, stop.signal].filter((signal) => signal !== undefined),
          ),
          timeoutMs: params.timeoutMs ?? 30_000,
          deadline,
          ...(prepared.name
            ? {
                // The tool saves to the session; functions.promote saves to other scopes.
                definition: { id: prepared.name, layer: "session" as const },
              }
            : {}),
          invalidDefinitions: new Map([
            ...functionState.invalidUser,
            ...functionState.invalidProject,
          ]),
          userFunctions: prepared.userFunctions,
          projectFunctions: prepared.projectFunctions,
          sessionFunctions: prepared.sessionFunctions,
          toolCatalog: catalog,
          ...(input === undefined ? {} : { input }),
          onHostCallTrace: (trace: HostCallTrace) => executionProgress.recordTrace(trace),
        },
        call.services.functionExecutor,
      );
    }
    timings.enter("commit");
    await savedFunctionService.commit(prepared, ctx, functionActivity);
    // The conversation records the saved-function changes before the call reports them.
    await call.writes.settle();
    await staging.apply(api, context, model?.contextWindow);
    await questions?.recordConsumed();
    timings.enter("result");
    // One snapshot keeps the image notes in the text aligned with the attached blocks.
    const attached = images.attached();
    const result = await buildToolResult({
      value,
      ...(prepared.name ? { namedFunction: prepared.name } : {}),
      projectFunction: false,
      saveOnly: params.saveOnly === true,
      functionState,
      functionActivity,
      imageMetadata: attached.map(({ info }) => info),
      imageOmissions: images.omissions(),
      promotionSuggestions,
      executionProgress,
    });
    return {
      output: [...result.content, ...attached.map(({ image }) => image)],
      details: jsonValue({
        ...result.details,
        timings: timings.finish(),
        ...appliedEditDetails(completedCalls),
      }),
    };
  } catch (error) {
    // A later program can recover what this one consumed before failing or asking.
    if (questions?.posted) {
      recoverableCalls.retain(api.callId, completedCalls);
      return questionResult(questions.posted, {
        toolCallId: api.callId,
        calls: completedCalls.size,
        details: { ...executionProgress.snapshot(), timings: timings.finish() },
      });
    }
    recoverableCalls.retain(api.callId, completedCalls);
    const details = captureTypeScriptFailure(
      error,
      functionActivity,
      { ...executionProgress.snapshot(), timings: timings.finish() },
      completedCalls.size > 0
        ? { toolCallId: api.callId, calls: completedCalls.size, omitted: completedCalls.omitted }
        : undefined,
    );
    const text = details.recoverable
      ? `${details.failure.rootError}\n${recoverableNotice(details.recoverable)}`
      : details.failure.rootError;
    return {
      isError: true,
      output: [{ type: "text" as const, text }],
      details: jsonValue(details),
    };
  } finally {
    executionProgress.dispose();
  }
}

/**
 * The result of a program that asked a question: not an error, but the end of the turn. The run
 * ends after this tool round, and the answer arrives as a later message.
 */
function questionResult(
  posted: QuestionPosted,
  input: { toolCallId: string; calls: number; details: object },
) {
  const where = posted.url ? ` (${posted.url})` : "";
  const recovery =
    input.calls > 0
      ? ` Calls this program completed before asking keep their effects; read their results with runtime.completedCalls("${input.toolCallId}").`
      : "";
  const { key, kind, title } = posted.question;
  return {
    output: [
      {
        type: "text" as const,
        text: `Question posted: ${title}${where}. The answer will arrive as a later message; end your turn now.${recovery}`,
      },
    ],
    details: jsonValue({
      ...input.details,
      question: { key, kind, title, ...(posted.url ? { url: posted.url } : {}) },
    }),
    control: { terminate: true },
  };
}

const SHOWN_LOAD_ERRORS = 3;

/**
 * Problems loading saved functions, reported once per conversation: to the host's log, and as
 * warnings on the call's result. Pi shows the same messages as UI notifications.
 */
function takeLoadWarnings(functions: ConversationFunctions, log: PitDurableLog | undefined) {
  const messages = functions.configErrors.splice(0);
  const errors = functions.loadErrors.splice(0);
  if (errors.length > 0) {
    const shown = errors.slice(0, SHOWN_LOAD_ERRORS).join("; ");
    const omitted =
      errors.length > SHOWN_LOAD_ERRORS ? `; … ${errors.length - SHOWN_LOAD_ERRORS} more` : "";
    messages.push(`Some saved functions could not be loaded: ${shown}${omitted}`);
  }
  for (const notice of functions.notices.splice(0)) log?.info(notice);
  for (const message of messages) log?.warning(message);
  return messages.map((message) => ({ severity: "warn" as const, message }));
}

/** Pit's `typescript` tool as a pi-durable tool registration. */
export function createDurableTypeScriptTool(
  services: DurableToolServices,
): ToolRegistration<typeof DURABLE_TOOL_PARAMETERS> & { present: ToolPresentation } {
  return {
    name: "typescript",
    // How hosts such as pi-action show the calls in their logs; pi-durable ignores it.
    present: TYPESCRIPT_PRESENTATION,
    description: `${createToolDescription(LIMITS.result.maxBytes)}\n${HOST_NOTES}`,
    parameters: DURABLE_TOOL_PARAMETERS,
    // The Harness validates the prepared arguments against the parameters afterwards.
    prepareArguments: (args) =>
      omitNullArguments(applySourceOptions(args)) as DurableToolParams as never,
    // Pit orchestrates the other tools and must not be callable from them.
    callers: ["model"],
    async execute(args, api, context) {
      const agent = await api.agent(context);
      const cwd = conversationCwd(services.cwd, api.env, agent);
      const functions = await services.store.forCall(api, context, cwd);
      const conversation = await api.conversation(api.conversationId, context);
      /* v8 ignore next -- a running call's own conversation exists. */
      if (!conversation) throw new Error(`Conversation ${api.conversationId} is unavailable`);
      const writes = new DurableEntryWrites((kind, data) =>
        conversation.submit({ type: "write", entry: { kind, data: jsonValue(data) } }, context),
      );
      const diagnostics = takeLoadWarnings(functions, services.log);
      const result = await functions.withWrites(writes, () =>
        runDurableProgram({
          services,
          params: args as DurableToolParams,
          api,
          context,
          cwd,
          functions,
          writes,
        }),
      );
      return diagnostics.length > 0 ? { ...result, diagnostics } : result;
    },
  };
}
