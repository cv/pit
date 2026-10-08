import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionHostHandler } from "../../src/host/handlers/session.js";
import { cleanupHarness, context, run, setupHarness, value } from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);
afterEach(() => vi.unstubAllEnvs());

describe("session namespace", () => {
  it("reports bounded session metadata and context usage", async () => {
    expect(
      await value(`async ({ session: { compact: sessionCompact, getName: sessionGetName, info: sessionInfo, setName: sessionSetName } }) => ({
        info: await sessionInfo(),
        name: await sessionGetName(),
      })`),
    ).toEqual({
      info: {
        id: "test-session-id",
        file: "/tmp/session.jsonl",
        name: undefined,
        leafId: null,
        entryCount: 0,
        branchEntryCount: 0,
        contextTokens: 1234,
        contextWindow: 200_000,
        contextPercent: 0.617,
        cache: { state: "unknown", idleSeconds: null, ttlSeconds: null, refreshedBy: null },
      },
      name: undefined,
    });
  });

  it("reports unavailable context usage without guessing", async () => {
    const ctx = context({ getContextUsage: () => undefined });
    expect(
      await value(
        `async ({ session: { compact: sessionCompact, getName: sessionGetName, info: sessionInfo, setName: sessionSetName } }) => {
        const info = await sessionInfo();
        return {
          tokens: info.contextTokens ?? null,
          window: info.contextWindow ?? null,
          percent: info.contextPercent ?? null,
        };
      }`,
        ctx,
      ),
    ).toEqual({ tokens: null, window: null, percent: null });
  });

  describe("prompt-cache state", () => {
    const usage = {
      input: 10,
      output: 5,
      cacheRead: 1000,
      cacheWrite: 0,
      totalTokens: 1015,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const request = (manager: SessionManager, secondsAgo: number, model = "m") =>
      manager.appendMessage({
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "p",
        model,
        usage,
        stopReason: "stop",
        timestamp: Date.now() - secondsAgo * 1000,
      } as Parameters<SessionManager["appendMessage"]>[0]);

    it.each<{
      name: string;
      build: (manager: SessionManager) => void;
      retention?: string;
      promptCache?: { short?: number; long?: number };
      expected: {
        state: string;
        idleSeconds: number | null;
        ttlSeconds: number | null;
        refreshedBy: string | null;
      };
    }>([
      {
        name: "a request within the lifetime keeps it warm",
        build: (manager) => request(manager, 60),
        expected: { state: "warm", idleSeconds: 60, ttlSeconds: 300, refreshedBy: "request" },
      },
      {
        name: "a request older than the lifetime leaves it cold",
        build: (manager) => request(manager, 400),
        expected: { state: "cold", idleSeconds: 400, ttlSeconds: 300, refreshedBy: "request" },
      },
      {
        name: "long retention uses the long lifetime",
        retention: "long",
        build: (manager) => request(manager, 400),
        expected: { state: "warm", idleSeconds: 400, ttlSeconds: 3600, refreshedBy: "request" },
      },
      {
        name: "a cache_warm refresh since the request keeps it warm",
        build: (manager) => {
          request(manager, 400);
          manager.appendUsage("cache_warm", "p", "m", usage);
        },
        expected: { state: "warm", idleSeconds: 0, ttlSeconds: 300, refreshedBy: "warming" },
      },
      {
        name: "a compaction since the request leaves nothing cached",
        build: (manager) => {
          const kept = manager.appendMessage({
            role: "user",
            content: "next",
            timestamp: Date.now(),
          });
          request(manager, 10);
          manager.appendCompaction("summary", kept, 1000);
        },
        expected: { state: "cold", idleSeconds: null, ttlSeconds: 300, refreshedBy: null },
      },
      {
        name: "a request by another model leaves nothing cached for this one",
        build: (manager) => request(manager, 10, "other"),
        expected: { state: "cold", idleSeconds: null, ttlSeconds: 300, refreshedBy: null },
      },
      {
        name: "a model without a lifetime reports unknown, not cold",
        promptCache: {},
        build: (manager) => request(manager, 400),
        expected: { state: "unknown", idleSeconds: 400, ttlSeconds: null, refreshedBy: "request" },
      },
      {
        name: "no request yet is cold",
        build: () => {},
        expected: { state: "cold", idleSeconds: null, ttlSeconds: 300, refreshedBy: null },
      },
    ])(
      "$name",
      async ({ build, retention, promptCache = { short: 300, long: 3600 }, expected }) => {
        if (retention) vi.stubEnv("PI_CACHE_RETENTION", retention);
        const manager = SessionManager.inMemory("/tmp/pit-cache-state");
        build(manager);
        const ctx = context({
          sessionManager: manager,
          model: { provider: "p", id: "m", contextWindow: 200_000, promptCache },
        });
        const { info, outline } = await value(
          "async ({ session: { info, outline } }) => ({ info: (await info()).cache, outline: (await outline()).cache })",
          ctx,
        );
        expect(outline).toEqual(info);
        // The test's own runtime adds a moment to the idle time, so compare to the nearest 10 s.
        const idle = info.idleSeconds === null ? null : Math.round(info.idleSeconds / 10) * 10;
        expect({ ...info, idleSeconds: idle }).toEqual(expected);
      },
    );
  });

  it("sets and returns a normalized session display name", async () => {
    expect(
      await value(`async ({ session: { compact: sessionCompact, getName: sessionGetName, info: sessionInfo, setName: sessionSetName } }) => {
        const set = await sessionSetName("  Capability work  ");
        return { set, name: await sessionGetName() };
      }`),
    ).toEqual({ set: { name: "Capability work" }, name: "Capability work" });
  });

  it("rejects an empty session display name", async () => {
    await expect(
      run(
        `async ({ session: { compact: sessionCompact, getName: sessionGetName, info: sessionInfo, setName: sessionSetName } }) => sessionSetName("   ")`,
      ),
    ).rejects.toThrow("must not be empty");
  });

  it("awaits compaction and returns bounded metadata", async () => {
    let instructions: string | undefined;
    const ctx = context({
      compact: (options: any) => {
        instructions = options.customInstructions;
        queueMicrotask(() =>
          options.onComplete({
            summary: "large generated summary",
            firstKeptEntryId: "kept-entry",
            tokensBefore: 500_000,
            estimatedTokensAfter: 42_000,
          }),
        );
      },
    });
    await expect(
      value(
        `async ({ session: { compact: sessionCompact, getName: sessionGetName, info: sessionInfo, setName: sessionSetName } }) => sessionCompact("  Focus on namespace work.  ")`,
        ctx,
      ),
    ).resolves.toEqual({
      firstKeptEntryId: "kept-entry",
      tokensBefore: 500_000,
      estimatedTokensAfter: 42_000,
    });
    expect(instructions).toBe("Focus on namespace work.");
  });

  it("propagates compaction failures", async () => {
    const ctx = context({
      compact: (options: any) => queueMicrotask(() => options.onError(new Error("compact failed"))),
    });
    await expect(
      run(
        "async ({ session: { compact: sessionCompact, getName: sessionGetName, info: sessionInfo, setName: sessionSetName } }) => sessionCompact()",
        ctx,
      ),
    ).rejects.toThrow("compact failed");
  });

  it("ignores unknown internal dispatch", async () => {
    const handler = createSessionHostHandler({ pi: {} as never, ctx: {} as never });
    expect(handler("unknown", [])).toBeUndefined();
  });
});
