import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupHarness,
  context,
  getRegisteredCommand,
  run,
  sentUserMessages,
  setupHarness,
  value,
} from "./extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("session control bridge", () => {
  it("queues replacement requests as follow-up commands", async () => {
    expect(
      await value(`async ({ session }) => ({
        created: await session.requestNew(),
        forked: await session.requestFork("entry-1"),
        cloned: await session.requestClone("entry-2"),
      })`),
    ).toEqual({
      created: { queued: true, command: "/pit-new-session" },
      forked: { queued: true, command: "/pit-fork-session entry-1" },
      cloned: { queued: true, command: "/pit-clone-session entry-2" },
    });
    expect(sentUserMessages).toEqual([
      { content: "/pit-new-session", options: { deliverAs: "followUp" } },
      { content: "/pit-fork-session entry-1", options: { deliverAs: "followUp" } },
      { content: "/pit-clone-session entry-2", options: { deliverAs: "followUp" } },
    ]);
  });

  it("requires nonempty replacement entry IDs", async () => {
    await expect(run(`async ({ session }) => session.requestFork("  ")`)).rejects.toThrow(
      "must not be empty",
    );
  });

  it("confirms and dispatches new, fork, and clone commands", async () => {
    const waitForIdle = vi.fn(async () => undefined);
    const newSession = vi.fn(async () => ({ cancelled: false }));
    const fork = vi.fn(async () => ({ cancelled: false }));
    const ctx = context({ waitForIdle, newSession, fork });

    await getRegisteredCommand("pit-new-session").handler("", ctx);
    await getRegisteredCommand("pit-fork-session").handler("entry-1", ctx);
    await getRegisteredCommand("pit-clone-session").handler("entry-2", ctx);

    expect(waitForIdle).toHaveBeenCalledTimes(3);
    expect(newSession).toHaveBeenCalledWith({ parentSession: "/tmp/session.jsonl" });
    expect(fork).toHaveBeenNthCalledWith(1, "entry-1", { position: "before" });
    expect(fork).toHaveBeenNthCalledWith(2, "entry-2", { position: "at" });
  });

  it("cancels replacement commands and rejects missing entry IDs", async () => {
    const newSession = vi.fn();
    const fork = vi.fn();
    const ctx = context({
      ui: {
        ...context().ui,
        confirm: vi.fn(async () => false),
        notify: vi.fn(),
      },
      waitForIdle: vi.fn(async () => undefined),
      newSession,
      fork,
    });
    await getRegisteredCommand("pit-new-session").handler("", ctx);
    await getRegisteredCommand("pit-fork-session").handler("entry-1", ctx);
    await getRegisteredCommand("pit-fork-session").handler("", ctx);
    expect(newSession).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Fork requires an entry ID", "error");
  });

  it("starts an ephemeral replacement session without a parent path", async () => {
    const base = context();
    const newSession = vi.fn(async () => ({ cancelled: false }));
    const ctx = context({
      sessionManager: {
        ...base.sessionManager,
        getSessionFile: () => undefined,
      },
      waitForIdle: vi.fn(async () => undefined),
      newSession,
    });
    await getRegisteredCommand("pit-new-session").handler("", ctx);
    expect(newSession).toHaveBeenCalledWith({});
  });
});
