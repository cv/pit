import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createModelsHostHandler } from "../../src/host/handlers/models.js";
import {
  cleanupHarness,
  context,
  cwd,
  run,
  setConfiguredModels,
  setupHarness,
  value,
} from "../support/extension-fixture.js";
import { png } from "../support/png-fixture.js";

const unusedImageLoader = async (): Promise<never> => {
  throw new Error("no image expected");
};

const available = {
  provider: "test",
  id: "available",
  name: "Available Model",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 200000,
  maxTokens: 32000,
  available: true,
};
const unavailable = {
  provider: "test",
  id: "unavailable",
  name: "Unavailable Model",
  reasoning: false,
  input: ["text"],
  contextWindow: 100000,
  maxTokens: 16000,
  available: false,
};

beforeEach(async () => {
  await setupHarness();
  setConfiguredModels([available, unavailable]);
});
afterEach(cleanupHarness);

describe("models namespace", () => {
  it("lists available models by default and supports bounded queries", async () => {
    expect(
      await value(`async ({ models: { current: modelsCurrent, list: modelsList, set: modelsSet } }) => ({
        available: await modelsList(),
        all: await modelsList({ availableOnly: false, query: "unavailable", limit: 1 }),
      })`),
    ).toMatchObject({
      available: {
        models: [{ provider: "test", id: "available", available: true, scoped: true }],
        truncated: false,
      },
      all: {
        models: [{ provider: "test", id: "unavailable", available: false, scoped: true }],
        truncated: false,
      },
    });
  });

  it("marks scoped models and reports truncation", async () => {
    const ctx = context({ scopedModels: [{ model: available }] });
    expect(
      await value(
        `async ({ models: { current: modelsCurrent, list: modelsList, set: modelsSet } }) => ({
          full: await modelsList({ availableOnly: false }),
          limited: await modelsList({ availableOnly: false, limit: 1 }),
        })`,
        ctx,
      ),
    ).toMatchObject({
      full: {
        models: [
          { id: "available", scoped: true },
          { id: "unavailable", scoped: false },
        ],
        truncated: false,
      },
      limited: {
        models: [{ id: "available" }],
        truncated: true,
      },
    });
  });

  it("reports the current model and selects an explicit available model", async () => {
    const ctx = context({ model: available });
    expect(
      await value(
        `async ({ models: { current: modelsCurrent, list: modelsList, set: modelsSet } }) => ({
        current: await modelsCurrent(),
        selected: await modelsSet("test", "available"),
      })`,
        ctx,
      ),
    ).toMatchObject({
      current: { provider: "test", id: "available", reasoning: true },
      selected: { provider: "test", id: "available", changed: false },
    });
  });

  it("reports no current model and detects a model change", async () => {
    await expect(
      value(
        "async ({ models: { current: modelsCurrent, list: modelsList, set: modelsSet } }) => modelsCurrent()",
        context({ model: undefined }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      value(
        `async ({ models: { current: modelsCurrent, list: modelsList, set: modelsSet } }) => modelsSet("test", "available")`,
      ),
    ).resolves.toEqual({
      provider: "test",
      id: "available",
      changed: true,
    });
  });

  it("rejects unknown models, missing credentials, and invalid options", async () => {
    await expect(
      run(
        `async ({ models: { current: modelsCurrent, list: modelsList, set: modelsSet } }) => modelsSet("test", "missing")`,
      ),
    ).rejects.toThrow("is unavailable");
    await expect(
      run(
        `async ({ models: { current: modelsCurrent, list: modelsList, set: modelsSet } }) => modelsSet("test", "unavailable")`,
      ),
    ).rejects.toThrow("no configured credentials");
    await expect(
      run(
        `async ({ models: { current: modelsCurrent, list: modelsList, set: modelsSet } }) => modelsList({ availableOnly: "yes" as any })`,
      ),
    ).rejects.toThrow("must be a boolean");
  });

  it("returns bounded model refresh diagnostics and forwards the execution signal", async () => {
    const errors = new Map<string, Error>([
      ["alpha", new Error(`offline\n${"x".repeat(400)}`)],
      ...Array.from(
        { length: 10 },
        (_, index) => [`provider-${index}`, new Error(`failure ${index}`)] as const,
      ),
    ]);
    const base = context();
    const refresh = vi.fn(async (_options?: { signal?: AbortSignal }) => ({
      aborted: false,
      errors,
    }));
    const ctx = context({ modelRegistry: { ...base.modelRegistry, refresh } });

    const result = await value(
      "async ({ models: { current: modelsCurrent, list: modelsList, set: modelsSet } }) => modelsList({ availableOnly: false })",
      ctx,
    );

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(result.refreshErrors).toHaveLength(10);
    expect(result.refreshErrors[0]).toMatchObject({ provider: "alpha" });
    expect(result.refreshErrors[0].message).not.toContain("\n");
    expect(result.refreshErrors[0].message.length).toBeLessThanOrEqual(300);
    expect(result.refreshErrorsTruncated).toBe(true);
  });

  it("rejects cancelled refreshes and provider failures when selecting a model", async () => {
    const signal = new AbortController().signal;
    const base = context();
    const cancelled = createModelsHostHandler({
      pi: {} as never,
      loadImage: unusedImageLoader,
      ctx: context({
        modelRegistry: {
          ...base.modelRegistry,
          refresh: vi.fn(async () => ({ aborted: true, errors: new Map() })),
        },
      }) as never,
    });
    await expect(cancelled("list", [], signal)).rejects.toThrow("refresh was cancelled");

    const refresh = vi.fn(async () => ({
      aborted: false,
      errors: new Map([["test", new Error("provider offline")]]),
    }));
    const failed = createModelsHostHandler({
      pi: {} as never,
      loadImage: unusedImageLoader,
      ctx: context({ modelRegistry: { ...base.modelRegistry, refresh } }) as never,
    });
    await expect(failed("set", ["test", "available"], signal)).rejects.toThrow(
      "test: provider offline",
    );
    expect(refresh).toHaveBeenCalledWith({ providers: ["test"], signal });
  });

  describe("classifier and image models", () => {
    const jev = {
      type: "classifier",
      provider: "typesafe",
      id: "jev",
      name: "Jev",
      input: ["text"],
    };
    const luna = { ...jev, provider: "openai", id: "luna", name: "Luna", input: ["text", "image"] };
    const painter = {
      type: "image",
      provider: "openrouter",
      id: "painter",
      name: "Painter",
      input: ["text", "image"],
      output: ["image", "text"],
    };
    const usage = { input: 12, output: 3, totalTokens: 15, cost: { total: 0.002 } };

    function typedContext(overrides: Record<string, unknown> = {}) {
      const base = context();
      const all = { classifier: [jev, luna], image: [painter] } as Record<string, any[]>;
      return context({
        modelRegistry: {
          ...base.modelRegistry,
          getModelsOfType: (type: string) => all[type] ?? [],
          getAvailableOfType: async (type: string) =>
            (all[type] ?? []).filter((model) => model.id !== "luna"),
          getModelOfType: (type: string, provider: string, id: string) =>
            (all[type] ?? []).find((model) => model.provider === provider && model.id === id),
          ...overrides,
        },
      });
    }

    it("lists models of a type, with working credentials by default", async () => {
      expect(
        await value(
          `async ({ models: { listOfType } }) => ({
            available: await listOfType("classifier"),
            all: await listOfType("classifier", { availableOnly: false, limit: 1 }),
            images: await listOfType("image", { query: "paint" }),
          })`,
          typedContext(),
        ),
      ).toEqual({
        available: {
          models: [
            {
              type: "classifier",
              provider: "typesafe",
              id: "jev",
              name: "Jev",
              input: ["text"],
              available: true,
            },
          ],
          truncated: false,
        },
        all: { models: [expect.objectContaining({ id: "jev" })], truncated: true },
        images: {
          models: [
            expect.objectContaining({ id: "painter", output: ["image", "text"], available: true }),
          ],
          truncated: false,
        },
      });
      await expect(
        run(`async ({ models: { listOfType } }) => listOfType("chat" as any)`, typedContext()),
      ).rejects.toThrow('type must be "classifier" or "image"');
      await expect(
        run(
          `async ({ models: { listOfType } }) => listOfType("image", { availableOnly: "no" as any })`,
          typedContext(),
        ),
      ).rejects.toThrow("options.availableOnly must be a boolean");
    });

    it("asks for one provider's models when given one", async () => {
      const getAvailableOfType = vi.fn(async () => []);
      await value(
        `async ({ models: { listOfType } }) => listOfType("classifier", { provider: "typesafe" })`,
        typedContext({ getAvailableOfType }),
      );
      expect(getAvailableOfType).toHaveBeenCalledWith("classifier", "typesafe");
    });

    it("classifies state and image files with the named model and returns its answers", async () => {
      await writeFile(`${cwd}/shot.png`, png());
      const classify = vi.fn(async (model: any) => ({
        provider: model.provider,
        model: model.id,
        answers: { broken: { type: "bool", probability: 0.9 } },
        usage,
        stopReason: "stop",
        timestamp: 1,
      }));
      const result = await value(
        `async ({ models: { classify } }) => classify({ provider: "openai", id: "luna" }, {
          state: { task: "settings page" },
          images: ["shot.png"],
          temperature: 0.5,
          questions: { broken: { type: "bool", instructions: "Broken layout?", criteria: { true: "yes", false: "no" } } },
        })`,
        typedContext({ classify }),
      );

      expect(result).toEqual({
        provider: "openai",
        model: "luna",
        usage: { input: 12, output: 3, totalTokens: 15, cost: 0.002 },
        stopReason: "stop",
        answers: { broken: { type: "bool", probability: 0.9 } },
      });
      const [model, request, options] = classify.mock.calls[0] as any[];
      expect(model).toBe(luna);
      expect(request).toMatchObject({
        state: { task: "settings page" },
        questions: { broken: { type: "bool" } },
        images: [{ type: "image", mimeType: "image/png", data: expect.any(String) }],
      });
      expect(options).toMatchObject({ temperature: 0.5, signal: expect.any(AbortSignal) });
    });

    it("returns a provider failure as data", async () => {
      const classify = vi.fn(async () => ({
        provider: "typesafe",
        model: "jev",
        answers: {},
        stopReason: "error",
        errorMessage: "quota exceeded",
        timestamp: 1,
      }));
      await expect(
        value(
          `async ({ models: { classify } }) => classify({ provider: "typesafe", id: "jev" }, {
            state: {}, questions: { mood: { type: "choice", instructions: "Mood?", criteria: { happy: "glad" } } },
          })`,
          typedContext({ classify }),
        ),
      ).resolves.toEqual({
        provider: "typesafe",
        model: "jev",
        stopReason: "error",
        errorMessage: "quota exceeded",
        answers: {},
      });
    });

    it.each<{ name: string; call: string; error: string }>([
      {
        name: "an unknown model",
        call: `classify({ provider: "typesafe", id: "missing" }, { state: {}, questions: {} })`,
        error: 'No classifier model "typesafe/missing"; models.listOfType("classifier") lists them',
      },
      {
        name: "an image model used as a classifier",
        call: `classify({ provider: "openrouter", id: "painter" }, { state: {}, questions: {} })`,
        error: 'No classifier model "openrouter/painter"',
      },
      {
        name: "no questions",
        call: `classify({ provider: "typesafe", id: "jev" }, { state: {}, questions: {} })`,
        error: "request.questions must name at least one question",
      },
      {
        name: "an unknown question type",
        call: `classify({ provider: "typesafe", id: "jev" }, { state: {}, questions: { q: { type: "rank", instructions: "?", criteria: [] } as any } })`,
        error: 'request.questions.q.type must be "choice", "score", or "bool"',
      },
      {
        name: "question criteria that are not a collection",
        call: `classify({ provider: "typesafe", id: "jev" }, { state: {}, questions: { q: { type: "bool", instructions: "?", criteria: "yes" as any } } })`,
        error: "request.questions.q.criteria must be an object or array",
      },
      {
        name: "a non-positive temperature",
        call: `classify({ provider: "typesafe", id: "jev" }, { state: {}, temperature: 0, questions: { q: { type: "score", instructions: "?", criteria: [] } } })`,
        error: "request.temperature must be a positive number",
      },
      {
        name: "more than eight images",
        call: `classify({ provider: "openai", id: "luna" }, { state: {}, images: Array(9).fill("a.png"), questions: { q: { type: "score", instructions: "?", criteria: [] } } })`,
        error: "request.images must be an array of at most 8 paths",
      },
    ])("rejects $name before calling the provider", async ({ call, error }) => {
      const classify = vi.fn();
      await expect(
        run(`async ({ models: { classify } }) => ${call}`, typedContext({ classify })),
      ).rejects.toThrow(error);
      expect(classify).not.toHaveBeenCalled();
    });

    it("runs at most four model requests at once", async () => {
      let active = 0;
      let maximum = 0;
      const classify = vi.fn(async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        return {
          provider: "typesafe",
          model: "jev",
          answers: {},
          stopReason: "stop",
          timestamp: 1,
        };
      });
      const results = await value(
        `async ({ models: { classify } }) => (await Promise.all(Array.from({ length: 6 }, () =>
          classify({ provider: "typesafe", id: "jev" }, {
            state: {}, questions: { q: { type: "score", instructions: "?", criteria: ["low", "high"] } },
          })))).length`,
        typedContext({ classify }),
      );
      expect(results).toBe(6);
      expect(maximum).toBe(4);
    });

    it("writes generated images to files and returns their paths and text", async () => {
      const data = png().toString("base64");
      const generateImages = vi.fn(async () => ({
        provider: "openrouter",
        model: "painter",
        output: [
          { type: "text", text: "A fox." },
          { type: "image", data, mimeType: "image/png" },
        ],
        stopReason: "stop",
        timestamp: 1,
      }));
      const ctx = typedContext({ generateImages });
      const inWorkspace = await value(
        `async ({ models: { generateImages } }) => generateImages({ provider: "openrouter", id: "painter" }, { prompt: "a fox", outputDir: "art" })`,
        ctx,
      );
      expect(inWorkspace).toEqual({
        provider: "openrouter",
        model: "painter",
        stopReason: "stop",
        images: [
          {
            file: expect.stringMatching(/^art\/image-\d+-1\.png$/),
            mimeType: "image/png",
            bytes: png().length,
          },
        ],
        text: ["A fox."],
      });
      expect(await readFile(`${cwd}/${inWorkspace.images[0].file}`)).toEqual(png());
      expect(generateImages).toHaveBeenCalledWith(
        painter,
        { input: [{ type: "text", text: "a fox" }] },
        { signal: expect.any(AbortSignal) },
      );

      const temporary = await value(
        `async ({ models: { generateImages } }) => generateImages({ provider: "openrouter", id: "painter" }, { prompt: "a fox" })`,
        ctx,
      );
      expect(isAbsolute(temporary.images[0].file)).toBe(true);
      expect(temporary.images[0].file).toContain("pit-images-");
    });
  });

  it("ignores unknown internal dispatch", async () => {
    const handler = createModelsHostHandler({
      pi: {} as never,
      loadImage: unusedImageLoader,
      ctx: {} as never,
    });
    await expect(handler("unknown", [], new AbortController().signal)).resolves.toBeUndefined();
  });
});
