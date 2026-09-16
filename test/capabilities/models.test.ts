import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createModelsCapabilityHandler } from "../../src/capabilities/handlers/models.js";
import {
  cleanupHarness,
  context,
  run,
  setConfiguredModels,
  setupHarness,
  value,
} from "../support/extension-fixture.js";

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

describe("models capability", () => {
  it("lists available models by default and supports bounded queries", async () => {
    expect(
      await value(`async ({ models }) => ({
        available: await models.list(),
        all: await models.list({ availableOnly: false, query: "unavailable", limit: 1 }),
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
        `async ({ models }) => ({
          full: await models.list({ availableOnly: false }),
          limited: await models.list({ availableOnly: false, limit: 1 }),
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
        `async ({ models }) => ({
        current: await models.current(),
        selected: await models.set("test", "available"),
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
      value("async ({ models }) => models.current()", context({ model: undefined })),
    ).resolves.toBeUndefined();
    await expect(value(`async ({ models }) => models.set("test", "available")`)).resolves.toEqual({
      provider: "test",
      id: "available",
      changed: true,
    });
  });

  it("rejects unknown models, missing credentials, and invalid options", async () => {
    await expect(run(`async ({ models }) => models.set("test", "missing")`)).rejects.toThrow(
      "is unavailable",
    );
    await expect(run(`async ({ models }) => models.set("test", "unavailable")`)).rejects.toThrow(
      "no configured credentials",
    );
    await expect(
      run(`async ({ models }) => models.list({ availableOnly: "yes" as any })`),
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

    const result = await value("async ({ models }) => models.list({ availableOnly: false })", ctx);

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
    const cancelled = createModelsCapabilityHandler({
      pi: {} as never,
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
    const failed = createModelsCapabilityHandler({
      pi: {} as never,
      ctx: context({ modelRegistry: { ...base.modelRegistry, refresh } }) as never,
    });
    await expect(failed("set", ["test", "available"], signal)).rejects.toThrow(
      "test: provider offline",
    );
    expect(refresh).toHaveBeenCalledWith({ providers: ["test"], signal });
  });

  it("ignores unknown internal dispatch", async () => {
    const handler = createModelsCapabilityHandler({ pi: {} as never, ctx: {} as never });
    await expect(handler("unknown", [], new AbortController().signal)).resolves.toBeUndefined();
  });
});
