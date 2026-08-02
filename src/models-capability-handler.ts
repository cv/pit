import {
  boundedIntegerValue as boundedInteger,
  recordValue as object,
  stringValue as string,
} from "./cli.js";
import type { PiControlServices } from "./pi-control-services.js";

type PiModel = NonNullable<PiControlServices["ctx"]["model"]>;

type ModelsCapabilityHandler = (method: string, args: unknown[]) => unknown | Promise<unknown>;

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

  return async (method, args) => {
    if (method === "current") {
      return ctx.model ? metadata(ctx.model) : undefined;
    }
    if (method === "list") {
      await ctx.modelRegistry.refresh();
      const options = args[0] === undefined ? {} : object(args[0], "options");
      const availableOnly = options.availableOnly ?? true;
      if (typeof availableOnly !== "boolean") {
        throw new Error("options.availableOnly must be a boolean");
      }
      const query =
        options.query === undefined ? "" : string(options.query, "options.query").toLowerCase();
      const limit = boundedInteger(options.limit, "options.limit", 200, 100);
      const source = availableOnly ? ctx.modelRegistry.getAvailable() : ctx.modelRegistry.getAll();
      const matches = source.filter((model) =>
        `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query),
      );
      return {
        models: matches.slice(0, limit).map(metadata),
        truncated: matches.length > limit,
      };
    }
    if (method === "set") {
      await ctx.modelRegistry.refresh();
      const provider = string(args[0], "provider");
      const id = string(args[1], "model id");
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
