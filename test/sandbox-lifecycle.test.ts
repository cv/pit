import { describe, expect, it, vi } from "vitest";

import { SandboxLifecycle } from "../src/sandbox-lifecycle.js";

describe("SandboxLifecycle", () => {
  it("settles once, aborts capability work, and kills the child", () => {
    vi.useFakeTimers();
    try {
      const child = { kill: vi.fn() };
      const resolve = vi.fn();
      const reject = vi.fn();
      const lifecycle = new SandboxLifecycle({
        child: child as any,
        timeoutMs: 1_000,
        resolve,
        reject,
      });
      lifecycle.finish(undefined, 42);
      lifecycle.finish(new Error("late"));
      expect(resolve).toHaveBeenCalledWith(42);
      expect(reject).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(lifecycle.capabilitySignal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors an already-aborted caller signal", () => {
    const controller = new AbortController();
    controller.abort();
    const child = { kill: vi.fn() };
    const reject = vi.fn();
    const lifecycle = new SandboxLifecycle({
      child: child as any,
      timeoutMs: 1_000,
      signal: controller.signal,
      resolve: vi.fn(),
      reject,
    });
    expect(lifecycle.settled).toBe(true);
    expect(reject.mock.calls[0]?.[0]).toMatchObject({ message: "TypeScript execution cancelled" });
  });
});
