import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupHarness, context, run, setupHarness, value } from "./extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("session capability", () => {
  it("reports bounded session metadata and context usage", async () => {
    expect(
      await value(`async ({ session }) => ({
        info: await session.info(),
        name: await session.getName(),
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
        contextWindow: 200000,
        contextPercent: 0.617,
      },
      name: undefined,
    });
  });

  it("reports unavailable context usage without guessing", async () => {
    const ctx = context({ getContextUsage: () => undefined });
    expect(
      await value(
        `async ({ session }) => {
        const info = await session.info();
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
      await value(`async ({ session }) => {
        const set = await session.setName("  Capability work  ");
        return { set, name: await session.getName() };
      }`),
    ).toEqual({ set: { name: "Capability work" }, name: "Capability work" });
  });

  it("rejects an empty session display name", async () => {
    await expect(run(`async ({ session }) => session.setName("   ")`)).rejects.toThrow(
      "must not be empty",
    );
  });
});
