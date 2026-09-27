import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSessionCapabilityHandler } from "../../src/capabilities/handlers/session.js";
import { cleanupHarness, context, run, setupHarness, value } from "../support/extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("session capability", () => {
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
        `async ({ session: { compact: sessionCompact, getName: sessionGetName, info: sessionInfo, setName: sessionSetName } }) => sessionCompact("  Focus on capability work.  ")`,
        ctx,
      ),
    ).resolves.toEqual({
      firstKeptEntryId: "kept-entry",
      tokensBefore: 500_000,
      estimatedTokensAfter: 42_000,
    });
    expect(instructions).toBe("Focus on capability work.");
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
    const handler = createSessionCapabilityHandler({ pi: {} as never, ctx: {} as never });
    expect(handler("unknown", [])).toBeUndefined();
  });
});
