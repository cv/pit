import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupHarness,
  context,
  getRegisteredCommand,
  sentUserMessages,
  setupHarness,
  value,
} from "./extension-fixture.js";

beforeEach(setupHarness);
afterEach(cleanupHarness);

describe("runtime capability", () => {
  it("reports runtime status", async () => {
    await expect(value("async ({ runtime }) => runtime.status()")).resolves.toEqual({
      mode: "interactive",
      idle: true,
      pendingMessages: false,
    });
  });

  it("queues reload and shutdown as follow-up commands", async () => {
    await expect(
      value(`async ({ runtime }) => ({
        reload: await runtime.requestReload(),
        shutdown: await runtime.requestShutdown(),
      })`),
    ).resolves.toEqual({
      reload: { queued: true, command: "/pit-reload-runtime" },
      shutdown: { queued: true, command: "/pit-shutdown" },
    });
    expect(sentUserMessages).toEqual([
      { content: "/pit-reload-runtime", options: { deliverAs: "followUp" } },
      { content: "/pit-shutdown", options: { deliverAs: "followUp" } },
    ]);
  });

  it("confirms and dispatches reload and shutdown commands", async () => {
    const waitForIdle = vi.fn(async () => undefined);
    const reload = vi.fn(async () => undefined);
    const shutdown = vi.fn();
    const ctx = context({ waitForIdle, reload, shutdown });

    await getRegisteredCommand("pit-reload-runtime").handler("", ctx);
    await getRegisteredCommand("pit-shutdown").handler("", ctx);

    expect(waitForIdle).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("cancels reload and shutdown commands", async () => {
    const reload = vi.fn();
    const shutdown = vi.fn();
    const base = context();
    const ctx = context({
      ui: { ...base.ui, confirm: vi.fn(async () => false) },
      waitForIdle: vi.fn(async () => undefined),
      reload,
      shutdown,
    });

    await getRegisteredCommand("pit-reload-runtime").handler("", ctx);
    await getRegisteredCommand("pit-shutdown").handler("", ctx);

    expect(reload).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
  });
});
