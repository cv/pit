import { describe, expect, it, vi } from "vitest";
import { executeHostProcess, formatProcessCommand } from "../src/process-runner.js";

describe("process runner", () => {
  it("runs bounded non-streaming commands without optional progress or signal", async () => {
    const exec = vi.fn(async () => ({ stdout: "ok\n", stderr: "", code: 0 }));
    const result = await executeHostProcess(
      { exec } as any,
      "git",
      ["status", "--short"],
      "git status --short",
      {},
      process.cwd(),
    );
    expect(result).toEqual({ stdout: "ok\n", stderr: "", code: 0, truncated: false });
    expect(exec).toHaveBeenCalledWith("git", ["status", "--short"], {
      cwd: process.cwd(),
      timeout: 120_000,
    });
    expect(formatProcessCommand("git", ["status", "two words"])).toBe('git "status" "two words"');
  });
});
