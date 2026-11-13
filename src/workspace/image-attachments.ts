import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { checkAbort, resolveWorkspacePath, workspaceResultPath } from "./paths.js";

/** An image content block, as Pi and pi-durable tool results carry it. */
export interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}
export interface ImageAttachmentInfo {
  file: string;
  mimeType: string;
  note: string;
  /** The model has no image input, so the host leaves the image out of its requests. */
  omitted: boolean;
}
export interface AttachedImage {
  image: ImageBlock;
  info: ImageAttachmentInfo;
}

/** Collects the images one TypeScript invocation attaches to its result. */
export interface ImageCollector {
  view(
    args: unknown[],
    signal?: AbortSignal,
  ): Promise<{ file: string; mimeType: string; queued: true }>;
  /** Images attached so far, in call order. Pending and failed calls are excluded. */
  attached(): AttachedImage[];
  /**
   * Attaches an image a tool returned. The tool call has already finished, so an image past
   * the invocation's limits is recorded as an omission instead of failing the call.
   */
  attachBlock(image: ImageBlock, source: string): void;
  /** Why returned images were not attached, in call order. */
  omissions(): string[];
  /** Reads one image for a model request as viewImage would, without attaching it. */
  load(path: unknown, signal?: AbortSignal): Promise<ImageBlock>;
}

export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_ENCODED_BYTES = 5 * 1024 * 1024;
// Per invocation, so one loop over a directory cannot flood the conversation with images.
const MAX_IMAGES = 8;
const MAX_TOTAL_ENCODED_BYTES = 16 * 1024 * 1024;

/** An image file's bytes, read once within the source limit. */
export interface ImageSource {
  /** The absolute path. */
  path: string;
  /** The path as results show it. */
  file: string;
  bytes: Buffer;
}

/** Reads an image file within the source limit, refusing non-regular files and growing files. */
export async function readImageSource(
  cwd: string,
  rawPath: unknown,
  signal?: AbortSignal,
): Promise<ImageSource> {
  const path = resolveWorkspacePath(cwd, rawPath);
  const file = workspaceResultPath(cwd, path);
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
  return { path, file, bytes: buffer };
}

export interface ImageLoader {
  /** Reads and prepares one image file. */
  load(path: unknown, signal?: AbortSignal): Promise<AttachedImage>;
  /** Whether the model has no image input, so the host leaves images out of its requests. */
  omitted(): boolean;
}

/**
 * The invocation's image collector over a host's loader: the per-invocation limits, call order,
 * and omissions are the same on every host.
 */
export function createImageAttachments(loader: ImageLoader): ImageCollector {
  // Each call reserves a slot when it starts, so concurrent calls attach in call order. A failed
  // call releases its slot; pending calls count toward the limit.
  const slots: Array<{ loaded?: AttachedImage }> = [];
  const attached = () => slots.flatMap(({ loaded }) => (loaded ? [loaded] : []));
  const attachedBytes = () =>
    attached().reduce((sum, { image }) => sum + Buffer.byteLength(image.data, "utf8"), 0);
  const omitted: string[] = [];
  const attachBlock = (image: ImageBlock, source: string) => {
    const bytes = Buffer.byteLength(image.data, "utf8");
    const total = attachedBytes() + bytes;
    const reason =
      slots.length >= MAX_IMAGES
        ? `at most ${MAX_IMAGES} images attach per invocation`
        : bytes > MAX_ENCODED_BYTES
          ? "the encoded image exceeds 5 MiB"
          : total > MAX_TOTAL_ENCODED_BYTES
            ? "images attached by one invocation would exceed 16 MiB encoded"
            : undefined;
    if (reason) {
      omitted.push(`Image from ${source} not attached: ${reason}`);
      return;
    }
    slots.push({
      loaded: {
        image: { type: "image", data: image.data, mimeType: image.mimeType },
        info: {
          file: source,
          mimeType: image.mimeType,
          note: `Returned by ${source}`,
          omitted: loader.omitted(),
        },
      },
    });
  };
  const view = async (args: unknown[], signal?: AbortSignal) => {
    checkAbort(signal);
    if (slots.length >= MAX_IMAGES)
      throw new Error(`viewImage attaches at most ${MAX_IMAGES} images per invocation`);
    const slot: { loaded?: AttachedImage } = {};
    slots.push(slot);
    try {
      const loaded = await loader.load(args[0], signal);
      const total = attachedBytes() + Buffer.byteLength(loaded.image.data, "utf8");
      if (total > MAX_TOTAL_ENCODED_BYTES)
        throw new Error("Images attached by one invocation exceed 16 MiB encoded");
      slot.loaded = loaded;
      return { file: loaded.info.file, mimeType: loaded.info.mimeType, queued: true as const };
    } catch (error) {
      slots.splice(slots.indexOf(slot), 1);
      throw error;
    }
  };
  const load = async (path: unknown, signal?: AbortSignal) =>
    (await loader.load(path, signal)).image;
  return { view, attached, attachBlock, omissions: () => [...omitted], load };
}
