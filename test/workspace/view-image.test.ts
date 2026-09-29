import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createImageCollector } from "../../src/workspace/view-image.js";
import { cleanupHarness, context, cwd, setupHarness } from "../support/extension-fixture.js";
import { png } from "../support/png-fixture.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createReadToolDefinition: vi.fn(actual.createReadToolDefinition),
  };
});

let temporary: string;
beforeEach(async () => {
  await setupHarness();
  temporary = await mkdtemp(join(tmpdir(), "pit-view-image-"));
});
afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
  await cleanupHarness();
});

function collector(model = context().model) {
  const images = createImageCollector(context({ model }) as unknown as ExtensionToolContext);
  const view = (path: string, signal = new AbortController().signal) => images.view([path], signal);
  return { view, attached: () => images.attached() };
}

function pngDimensions(data: string) {
  const bytes = Buffer.from(data, "base64");
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function mockProcessedImageBytes(bytes: number) {
  vi.mocked(createReadToolDefinition).mockImplementationOnce((() => ({
    execute: async () => ({
      content: [{ type: "image", data: "x".repeat(bytes), mimeType: "image/png" }],
    }),
  })) as unknown as typeof createReadToolDefinition);
}

function mockEmptyImageReader() {
  vi.mocked(createReadToolDefinition).mockImplementationOnce((() => ({
    execute: async () => ({ content: [] }),
  })) as unknown as typeof createReadToolDefinition);
}

/** Holds Pi's processing of `file` until released; the next `readers` readers are wrapped. */
async function holdProcessingOf(file: string, readers: number) {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
    "@earendil-works/pi-coding-agent",
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (let index = 0; index < readers; index++) {
    vi.mocked(createReadToolDefinition).mockImplementationOnce((cwd, options) => {
      const reader = actual.createReadToolDefinition(cwd, options);
      return {
        ...reader,
        execute: async (...args: Parameters<typeof reader.execute>) => {
          if (args[1].path.endsWith(file)) await held;
          return reader.execute(...args);
        },
      };
    });
  }
  return release;
}

describe("workspace image collector", () => {
  it.each<{
    name: string;
    path: string;
    contents?: Buffer;
    setupDirectory?: boolean;
    error: RegExp;
  }>([
    { name: "nonexistent path", path: "missing.png", error: /ENOENT/ },
    {
      name: "ordinary text file",
      path: "text.png",
      contents: Buffer.from("not an image"),
      error: /Not a supported image/,
    },
    {
      // Pi's detector rejects it; a bare "BM" prefix check would send it to the decoder.
      name: "text that starts with a bitmap signature",
      path: "notes.bmp",
      contents: Buffer.from("BM is not a bitmap"),
      error: /Not a supported image/,
    },
    {
      name: "a PNG header without image data",
      path: "broken.png",
      contents: png().subarray(0, 33),
      error: /omitted|decode|resize/i,
    },
    { name: "directory", path: "directory", setupDirectory: true, error: /regular file/ },
  ])(
    "rejects $name without attaching an image",
    async ({ path, contents, setupDirectory, error }) => {
      if (contents) await writeFile(join(cwd, path), contents);
      if (setupDirectory) await mkdir(join(cwd, path));
      const { view, attached } = collector();
      await expect(view(path)).rejects.toThrow(error);
      expect(attached()).toHaveLength(0);
    },
  );

  it("rejects result labels over 1,024 UTF-8 bytes without opening the file", async () => {
    // The path need not exist (macOS cannot create it): opening first would fail with ENOENT.
    let directory = temporary;
    for (let index = 0; index < 48; index++)
      directory = join(directory, `part-${String(index).padStart(2, "0")}-${"x".repeat(20)}`);
    const path = join(directory, "pixel.png");
    expect(Buffer.byteLength(path)).toBeGreaterThan(1_024);
    const { view, attached } = collector();
    await expect(view(path)).rejects.toThrow(/path is too long/);
    expect(attached()).toHaveLength(0);
  });

  it("rejects a file that grows while it is read", async () => {
    await writeFile(join(cwd, "pixel.png"), png());
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof open>) => {
      const handle = await actual.open(...args);
      const stat = handle.stat.bind(handle);
      // Report the size from before the file's last byte was written.
      handle.stat = (async () => {
        const info = await stat();
        return Object.assign(info, { size: info.size - 1 });
      }) as typeof handle.stat;
      return handle;
    });
    const { view, attached } = collector();
    await expect(view("pixel.png")).rejects.toThrow(/changed size while reading/);
    expect(attached()).toHaveLength(0);
  });

  it("rejects an empty decoder result", async () => {
    await writeFile(join(cwd, "pixel.png"), png());
    mockEmptyImageReader();
    const { view, attached } = collector();
    await expect(view("pixel.png")).rejects.toThrow(/Unable to decode image/);
    expect(attached()).toHaveLength(0);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO in a disposable subprocess before its deadline",
    async () => {
      const fifo = join(temporary, "pipe");
      execFileSync("mkfifo", [fifo]);
      const probe = join(temporary, "fifo-probe.mts");
      await writeFile(
        probe,
        `import { createImageCollector } from ${JSON.stringify(join(process.cwd(), "src/workspace/view-image.ts"))};
         const images = createImageCollector({ cwd: process.cwd(), model: { input: ["image"] } });
         const deadline = setTimeout(() => { console.error("FIFO open blocked"); process.exit(3); }, 2_000);
         try { await images.view([${JSON.stringify(fifo)}], new AbortController().signal); process.exitCode = 2; }
         catch (error) { if (!String(error).includes("regular file")) throw error; console.log("FIFO rejected"); }
         finally { clearTimeout(deadline); }`,
      );
      const output = execFileSync(process.execPath, ["--import", "tsx", probe], {
        cwd: process.cwd(),
        encoding: "utf8",
        // Cold tsx/Pi imports are outside the two-second FIFO operation deadline.
        timeout: 25_000,
        killSignal: "SIGKILL",
      });
      expect(output.trim()).toBe("FIFO rejected");
    },
  );

  it("rejects files above the source bound and accepts the exact bound for decoding", async () => {
    const path = join(cwd, "boundary.png");
    const valid = png(1, 1);
    await writeFile(
      path,
      Buffer.concat([valid, Buffer.alloc(10 * 1024 * 1024 + 1 - valid.length)]),
    );
    const { view } = collector();
    await expect(view(path)).rejects.toThrow(/source exceeds 10 MiB/);
    await writeFile(path, Buffer.concat([valid, Buffer.alloc(10 * 1024 * 1024 - valid.length)]));
    await expect(view(path)).resolves.toMatchObject({ queued: true });
  });

  it("checks cancellation before opening and releases the call's slot", async () => {
    await writeFile(join(cwd, "good.png"), png());
    const { view, attached } = collector();
    const controller = new AbortController();
    controller.abort();
    await expect(view("good.png", controller.signal)).rejects.toThrow();
    expect(attached()).toHaveLength(0);
    await expect(view("good.png")).resolves.toMatchObject({ queued: true });
    expect(attached()).toHaveLength(1);
  });

  it("attaches concurrent calls in call order, not completion order", async () => {
    await writeFile(join(cwd, "first.png"), png(16, 8));
    await writeFile(join(cwd, "second.png"), png(8, 4));
    const release = await holdProcessingOf("first.png", 2);
    const { view, attached } = collector();
    const first = view("first.png");
    await expect(view("second.png")).resolves.toMatchObject({ file: "second.png" });
    // A pending call is not attached yet.
    expect(attached().map(({ info }) => info.file)).toEqual(["second.png"]);
    release();
    await expect(first).resolves.toMatchObject({ file: "first.png" });
    expect(attached().map(({ info }) => info.file)).toEqual(["first.png", "second.png"]);
    expect(attached().map(({ image }) => pngDimensions(image.data))).toEqual([
      { width: 16, height: 8 },
      { width: 8, height: 4 },
    ]);
  });

  it("attaches at most 8 images per invocation, counting pending but not failed calls", async () => {
    await writeFile(join(cwd, "pixel.png"), png(1, 1));
    const { view, attached } = collector();
    await expect(view("missing.png")).rejects.toThrow(/ENOENT/);
    const results = await Promise.allSettled(Array.from({ length: 9 }, () => view("pixel.png")));
    expect(results.map(({ status }) => status)).toEqual([
      ...Array.from({ length: 8 }, () => "fulfilled"),
      "rejected",
    ]);
    expect(results[8]).toMatchObject({
      reason: expect.objectContaining({ message: expect.stringMatching(/at most 8 images/) }),
    });
    expect(attached()).toHaveLength(8);
  });

  it("accepts up to 16 MiB of encoded images per invocation", async () => {
    await writeFile(join(cwd, "pixel.png"), png());
    const { view, attached } = collector();
    for (let index = 0; index < 3; index++) {
      mockProcessedImageBytes(5 * 1024 * 1024);
      await view("pixel.png");
    }
    mockProcessedImageBytes(1024 * 1024 + 1);
    await expect(view("pixel.png")).rejects.toThrow(/exceed 16 MiB encoded/);
    mockProcessedImageBytes(1024 * 1024);
    await expect(view("pixel.png")).resolves.toMatchObject({ queued: true });
    expect(attached()).toHaveLength(4);
  });

  it("accepts processed image data exactly at the encoded cap", async () => {
    await writeFile(join(cwd, "pixel.png"), png());
    mockProcessedImageBytes(5 * 1024 * 1024);
    const { view, attached } = collector();
    await expect(view("pixel.png")).resolves.toMatchObject({ queued: true });
    expect(attached().map(({ image }) => Buffer.byteLength(image.data))).toEqual([5 * 1024 * 1024]);
  });

  it("rejects encoded data one byte over cap without attaching it and allows retry", async () => {
    await writeFile(join(cwd, "pixel.png"), png());
    mockProcessedImageBytes(5 * 1024 * 1024 + 1);
    const { view, attached } = collector();
    await expect(view("pixel.png")).rejects.toThrow(/Encoded image exceeds 5 MiB/);
    expect(attached()).toHaveLength(0);
    await expect(view("pixel.png")).resolves.toMatchObject({ queued: true });
    expect(attached()).toHaveLength(1);
  });

  it("uses model resize limits and keeps non-vision processing notes", async () => {
    await writeFile(join(cwd, "large.png"), png(32, 16));
    const model = {
      provider: "test",
      id: "small-input",
      input: ["text"],
      inputLimits: { images: { resize: { maxWidth: 8, maxHeight: 8 } } },
    };
    const { view, attached } = collector(model);
    await expect(view("large.png")).resolves.toMatchObject({ queued: true });
    const [attachment] = attached();
    expect(attachment?.info.note).toContain("original 32x16, displayed at 8x4");
    expect(attachment?.info.note).toContain("does not support images");
    expect(attachment?.info.omitted).toBe(true);
    expect(attachment && pngDimensions(attachment.image.data)).toEqual({ width: 8, height: 4 });
  });
});
