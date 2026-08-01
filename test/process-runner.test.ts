import { describe, expect, it, vi } from "vitest";
import {
  createProcessRunner,
  executeHostProcess,
  formatProcessCommand,
} from "../src/process-runner.js";

describe("process runner", () => {
  it("runs bounded non-streaming commands without optional progress or signal", async () => {
    const exec = vi.fn(async () => ({ stdout: "ok\n", stderr: "", code: 0 }));
    const result = await executeHostProcess({
      pi: { exec } as any,
      defaultCwd: process.cwd(),
      program: "git",
      args: ["status", "--short"],
      displayCommand: "git status --short",
      options: {},
    });
    expect(result).toEqual({ stdout: "ok\n", stderr: "", code: 0, truncated: false });
    expect(exec).toHaveBeenCalledWith("git", ["status", "--short"], {
      cwd: process.cwd(),
      timeout: 120_000,
    });
    expect(formatProcessCommand("git", ["status", "two words"])).toBe('git "status" "two words"');
  });

  it("runs object requests through configured dependencies", async () => {
    const exec = async () => ({ stdout: "ok", stderr: "", code: 0 });
    const runner = createProcessRunner({ exec } as any, process.cwd());
    await expect(
      runner.run({ program: "git", args: ["status"], options: {} }),
    ).resolves.toMatchObject({ code: 0, stdout: "ok" });
  });
});
