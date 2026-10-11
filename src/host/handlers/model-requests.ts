import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  boundedIntegerValue as boundedInteger,
  recordValue as object,
  stringValue as string,
} from "../../shared/argument-values.js";
import { resolveWorkspacePath, workspaceResultPath } from "../../workspace/paths.js";
import type { ImageCollector } from "../../workspace/view-image.js";
import type { PiControlServices } from "./services.js";

type Registry = PiControlServices["ctx"]["modelRegistry"];
type ClassifierResult = Awaited<ReturnType<Registry["classify"]>>;
type ImagesResult = Awaited<ReturnType<Registry["generateImages"]>>;
type ClassifierContext = Parameters<Registry["classify"]>[1];
type ModelType = "classifier" | "image";

const MODEL_TYPES = new Set<string>(["classifier", "image"]);
const QUESTION_TYPES = new Set(["choice", "score", "bool"]);
const MAX_INPUT_IMAGES = 8;
// As in Pi's codemode `models` global: further requests wait for a free slot.
const MAX_CONCURRENT_REQUESTS = 4;
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function modelType(value: unknown): ModelType {
  if (typeof value !== "string" || !MODEL_TYPES.has(value)) {
    throw new Error('type must be "classifier" or "image"');
  }
  return value as ModelType;
}

function modelReference(value: unknown): { provider: string; id: string } {
  const model = object(value, "model");
  return { provider: string(model.provider, "model.provider"), id: string(model.id, "model.id") };
}

function questions(value: unknown): ClassifierContext["questions"] {
  const entries = Object.entries(object(value, "request.questions"));
  if (entries.length === 0) throw new Error("request.questions must name at least one question");
  for (const [id, raw] of entries) {
    const question = object(raw, `request.questions.${id}`);
    if (typeof question.type !== "string" || !QUESTION_TYPES.has(question.type)) {
      throw new Error(`request.questions.${id}.type must be "choice", "score", or "bool"`);
    }
    string(question.instructions, `request.questions.${id}.instructions`);
    if (question.criteria === null || typeof question.criteria !== "object") {
      throw new Error(`request.questions.${id}.criteria must be an object or array`);
    }
  }
  return Object.fromEntries(entries) as ClassifierContext["questions"];
}

function usage(result: ClassifierResult | ImagesResult) {
  return result.usage
    ? {
        usage: {
          input: result.usage.input,
          output: result.usage.output,
          totalTokens: result.usage.totalTokens,
          cost: result.usage.cost.total,
        },
      }
    : {};
}

function outcome(result: ClassifierResult | ImagesResult) {
  return {
    provider: result.provider,
    model: result.model,
    ...usage(result),
    stopReason: result.stopReason,
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
  };
}

/** A counting semaphore: at most `limit` tasks run at once, the rest start in arrival order. */
function limiter(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** Runs Pi's non-chat models: classifiers and image generators, with the session's credentials. */
export function createModelRequests({
  ctx,
  loadImage,
}: Pick<PiControlServices, "ctx"> & { loadImage: ImageCollector["load"] }) {
  const registry = ctx.modelRegistry;
  const slot = limiter(MAX_CONCURRENT_REQUESTS);

  const find = <T extends ModelType>(type: T, value: unknown) => {
    const { provider, id } = modelReference(value);
    const model = registry.getModelOfType(type, provider, id);
    if (!model) {
      throw new Error(
        `No ${type} model "${provider}/${id}"; models.listOfType("${type}") lists them`,
      );
    }
    return model;
  };

  const images = async (value: unknown, signal: AbortSignal) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_INPUT_IMAGES) {
      throw new Error(`request.images must be an array of at most ${MAX_INPUT_IMAGES} paths`);
    }
    const loaded = await Promise.all(value.map((path) => loadImage(path, signal)));
    return loaded;
  };

  return {
    async listOfType(args: unknown[]) {
      const type = modelType(args[0]);
      const options = args[1] === undefined ? {} : object(args[1], "options");
      const provider =
        options.provider === undefined ? undefined : string(options.provider, "options.provider");
      const availableOnly = options.availableOnly ?? true;
      if (typeof availableOnly !== "boolean") {
        throw new Error("options.availableOnly must be a boolean");
      }
      const query =
        options.query === undefined ? "" : string(options.query, "options.query").toLowerCase();
      const limit = boundedInteger(options.limit, "options.limit", { maximum: 200, fallback: 100 });
      const key = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
      const availableModels = await registry.getAvailableOfType(type, provider);
      const available = new Set(availableModels.map(key));
      const source = availableOnly ? availableModels : registry.getModelsOfType(type, provider);
      const matches = source.filter((model) =>
        `${key(model)} ${model.name}`.toLowerCase().includes(query),
      );
      return {
        models: matches.slice(0, limit).map((model) => {
          const metadata: Record<string, unknown> = {
            type,
            provider: model.provider,
            id: model.id,
            name: model.name,
            input: [...model.input],
          };
          if ("output" in model && Array.isArray(model.output)) metadata.output = [...model.output];
          metadata.available = available.has(key(model));
          return metadata;
        }),
        truncated: matches.length > limit,
      };
    },

    async classify(args: unknown[], signal: AbortSignal) {
      const model = find("classifier", args[0]);
      const request = object(args[1], "request");
      const state = object(request.state, "request.state") as ClassifierContext["state"];
      const temperature = request.temperature;
      if (temperature !== undefined && !(typeof temperature === "number" && temperature > 0)) {
        throw new Error("request.temperature must be a positive number");
      }
      const context: ClassifierContext = {
        state,
        questions: questions(request.questions),
        ...(request.images === undefined ? {} : { images: await images(request.images, signal) }),
      };
      const result = await slot(() =>
        registry.classify(model, context, {
          signal,
          ...(temperature === undefined ? {} : { temperature }),
        }),
      );
      return { ...outcome(result), answers: result.answers };
    },

    async generateImages(args: unknown[], signal: AbortSignal) {
      const model = find("image", args[0]);
      const request = object(args[1], "request");
      const prompt = string(request.prompt, "request.prompt");
      const references = await images(request.images, signal);
      const result = await slot(() =>
        registry.generateImages(
          model,
          { input: [{ type: "text", text: prompt }, ...references] },
          { signal },
        ),
      );
      const generated = result.output.flatMap((block) => (block.type === "image" ? [block] : []));
      const directory =
        request.outputDir === undefined
          ? await mkdtemp(join(tmpdir(), "pit-images-"))
          : resolveWorkspacePath(ctx.cwd, request.outputDir);
      if (generated.length > 0) await mkdir(directory, { recursive: true });
      const stamp = Date.now();
      const files = await Promise.all(
        generated.map(async (block, index) => {
          const path = join(
            directory,
            `image-${stamp}-${index + 1}.${EXTENSIONS[block.mimeType] ?? "bin"}`,
          );
          const data = Buffer.from(block.data, "base64");
          // Never overwrite: a name already taken fails this call instead.
          await writeFile(path, data, { flag: "wx" });
          // Paths inside the workspace are relative, like other workspace results.
          const shown = workspaceResultPath(ctx.cwd, path);
          const file = shown.startsWith("../") ? path : shown;
          return { file, mimeType: block.mimeType, bytes: data.length };
        }),
      );
      return {
        ...outcome(result),
        images: files,
        text: result.output.flatMap((block) => (block.type === "text" ? [block.text] : [])),
      };
    },
  };
}

export function isModelRequestMethod(
  method: string,
): method is "listOfType" | "classify" | "generateImages" {
  return method === "listOfType" || method === "classify" || method === "generateImages";
}
