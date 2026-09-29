import { constants } from "node:fs";
import { open } from "node:fs/promises";

import {
  createReadToolDefinition,
  detectSupportedImageMimeTypeFromFile,
  type AgentToolResult,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { boundText } from "../shared/bounds.js";
import { resolveWorkspacePath, workspaceResultPath } from "../workspace/paths.js";

export type ImageAttachments = AgentToolResult<undefined>["content"];
export interface ImageAttachmentInfo {
  file: string;
  mimeType: string;
  note: string;
  /** The model has no image input, so Pi leaves the image out of its requests. */
  omitted: boolean;
}
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_ENCODED_BYTES = 5 * 1024 * 1024;

// One successful image per invocation; failures leave the slot available for retry.
export function createImageViewer(
  ctx: ExtensionContext,
  attachments: ImageAttachments,
  metadata: ImageAttachmentInfo[],
) {
  let busy = false;
  let attached = false;
  return async (args: unknown[], signal: AbortSignal) => {
    signal.throwIfAborted();
    if (busy || attached)
      throw new Error("Only one successful viewImage call is allowed per invocation");
    busy = true;
    try {
      const path = resolveWorkspacePath(ctx.cwd, args[0]);
      const file = workspaceResultPath(ctx.cwd, path);
      if (Buffer.byteLength(file) > 1024)
        throw new Error("Image path is too long for a result label");

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
          signal.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > info.size) throw new Error("Image changed size while reading; retry");
        buffer = buffer.subarray(0, length);
      } finally {
        await handle.close();
      }
      signal.throwIfAborted();
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
      signal.throwIfAborted();
      const image = result.content.find((block) => block.type === "image");
      const rawNote = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const note = boundText(rawNote, { maxBytes: 2048 }, "ends").text;
      if (!image) throw new Error(note || `Unable to decode image: ${file}`);
      if (Buffer.byteLength(image.data, "utf8") > MAX_ENCODED_BYTES)
        throw new Error("Encoded image exceeds 5 MiB");
      attachments.push(image);
      metadata.push({
        file,
        mimeType: image.mimeType,
        note,
        omitted: ctx.model !== undefined && !ctx.model.input.includes("image"),
      });
      attached = true;
      return { file, mimeType: image.mimeType, queued: true };
    } finally {
      busy = false;
    }
  };
}
