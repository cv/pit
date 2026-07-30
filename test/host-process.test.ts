import { describe, expect, it } from "vitest";
import { executeStreamingProcess } from "../src/host-process.js";

describe("executeStreamingProcess", () => {
  it("streams separate stdout and stderr while preserving the final result", async () => {
    const chunks: Array<{ stream: string; chunk: string }> = [];
    const result = await executeStreamingProcess(
      process.execPath,
      ["-e", 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3;'],
      {
        cwd: process.cwd(),
        timeout: 0,
        onChunk: (stream, chunk) => chunks.push({ stream, chunk }),
      },
    );
    expect(result).toMatchObject({ stdout: "out", stderr: "err", code: 3, killed: false });
    expect(chunks).toEqual(
      expect.arrayContaining([
        { stream: "stdout", chunk: "out" },
        { stream: "stderr", chunk: "err" },
      ]),
    );
  });

  it("kills timed out and aborted processes", async () => {
    const timedOut = await executeStreamingProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd: process.cwd(), timeout: 20, onChunk: () => undefined },
    );
    expect(timedOut.killed).toBe(true);

    const controller = new AbortController();
    const abortedPromise = executeStreamingProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        cwd: process.cwd(),
        timeout: 5000,
        signal: controller.signal,
        onChunk: () => undefined,
      },
    );
    controller.abort();
    const aborted = await abortedPromise;
    expect(aborted.killed).toBe(true);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const immediate = await executeStreamingProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        cwd: process.cwd(),
        timeout: 5000,
        signal: alreadyAborted.signal,
        onChunk: () => undefined,
      },
    );
    expect(immediate.killed).toBe(true);
  });

  it("returns a failed result when spawning fails", async () => {
    const result = await executeStreamingProcess("/definitely/missing/program", [], {
      cwd: process.cwd(),
      timeout: 5000,
      onChunk: () => undefined,
    });
    expect(result).toMatchObject({ code: 1, killed: false });
  });
});
