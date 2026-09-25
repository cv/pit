import { describe, expect, it } from "vitest";

import { executeStreamingProcess } from "../../src/process/host.js";

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

  it("delivers a character split across pipe chunks whole", async () => {
    const chunks: string[] = [];
    const result = await executeStreamingProcess(
      process.execPath,
      [
        "-e",
        "process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9, 0x0a])), 50);",
      ],
      { cwd: process.cwd(), timeout: 5000, onChunk: (_stream, chunk) => chunks.push(chunk) },
    );
    expect(result.stdout).toBe("é\n");
    expect(chunks.join("")).toBe("é\n");
  });

  it.each<{ keep: "head" | "tail"; first: string; last: string }>([
    { keep: "head", first: "line 0", last: "line 9" },
    { keep: "tail", first: "line 19990", last: "line 19999" },
  ])("returns only the $keep capture window of large output", async ({ keep, first, last }) => {
    const result = await executeStreamingProcess(
      process.execPath,
      ["-e", "for (let i = 0; i < 20000; i++) process.stdout.write('line ' + i + '\\n');"],
      {
        cwd: process.cwd(),
        timeout: 20_000,
        capture: { budget: { maxBytes: 10_000, maxLines: 10 }, keep },
        onChunk: () => undefined,
      },
    );
    const lines = result.stdout.trimEnd().split("\n");
    expect(result.truncated).toBe(true);
    expect(lines).toHaveLength(10);
    expect([lines[0], lines.at(-1)]).toEqual([first, last]);
  });

  it("kills timed out and aborted processes", async () => {
    const timedOut = await executeStreamingProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd: process.cwd(), timeout: 20, onChunk: () => undefined },
    );
    expect(timedOut).toMatchObject({ killed: true, termination: "timeout", code: 124 });

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
    expect(aborted).toMatchObject({ killed: true, termination: "abort", code: 130 });

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
    expect(immediate).toMatchObject({ killed: true, termination: "abort", code: 130 });
  });

  it("reports externally signaled exits as failures", async () => {
    const result = await executeStreamingProcess(
      process.execPath,
      ["-e", 'process.kill(process.pid, "SIGTERM")'],
      { cwd: process.cwd(), timeout: 0, onChunk: () => undefined },
    );
    expect(result).toMatchObject({ code: 1, killed: false });
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
