import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createImageViewer,
  type ImageAttachmentInfo,
  type ImageAttachments,
} from "../../src/host/view-image.js";
import { cleanupHarness, context, cwd, setupHarness } from "../support/extension-fixture.js";
import { png } from "../support/png-fixture.js";

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

function viewer(model = context().model) {
  const attachments: ImageAttachments = [];
  const metadata: ImageAttachmentInfo[] = [];
  const view = createImageViewer(
    context({ model }) as unknown as ExtensionContext,
    attachments,
    metadata,
  );
  return { view, attachments, metadata };
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

describe("workspace image host helper", () => {
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
    "rejects $name without publishing an attachment",
    async ({ path, contents, setupDirectory, error }) => {
      if (contents) await writeFile(join(cwd, path), contents);
      if (setupDirectory) await mkdir(join(cwd, path));
      const { view, attachments, metadata } = viewer();
      await expect(view([path], new AbortController().signal)).rejects.toThrow(error);
      expect(attachments).toHaveLength(0);
      expect(metadata).toHaveLength(0);
    },
  );

  it("rejects result labels over 1,024 UTF-8 bytes without opening the file", async () => {
    // The path need not exist (macOS cannot create it): opening first would fail with ENOENT.
    let directory = temporary;
    for (let index = 0; index < 48; index++)
      directory = join(directory, `part-${String(index).padStart(2, "0")}-${"x".repeat(20)}`);
    const path = join(directory, "pixel.png");
    expect(Buffer.byteLength(path)).toBeGreaterThan(1_024);
    const { view, attachments, metadata } = viewer();
    await expect(view([path], new AbortController().signal)).rejects.toThrow(/path is too long/);
    expect(attachments).toHaveLength(0);
    expect(metadata).toHaveLength(0);
  });

  it("rejects an empty decoder result without consuming the retry slot", async () => {
    await writeFile(join(cwd, "pixel.png"), png());
    mockEmptyImageReader();
    const { view, attachments, metadata } = viewer();
    await expect(view(["pixel.png"], new AbortController().signal)).rejects.toThrow(
      /Unable to decode image/,
    );
    expect(attachments).toHaveLength(0);
    expect(metadata).toHaveLength(0);
    await expect(view(["pixel.png"], new AbortController().signal)).resolves.toMatchObject({
      queued: true,
    });
    expect(attachments).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO in a disposable subprocess before its deadline",
    async () => {
      const fifo = join(temporary, "pipe");
      execFileSync("mkfifo", [fifo]);
      const probe = join(temporary, "fifo-probe.mts");
      await writeFile(
        probe,
        `import { createImageViewer } from ${JSON.stringify(join(process.cwd(), "src/host/view-image.ts"))};
         const view = createImageViewer({ cwd: process.cwd(), model: { input: ["image"] } }, [], []);
         const deadline = setTimeout(() => { console.error("FIFO open blocked"); process.exit(3); }, 2_000);
         try { await view([${JSON.stringify(fifo)}], new AbortController().signal); process.exitCode = 2; }
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
    const { view } = viewer();
    await expect(view([path], new AbortController().signal)).rejects.toThrow(
      /source exceeds 10 MiB/,
    );
    await writeFile(path, Buffer.concat([valid, Buffer.alloc(10 * 1024 * 1024 - valid.length)]));
    await expect(view([path], new AbortController().signal)).resolves.toMatchObject({
      queued: true,
    });
  });

  it("checks cancellation before opening and leaves the slot available", async () => {
    await writeFile(join(cwd, "good.png"), png());
    const { view, attachments } = viewer();
    const controller = new AbortController();
    controller.abort();
    await expect(view(["good.png"], controller.signal)).rejects.toThrow();
    await expect(view(["good.png"], new AbortController().signal)).resolves.toMatchObject({
      queued: true,
    });
    expect(attachments).toHaveLength(1);
  });

  it("rejects overlapping calls and enforces one successful image", async () => {
    await writeFile(join(cwd, "good.png"), png());
    const { view, attachments } = viewer();
    const first = view(["good.png"], new AbortController().signal);
    await expect(view(["good.png"], new AbortController().signal)).rejects.toThrow(
      /Only one successful/,
    );
    await expect(first).resolves.toMatchObject({ queued: true });
    await expect(view(["good.png"], new AbortController().signal)).rejects.toThrow(
      /Only one successful/,
    );
    expect(attachments).toHaveLength(1);
  });

  it("allows retry after an ordinary failed read", async () => {
    await writeFile(join(cwd, "good.png"), png());
    const { view, attachments } = viewer();
    await expect(view(["missing.png"], new AbortController().signal)).rejects.toThrow(/ENOENT/);
    await expect(view(["good.png"], new AbortController().signal)).resolves.toMatchObject({
      queued: true,
    });
    expect(attachments).toHaveLength(1);
  });

  it("accepts processed image data exactly at the encoded cap", async () => {
    await writeFile(join(cwd, "pixel.png"), png());
    mockProcessedImageBytes(5 * 1024 * 1024);
    const { view, attachments, metadata } = viewer();
    await expect(view(["pixel.png"], new AbortController().signal)).resolves.toMatchObject({
      queued: true,
    });
    expect(attachments).toHaveLength(1);
    expect(metadata).toHaveLength(1);
    const image = attachments.find((block) => block.type === "image");
    expect(image?.type).toBe("image");
    expect(image?.type === "image" ? Buffer.byteLength(image.data) : -1).toBe(5 * 1024 * 1024);
  });

  it("rejects encoded data one byte over cap without queuing and allows retry", async () => {
    await writeFile(join(cwd, "pixel.png"), png());
    mockProcessedImageBytes(5 * 1024 * 1024 + 1);
    const { view, attachments, metadata } = viewer();
    await expect(view(["pixel.png"], new AbortController().signal)).rejects.toThrow(
      /Encoded image exceeds 5 MiB/,
    );
    expect(attachments).toHaveLength(0);
    expect(metadata).toHaveLength(0);
    await expect(view(["pixel.png"], new AbortController().signal)).resolves.toMatchObject({
      queued: true,
    });
    expect(attachments).toHaveLength(1);
    expect(metadata).toHaveLength(1);
  });

  it("uses model resize limits and keeps non-vision processing notes", async () => {
    await writeFile(join(cwd, "large.png"), png(32, 16));
    const model = {
      provider: "test",
      id: "small-input",
      input: ["text"],
      inputLimits: { images: { resize: { maxWidth: 8, maxHeight: 8 } } },
    };
    const { view, metadata, attachments } = viewer(model);
    await expect(view(["large.png"], new AbortController().signal)).resolves.toMatchObject({
      queued: true,
    });
    expect(metadata[0]?.note).toContain("original 32x16, displayed at 8x4");
    expect(metadata[0]?.note).toContain("does not support images");
    expect(metadata[0]?.omitted).toBe(true);
    const attachment = attachments.find((block) => block.type === "image");
    expect(attachment?.type).toBe("image");
    expect(attachment?.type === "image" ? pngDimensions(attachment.data) : undefined).toEqual({
      width: 8,
      height: 4,
    });
    expect(
      attachment?.type === "image" ? Buffer.byteLength(attachment.data) : -1,
    ).toBeLessThanOrEqual(5 * 1024 * 1024);
  });
});
