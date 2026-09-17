import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createCapabilities } from "../capabilities/host.js";
import { ExecutionProgressController } from "../execution/progress.js";
import type { ExecutionProgressSnapshot, ShellProgressEvent } from "../execution/types.js";
import type { FunctionActivity } from "../functions/core.js";
import type { PreparedSavedFunctionExecution, SavedFunctionService } from "../functions/service.js";
import { getSavedFunctionCallSignature } from "../functions/source.js";
import type { FunctionState, FunctionStateCommit } from "../functions/state.js";
import { renderTypeScriptToolCall } from "../renderers/typescript-tool-call.js";
import { renderTypeScriptToolResult } from "../renderers/typescript-tool.js";
import { runInSandbox } from "../sandbox/run.js";
import {
  captureTypeScriptFailure,
  registerTypeScriptFailureEnrichment,
  type TypeScriptFailureDetails,
} from "./failure-context.js";
import {
  CODE_DESCRIPTION,
  createToolDescription,
  LABEL_DESCRIPTION,
  PARAMS_DESCRIPTION,
  PROMPT_GUIDELINES,
  PROMPT_SNIPPET,
  SAVE_ONLY_DESCRIPTION,
} from "./metadata.js";
import { formatTypeScriptSource } from "./source-formatter.js";

export function display(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "undefined";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const MAX_SAVED_FUNCTION_CATALOG_BYTES = 1200;

export function savedFunctionCatalogNotice(registry: ReadonlyMap<string, string>): string {
  const signatures = [...registry.values()]
    .map(getSavedFunctionCallSignature)
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
}

interface TypeScriptToolParams {
  code: string;
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
              ...(functionActivity.length > 0 ? { functions: [...functionActivity] } : {}),
            },
          })
      : undefined,
  );
}

interface SandboxValueExecution {
  request: TypeScriptToolExecution;
  preparedFunction: PreparedSavedFunctionExecution;
  functionActivity: FunctionActivity[];
  promotionSuggestions: string[];
  executionProgress: ExecutionProgressController;
}

async function executeSandboxValue({
  request,
  preparedFunction,
  functionActivity,
  promotionSuggestions,
  executionProgress,
}: SandboxValueExecution): Promise<unknown> {
  if (request.params.saveOnly) {
    return { savedFunction: preparedFunction.name, executed: false };
  }
  const onShellProgress = request.update
    ? (event: ShellProgressEvent) => executionProgress.recordShell(event)
    : undefined;
  return await runInSandbox(
    preparedFunction.source,
    createCapabilities({
      pi: request.pi,
      ctx: request.ctx,
      functionState: request.functionState,
      commitFunctionState: request.commitFunctionState,
      activity: functionActivity,
      promotionSuggestions,
      ...(onShellProgress ? { onShellProgress } : {}),
    }),
    {
      ...(request.signal ? { signal: request.signal } : {}),
      unifiedFunctions: true,
      timeoutMs: request.params.timeoutMs ?? 30_000,
      savedFunctions: preparedFunction.registry,
      savedFunctionScopes: preparedFunction.scopes,
      globalFunctions: preparedFunction.globalFunctions,
      projectFunctions: preparedFunction.projectFunctions,
      sessionFunctions: preparedFunction.sessionFunctions,
      ...(request.params.params === undefined ? {} : { input: request.params.params }),
      onCapabilityTrace: (trace) => executionProgress.recordTrace(trace),
    },
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
  const output = truncateHead(display(input.value), {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  const savedSignature = input.namedFunction
    ? getSavedFunctionCallSignature(input.functionState.effective.get(input.namedFunction) ?? "")
    : undefined;
  const invocationGuidance = savedSignature
    ? `. Inject ${input.namedFunction} in the first parameter, then call ${savedSignature}`
    : ".";
  const savedNotice = input.namedFunction
    ? input.saveOnly
      ? `\n[Saved ${input.projectFunction ? "project " : ""}function "${input.namedFunction}" without executing it${invocationGuidance}]`
      : `\n[Saved ${input.projectFunction ? "project " : ""}function "${input.namedFunction}"${invocationGuidance}]`
    : "";
  return {
    content: [
      {
        type: "text" as const,
        text:
          output.content +
          (output.truncated ? "\n[Result truncated]" : "") +
          savedNotice +
          promotionSuggestionNotice(input.promotionSuggestions) +
          savedFunctionCatalogNotice(input.functionState.session),
      },
    ],
    details: {
      value: output.truncated ? undefined : input.value,
      truncated: output.truncated,
      ...(input.functionActivity.length > 0 ? { functions: input.functionActivity } : {}),
      ...input.executionProgress.snapshot(),
    },
  };
}

async function executeTypeScriptTool(request: TypeScriptToolExecution) {
  const functionActivity: FunctionActivity[] = [];
  const promotionSuggestions: string[] = [];
  const executionProgress = createExecutionProgress(request.update, functionActivity);
  try {
    const source = await formatTypeScriptSource(request.params.code);
    const preparedFunction = request.savedFunctionService.prepare({
      source,
      ...(request.params.params === undefined ? {} : { input: request.params.params }),
      ...(request.params.saveOnly ? { saveOnly: true } : {}),
      context: request.ctx,
    });
    const value = await executeSandboxValue({
      request,
      preparedFunction,
      functionActivity,
      promotionSuggestions,
      executionProgress,
    });
    await request.savedFunctionService.commit(preparedFunction, request.ctx, functionActivity);
    return buildToolResult({
      value,
      ...(preparedFunction.name ? { namedFunction: preparedFunction.name } : {}),
      projectFunction: preparedFunction.projectMetadata !== undefined,
      saveOnly: request.params.saveOnly === true,
      functionState: request.functionState,
      functionActivity,
      promotionSuggestions,
      executionProgress,
    });
  } catch (error) {
    request.pendingFailures.set(
      request.id,
      captureTypeScriptFailure(error, functionActivity, executionProgress.snapshot()),
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
    description: createToolDescription(DEFAULT_MAX_BYTES),
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: [...PROMPT_GUIDELINES],
    parameters: Type.Object({
      label: Type.Optional(Type.String({ description: LABEL_DESCRIPTION })),
      code: Type.String({ description: CODE_DESCRIPTION }),
      params: Type.Optional(Type.Unknown({ description: PARAMS_DESCRIPTION })),
      saveOnly: Type.Optional(Type.Boolean({ description: SAVE_ONLY_DESCRIPTION })),
      timeoutMs: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 300_000,
          description:
            "Maximum wall-clock time for the entire invocation in milliseconds (default: 30000).",
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
