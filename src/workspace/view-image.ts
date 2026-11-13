import {
  createReadToolDefinition,
  detectSupportedImageMimeTypeFromFile,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";

import { boundText } from "../shared/bounds.js";
import {
  type AttachedImage,
  createImageAttachments,
  type ImageCollector,
  MAX_ENCODED_BYTES,
  readImageSource,
} from "./image-attachments.js";
import { checkAbort } from "./paths.js";

export type {
  AttachedImage,
  ImageAttachmentInfo,
  ImageBlock,
  ImageCollector,
} from "./image-attachments.js";

async function loadImage(
  ctx: ExtensionToolContext,
  rawPath: unknown,
  signal?: AbortSignal,
): Promise<AttachedImage> {
  const { path, file, bytes: buffer } = await readImageSource(ctx.cwd, rawPath, signal);
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
    info: { file, mimeType: image.mimeType, note, omitted: textOnly(ctx) },
  };
}

function textOnly(ctx: ExtensionToolContext): boolean {
  return ctx.model !== undefined && !ctx.model.input.includes("image");
}

// Pi runs its read tool with the context of the tool that calls it.
export function createImageCollector(ctx: ExtensionToolContext): ImageCollector {
  return createImageAttachments({
    load: (path, signal) => loadImage(ctx, path, signal),
    omitted: () => textOnly(ctx),
  });
}
