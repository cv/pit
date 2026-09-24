import {
  boundedIntegerValue as boundedInteger,
  recordValue as object,
  stringValue as string,
} from "../../shared/argument-values.js";
import { terminationError } from "../../shared/termination-errors.js";
import type { PiControlServices } from "./services.js";

type PiModel = NonNullable<PiControlServices["ctx"]["model"]>;
type ModelRefreshResult = Awaited<ReturnType<PiControlServices["ctx"]["modelRegistry"]["refresh"]>>;

type ModelsCapabilityHandler = (
  method: string,
  args: unknown[],
  signal: AbortSignal,
) => unknown | Promise<unknown>;

const MAX_REFRESH_ERRORS = 10;
const MAX_REFRESH_ERROR_CHARS = 300;

function boundedErrorMessage(error: Error): string {
  const message = error.message.replace(/\s+/g, " ").trim();
  return message.length <= MAX_REFRESH_ERROR_CHARS
    ? message
    : `${message.slice(0, MAX_REFRESH_ERROR_CHARS - 1)}…`;
}

function refreshDiagnostics(result: ModelRefreshResult) {
  const all = [...result.errors]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, error]) => ({ provider, message: boundedErrorMessage(error) }));
  return {
    refreshErrors: all.slice(0, MAX_REFRESH_ERRORS),
    refreshErrorsTruncated: all.length > MAX_REFRESH_ERRORS,
  };
}

function ensureRefreshCompleted(result: ModelRefreshResult, signal: AbortSignal): void {
  if (result.aborted || signal.aborted) {
    throw terminationError("cancelled", "Model catalog refresh was cancelled");
  }
}

function refreshFailure(result: ModelRefreshResult): string {
  const diagnostics = refreshDiagnostics(result);
  const shown = diagnostics.refreshErrors
    .map((entry) => `${entry.provider}: ${entry.message}`)
    .join("; ");
  return `${shown}${diagnostics.refreshErrorsTruncated ? "; … additional provider errors omitted" : ""}`;
}

export function createModelsCapabilityHandler({
  pi,
  ctx,
}: PiControlServices): ModelsCapabilityHandler {
  const metadata = (model: PiModel) => {
    const scoped =
      ctx.scopedModels.length === 0 ||
      ctx.scopedModels.some(
        (entry) => entry.model.provider === model.provider && entry.model.id === model.id,
      );
    return {
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      available: ctx.modelRegistry.hasConfiguredAuth(model),
      scoped,
    };
  };

  return async (method, args, signal) => {
    if (method === "current") {
      return ctx.model ? metadata(ctx.model) : undefined;
    }
    if (method === "list") {
      const options = args[0] === undefined ? {} : object(args[0], "options");
      const availableOnly = options.availableOnly ?? true;
      if (typeof availableOnly !== "boolean") {
        throw new Error("options.availableOnly must be a boolean");
      }
      const query =
        options.query === undefined ? "" : string(options.query, "options.query").toLowerCase();
      const limit = boundedInteger(options.limit, "options.limit", 200, 100);
      const refresh = await ctx.modelRegistry.refresh({ signal });
      ensureRefreshCompleted(refresh, signal);
      const source = availableOnly ? ctx.modelRegistry.getAvailable() : ctx.modelRegistry.getAll();
      const matches = source.filter((model) =>
        `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query),
      );
      return {
        models: matches.slice(0, limit).map(metadata),
        truncated: matches.length > limit,
        ...refreshDiagnostics(refresh),
      };
    }
    if (method === "set") {
      const provider = string(args[0], "provider");
      const id = string(args[1], "model id");
      const refresh = await ctx.modelRegistry.refresh({ providers: [provider], signal });
      ensureRefreshCompleted(refresh, signal);
      if (refresh.errors.size > 0) {
        throw new Error(`Model catalog refresh failed: ${refreshFailure(refresh)}`);
      }
      const model = ctx.modelRegistry.find(provider, id);
      if (!model) {
        throw new Error(`Model "${provider}/${id}" is unavailable`);
      }
      const changed = ctx.model?.provider !== provider || ctx.model.id !== id;
      if (!(await pi.setModel(model))) {
        throw new Error(`Model "${provider}/${id}" has no configured credentials`);
      }
      return { provider, id, changed };
    }
  };
}
