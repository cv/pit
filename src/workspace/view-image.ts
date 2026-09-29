import { constants } from "node:fs";
import { open } from "node:fs/promises";

import {
  createReadToolDefinition,
  detectSupportedImageMimeTypeFromFile,
  type AgentToolResult,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { boundText } from "../shared/bounds.js";
import { checkAbort, resolveWorkspacePath, workspaceResultPath } from "./paths.js";

export type ImageBlock = Extract<AgentToolResult<undefined>["content"][number], { type: "image" }>;
export interface ImageAttachmentInfo {
  file: string;
  mimeType: string;
  note: string;
  /** The model has no image input, so Pi leaves the image out of its requests. */
  omitted: boolean;
}
export interface AttachedImage {
  image: ImageBlock;
  info: ImageAttachmentInfo;
}

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_ENCODED_BYTES = 5 * 1024 * 1024;
// Per invocation, so one loop over a directory cannot flood the conversation with images.
const MAX_IMAGES = 8;
const MAX_TOTAL_ENCODED_BYTES = 16 * 1024 * 1024;

async function loadImage(
  ctx: ExtensionContext,
  rawPath: unknown,
  signal?: AbortSignal,
): Promise<AttachedImage> {
  const path = resolveWorkspacePath(ctx.cwd, rawPath);
  const file = workspaceResultPath(ctx.cwd, path);
  if (Buffer.byteLength(file) > 1024) throw new Error("Image path is too long for a result label");

  // O_NONBLOCK prevents a pathname swapped to a FIFO between checks from hanging here.
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let buffer: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Image path must refer to a regular file");
    if (info.size > MAX_SOURCE_BYTES) throw new Error("Image source exceeds 10 MiB");
    buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      checkAbort(signal);
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > info.size) throw new Error("Image changed size while reading; retry");
    buffer = buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
  checkAbort(signal);
  // Pi's read tool owns image recognition, so both accept the same formats. Detection reopens
  // the path; only the bounded bytes read above are decoded and attached.
  const mimeType = await detectSupportedImageMimeTypeFromFile(path);
  if (!mimeType) throw new Error(`Not a supported image: ${file}`);
  const reader = createReadToolDefinition(ctx.cwd, {
    operations: {
      access: async () => {},
      readFile: async () => buffer,
      detectImageMimeType: async () => mimeType,
    },
  });
  const result = await reader.execute("pit-view-image", { path }, signal, undefined, ctx);
  checkAbort(signal);
  const image = result.content.find((block) => block.type === "image");
  const rawNote = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const note = boundText(rawNote, { maxBytes: 2048 }, "ends").text;
  if (!image) throw new Error(note || `Unable to decode image: ${file}`);
  if (Buffer.byteLength(image.data, "utf8") > MAX_ENCODED_BYTES)
    throw new Error("Encoded image exceeds 5 MiB");
  return {
    image,
    info: {
      file,
      mimeType: image.mimeType,
      note,
      omitted: ctx.model !== undefined && !ctx.model.input.includes("image"),
    },
  };
}

/** Collects the images one TypeScript invocation attaches to its result. */
export interface ImageCollector {
  view(
    args: unknown[],
    signal?: AbortSignal,
  ): Promise<{ file: string; mimeType: string; queued: true }>;
  /** Images attached so far, in call order. Pending and failed calls are excluded. */
  attached(): AttachedImage[];
}

export function createImageCollector(ctx: ExtensionContext): ImageCollector {
  // Each call reserves a slot when it starts, so concurrent calls attach in call order. A failed
  // call releases its slot; pending calls count toward the limit.
  const slots: Array<{ loaded?: AttachedImage }> = [];
  const attached = () => slots.flatMap(({ loaded }) => (loaded ? [loaded] : []));
  const view = async (args: unknown[], signal?: AbortSignal) => {
    checkAbort(signal);
    if (slots.length >= MAX_IMAGES)
      throw new Error(`viewImage attaches at most ${MAX_IMAGES} images per invocation`);
    const slot: { loaded?: AttachedImage } = {};
    slots.push(slot);
    try {
      const loaded = await loadImage(ctx, args[0], signal);
      const total = attached().reduce(
        (bytes, { image }) => bytes + Buffer.byteLength(image.data, "utf8"),
        Buffer.byteLength(loaded.image.data, "utf8"),
      );
      if (total > MAX_TOTAL_ENCODED_BYTES)
        throw new Error("Images attached by one invocation exceed 16 MiB encoded");
      slot.loaded = loaded;
      return { file: loaded.info.file, mimeType: loaded.info.mimeType, queued: true as const };
    } catch (error) {
      slots.splice(slots.indexOf(slot), 1);
      throw error;
    }
  };
  return { view, attached };
}
