import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createCapabilities } from "../capabilities/host.js";
import type { CapabilityTrace } from "../execution/capability-trace.js";
import { ExecutionProgressController } from "../execution/progress.js";
import { ExecutionTimingRecorder } from "../execution/timings.js";
import type { ExecutionProgressSnapshot, ShellProgressEvent } from "../execution/types.js";
import type { FunctionActivity } from "../functions/core.js";
import { functionDependencyBinding } from "../functions/identifier.js";
import type { PreparedSavedFunctionExecution, SavedFunctionService } from "../functions/service.js";
import { getSavedFunctionCallSignature } from "../functions/source.js";
import type { FunctionState, FunctionStateCommit } from "../functions/state.js";
import { renderTypeScriptToolCall } from "../renderers/typescript-tool-call.js";
import { renderTypeScriptToolResult } from "../renderers/typescript-tool.js";
import type { FunctionExecutor } from "../sandbox/executor.js";
import { runWithFunctionExecutor } from "../sandbox/run.js";
import { LIMITS } from "../shared/bounds.js";
import { fitValue } from "../shared/json-budget.js";
import {
  captureTypeScriptFailure,
  registerTypeScriptFailureEnrichment,
  type TypeScriptFailureDetails,
} from "./failure-context.js";
import { resolveToolInput } from "./input.js";
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
import { formatTypeScriptSource } from "./source-formatter.js";

export { display } from "../shared/json-budget.js";

const TRUNCATION_NOTICE =
  '\n[Result truncated to fit the output budget; omissions are marked "… N omitted …".]';

const MAX_SAVED_FUNCTION_CATALOG_BYTES = 1200;

export function savedFunctionCatalogNotice(registry: ReadonlyMap<string, string>): string {
  const signatures = [...registry]
    .map(([id, source]) => getSavedFunctionCallSignature(source, id))
    .filter((signature): signature is string => signature !== undefined)
    .sort((a, b) => a.localeCompare(b));
  if (signatures.length === 0) {
    return "";
  }

  const notice = (shown: readonly string[], omitted: number): string => {
    const entries = omitted > 0 ? [...shown, `… ${omitted} more`] : shown;
    return `\n[Session functions: ${entries.join(", ")}]`;
  };
  let catalog = notice([], signatures.length);
  for (let shown = 1; shown <= signatures.length; shown++) {
    const candidate = notice(signatures.slice(0, shown), signatures.length - shown);
    if (Buffer.byteLength(candidate) > MAX_SAVED_FUNCTION_CATALOG_BYTES) {
      break;
    }
    catalog = candidate;
  }
  return catalog;
}

export function promotionSuggestionNotice(names: readonly string[]): string {
  const suggested = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  const shown = suggested.slice(0, 5);
  if (shown.length === 0) {
    return "";
  }
  const omitted =
    suggested.length > shown.length ? `; … ${suggested.length - shown.length} more` : "";
  return `\n[Promotion suggestion: heavily reused session function${shown.length === 1 ? "" : "s"} ${shown.join(", ")}. Use functions.promote(name, summary) explicitly in an enabled, trusted project${omitted}.]`;
}

interface TypeScriptToolServices {
  pi: ExtensionAPI;
  functionState: FunctionState;
  commitFunctionState: FunctionStateCommit;
  savedFunctionService: SavedFunctionService;
  functionExecutor: FunctionExecutor;
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
  ctx: ExtensionContext;
  pendingFailures: Map<string, TypeScriptFailureDetails>;
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
}

async function executeSandboxValue({
  request,
  input,
  preparedFunction,
  functionActivity,
  promotionSuggestions,
  executionProgress,
  timings,
}: SandboxValueExecution): Promise<unknown> {
  if (request.params.saveOnly) {
    return { savedFunction: preparedFunction.name, executed: false };
  }
  const onShellProgress = request.update
    ? (event: ShellProgressEvent) => executionProgress.recordShell(event)
    : undefined;
  const handler = createCapabilities({
    pi: request.pi,
    ctx: request.ctx,
    functionState: request.functionState,
    commitFunctionState: request.commitFunctionState,
    activity: functionActivity,
    promotionSuggestions,
    ...(onShellProgress ? { onShellProgress } : {}),
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
    ...(input === undefined ? {} : { input }),
    onCapabilityTrace: (trace: CapabilityTrace) => executionProgress.recordTrace(trace),
  };
  return runWithFunctionExecutor(
    preparedFunction.source,
    handler,
    options,
    request.functionExecutor,
  );
}

function buildToolResult(input: {
  value: unknown;
  namedFunction?: string;
  projectFunction: boolean;
  saveOnly: boolean;
  functionState: FunctionState;
  functionActivity: FunctionActivity[];
  promotionSuggestions: string[];
  executionProgress: ExecutionProgressController;
}) {
  const savedSignature = input.namedFunction
    ? getSavedFunctionCallSignature(input.functionState.effective.get(input.namedFunction) ?? "")
    : undefined;
  const invocationGuidance = savedSignature
    ? `. Inject ${input.namedFunction?.includes(".") ? functionDependencyBinding(input.namedFunction) : input.namedFunction} in the first parameter, then call ${savedSignature}`
    : ".";
  const savedNotice = input.namedFunction
    ? input.saveOnly
      ? `\n[Saved ${input.projectFunction ? "project " : ""}function "${input.namedFunction}" without executing it${invocationGuidance}]`
      : `\n[Saved ${input.projectFunction ? "project " : ""}function "${input.namedFunction}"${invocationGuidance}]`
    : "";
  const notices =
    savedNotice +
    promotionSuggestionNotice(input.promotionSuggestions) +
    savedFunctionCatalogNotice(input.functionState.session);
  // The result gets the budget the notices leave, so the complete text stays within Pi's limit.
  const reserved = TRUNCATION_NOTICE + notices;
  const output = fitValue(input.value, {
    maxBytes: LIMITS.result.maxBytes - Buffer.byteLength(reserved),
    maxLines: LIMITS.result.maxLines - (reserved.split("\n").length - 1),
  });
  return {
    content: [
      {
        type: "text" as const,
        text: output.text + (output.truncated ? TRUNCATION_NOTICE : "") + notices,
      },
    ],
    details: {
      // A truncated result keeps its fitted value, so the TUI shows what the model received.
      value: output.value,
      truncated: output.truncated,
      ...(input.functionActivity.length > 0 ? { functions: input.functionActivity } : {}),
      ...input.executionProgress.snapshot(),
    },
  };
}

async function executeTypeScriptTool(request: TypeScriptToolExecution) {
  const functionActivity: FunctionActivity[] = [];
  const promotionSuggestions: string[] = [];
  const timings = new ExecutionTimingRecorder();
  const executionProgress = createExecutionProgress(request.update, functionActivity, timings);
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
      preparedFunction,
      input,
      functionActivity,
      promotionSuggestions,
      executionProgress,
      timings,
    });
    timings.enter("commit");
    await request.savedFunctionService.commit(preparedFunction, request.ctx, functionActivity);
    timings.enter("result");
    const result = buildToolResult({
      value,
      ...(preparedFunction.name ? { namedFunction: preparedFunction.name } : {}),
      projectFunction: preparedFunction.projectMetadata !== undefined,
      saveOnly: request.params.saveOnly === true,
      functionState: request.functionState,
      functionActivity,
      promotionSuggestions,
      executionProgress,
    });
    return { ...result, details: { ...result.details, timings: timings.finish() } };
  } catch (error) {
    request.pendingFailures.set(
      request.id,
      captureTypeScriptFailure(error, functionActivity, {
        ...executionProgress.snapshot(),
        timings: timings.finish(),
      }),
    );
    throw error;
  } finally {
    executionProgress.flush();
    executionProgress.dispose();
  }
}

export function registerTypeScriptTool(services: TypeScriptToolServices): void {
  const { pi, functionState } = services;
  const pendingFailures = new Map<string, TypeScriptFailureDetails>();
  pi.registerTool({
    name: "typescript",
    label: "TypeScript Workspace",
    description: createToolDescription(LIMITS.result.maxBytes),
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: [...PROMPT_GUIDELINES],
    parameters: Type.Object({
      label: Type.Optional(Type.String({ description: LABEL_DESCRIPTION })),
      code: Type.String({ description: CODE_DESCRIPTION }),
      functionId: Type.Optional(Type.String({ description: FUNCTION_ID_DESCRIPTION })),
      params: Type.Optional(Type.Unknown({ description: PARAMS_DESCRIPTION })),
      saveOnly: Type.Optional(Type.Boolean({ description: SAVE_ONLY_DESCRIPTION })),
      timeoutMs: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 300_000,
          description: "Invocation timeout in ms: 1–300000; default 30000.",
        }),
      ),
    }),
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
      });
    },
  });
  registerTypeScriptFailureEnrichment(pi, pendingFailures);
}
