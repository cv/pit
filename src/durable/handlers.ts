import type { Api, Model, Models } from "@earendil-works/pi-ai";

import type { RecoverableCallStore } from "../execution/completed-calls.js";
import type { NativeFunctionHandler } from "../host/native-dispatcher.js";
import {
  boundedIntegerValue as boundedInteger,
  recordValue as object,
  stringValue as string,
} from "../shared/argument-values.js";
import { PitDurableUnavailableError } from "./host.js";

const MODEL_LIST_MAXIMUM = 200;
const MODEL_LIST_DEFAULT = 100;

/**
 * `models.current` and `models.list` read the host's model catalog. A conversation's model is the
 * host's to configure, so `models.set` and model requests are unavailable.
 */
export function createDurableModelsHandler(input: {
  models: Models;
  current: Model<Api> | undefined;
}): NativeFunctionHandler {
  const { models, current } = input;
  const metadata = async (model: Model<Api>) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    available: (await models.getAvailable(model.provider)).some(({ id }) => id === model.id),
    // pi-durable has no scoped model list; every catalog model is in scope.
    scoped: true,
  });
  return async (method, args) => {
    /* v8 ignore next -- a conversation that calls tools has a model. */
    if (method === "current") return current ? metadata(current) : undefined;
    if (method === "list") {
      const options = args[0] === undefined ? {} : object(args[0], "options");
      const availableOnly = options.availableOnly ?? true;
      if (typeof availableOnly !== "boolean") {
        throw new Error("options.availableOnly must be a boolean");
      }
      const query =
        options.query === undefined ? "" : string(options.query, "options.query").toLowerCase();
      const limit = boundedInteger(options.limit, "options.limit", {
        maximum: MODEL_LIST_MAXIMUM,
        fallback: MODEL_LIST_DEFAULT,
      });
      const source = availableOnly ? await models.getAvailable() : models.getModels();
      const matches = source.filter((model) =>
        `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query),
      );
      return {
        models: await Promise.all(matches.slice(0, limit).map(metadata)),
        truncated: matches.length > limit,
        // The host refreshes its catalog; Pit reads it as it is.
        refreshErrors: [],
        refreshErrorsTruncated: false,
      };
    }
    if (method === "set") {
      throw new PitDurableUnavailableError(
        "models.set",
        "the host configures the conversation's model",
      );
    }
    throw new PitDurableUnavailableError(`models.${method}`);
  };
}

/** `runtime.status` describes the running tool call; `runtime.completedCalls` works as on Pi. */
export function createDurableRuntimeHandler(
  recoverableCalls: RecoverableCallStore,
): NativeFunctionHandler {
  return (method, args) => {
    if (method === "status") {
      // A program runs inside a turn, so the conversation is never idle while it asks.
      return { mode: "durable", idle: false, pendingMessages: false };
    }
    const toolCallId = string(args[0], "toolCallId");
    const options = args[1] === undefined ? {} : object(args[1], "options");
    const sequence =
      options.sequence === undefined
        ? undefined
        : boundedInteger(options.sequence, "options.sequence", {
            maximum: Number.MAX_SAFE_INTEGER,
            fallback: 1,
          });
    return recoverableCalls.read(toolCallId, sequence);
  };
}
