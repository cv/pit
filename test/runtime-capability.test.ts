import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupHarness, getRegisteredCommand, setupHarness, value } from "./extension-fixture.js";

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

  it.each([
    "pit-reload-runtime",
    "pit-shutdown",
    "pit-new-session",
    "pit-fork-session",
    "pit-clone-session",
  ])("does not register unsupported command %s", (name) => {
    expect(getRegisteredCommand(name)).toBeUndefined();
  });
});
