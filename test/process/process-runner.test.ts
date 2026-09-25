import { describe, expect, it, vi } from "vitest";

import {
  createProcessRunner,
  executeHostProcess,
  formatProcessCommand,
} from "../../src/process/runner.js";

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

  it("raises a bounded tail of long diagnostics with a counted omission", async () => {
    const stderr = Array.from({ length: 2_000 }, (_, index) => `error ${index}`).join("\n");
    const exec = async () => ({ stdout: "", stderr, code: 2 });
    const error = await executeHostProcess({
      pi: { exec } as any,
      defaultCwd: process.cwd(),
      program: "build",
      args: [],
      options: { raise: true },
    }).catch((failure: Error) => failure);
    const [headline, ...detail] = (error as Error).message.split("\n");

    expect(headline).toBe("Command failed with exit code 2: build");
    expect(detail[0]).toMatch(/^… \d+ lines omitted …$/);
    expect(detail.at(-1)).toBe("error 1999");
    expect(Buffer.byteLength(detail.join("\n"))).toBeLessThanOrEqual(4_000);
  });

  it("runs object requests through configured dependencies", async () => {
    const exec = async () => ({ stdout: "ok", stderr: "", code: 0 });
    const runner = createProcessRunner({ exec } as any, process.cwd());
    await expect(
      runner.run({ program: "git", args: ["status"], options: {} }),
    ).resolves.toMatchObject({ code: 0, stdout: "ok" });
  });

  it("reports timed out streaming commands as failures", async () => {
    const progress: Array<{ phase: string; code?: number }> = [];
    const result = await executeHostProcess({
      pi: {} as any,
      defaultCwd: process.cwd(),
      program: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      options: { timeoutMs: 20 },
      onProgress: (event) => progress.push(event),
    });

    expect(result).toMatchObject({ code: 124, stderr: "Command timed out after 20ms" });
    expect(progress.at(-1)).toEqual({ phase: "end", code: 124 });
  });

  it("raises streaming deadlines as named timeouts", async () => {
    await expect(
      executeHostProcess({
        pi: {} as any,
        defaultCwd: process.cwd(),
        program: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        options: { timeoutMs: 20, raise: true },
        onProgress: () => undefined,
      }),
    ).rejects.toMatchObject({
      name: "TimeoutError",
      message: expect.stringContaining("Command timed out after 20ms"),
    });
  });

  it.each<{ name: string; killed: boolean; aborted: boolean; errorName: string }>([
    { name: "a killed deadline", killed: true, aborted: false, errorName: "TimeoutError" },
    { name: "a killed cancellation", killed: true, aborted: true, errorName: "AbortError" },
    { name: "a program's own exit code 124", killed: false, aborted: false, errorName: "Error" },
  ])("names raised failures for $name by termination, not exit code", async (row) => {
    const controller = new AbortController();
    if (row.aborted) controller.abort();
    const exec = async () => ({ stdout: "", stderr: "stopped", code: 124, killed: row.killed });
    await expect(
      executeHostProcess({
        pi: { exec } as any,
        defaultCwd: process.cwd(),
        program: "worker",
        args: [],
        options: { raise: true },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: row.errorName,
      message: "Command failed with exit code 124: worker\nstopped",
    });
  });
});
