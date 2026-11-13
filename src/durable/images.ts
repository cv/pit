import type { ModelInputLimits } from "@earendil-works/pi-ai";
import type { ImageLimits, ImageProcessor } from "@earendil-works/pi-durable/tools";

import {
  type AttachedImage,
  createImageAttachments,
  type ImageCollector,
  MAX_ENCODED_BYTES,
  readImageSource,
} from "../workspace/image-attachments.js";
import { checkAbort } from "../workspace/paths.js";

/** The conversation model's image input, as pi-durable's `read` reads it. */
export interface DurableImageModel {
  readonly input: readonly string[];
  readonly inputLimits?: ModelInputLimits;
}

/** Formats every provider takes inline; others, such as BMP, need an image processor. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** The image type the file's magic bytes declare, or `undefined` for anything else. */
export function detectImageType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(bytes, ascii("BM")) && bytes.length >= 26) return "image/bmp";
  return undefined;
}

/**
 * pi-durable's `DEFAULT_IMAGE_LIMITS`, which `read` applies too. Copied, so the durable entry
 * keeps needing pi-durable only for types.
 */
const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maxWidth: 2000,
  maxHeight: 2000,
  maxBytes: 4.5 * 1024 * 1024,
};

const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

/** `DEFAULT_IMAGE_LIMITS` overridden by the model's resize profile, as pi-durable's `read` does. */
function imageLimits(model: DurableImageModel | undefined): ImageLimits {
  const resize = model?.inputLimits?.images?.resize;
  return {
    maxWidth: resize?.maxWidth ?? DEFAULT_IMAGE_LIMITS.maxWidth,
    maxHeight: resize?.maxHeight ?? DEFAULT_IMAGE_LIMITS.maxHeight,
    // Never past the encoded limit images have on Pi.
    maxBytes: Math.min(resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes, MAX_ENCODED_BYTES),
  };
}

export interface DurableImageInput {
  cwd: string;
  model: DurableImageModel | undefined;
  /** Resizes and converts images; without one, supported images within the limit pass as they are. */
  processor: ImageProcessor | undefined;
}

async function loadImage(
  input: DurableImageInput,
  rawPath: unknown,
  signal?: AbortSignal,
): Promise<AttachedImage> {
  const { file, bytes } = await readImageSource(input.cwd, rawPath, signal);
  const mimeType = detectImageType(bytes);
  if (!mimeType) throw new Error(`Not a supported image: ${file}`);
  const limits = imageLimits(input.model);
  const notes: string[] = [];
  let image: { data: string; mimeType: string };
  if (input.processor) {
    const prepared = await input.processor.prepare(bytes, mimeType, limits);
    checkAbort(signal);
    if (!prepared) throw new Error(`Unable to prepare image for the model: ${file}`);
    image = prepared;
    if (prepared.convertedFrom !== undefined)
      notes.push(`Converted from ${prepared.convertedFrom} to ${prepared.mimeType}.`);
    if (prepared.resized !== undefined) {
      const { from, to } = prepared.resized;
      const scale = (from.width / to.width).toFixed(2);
      notes.push(
        `Resized from ${from.width}x${from.height} to ${to.width}x${to.height}. Multiply coordinates by ${scale} to map them to the original.`,
      );
    }
  } else {
    const unconfigured = "and the host configured no image processor";
    if (!INLINE_TYPES.has(mimeType))
      throw new Error(`${file} is an image (${mimeType}) that needs converting, ${unconfigured}`);
    if (base64Length(bytes.length) > limits.maxBytes)
      throw new Error(`${file} is too large to attach, ${unconfigured} to shrink it`);
    image = { data: bytes.toString("base64"), mimeType };
  }
  if (Buffer.byteLength(image.data, "utf8") > MAX_ENCODED_BYTES)
    throw new Error("Encoded image exceeds 5 MiB");
  const omitted = textOnly(input.model);
  if (omitted) notes.push("The current model does not support images; it is left out of its requests.");
  return {
    image: { type: "image", data: image.data, mimeType: image.mimeType },
    info: {
      file,
      mimeType: image.mimeType,
      note: [`Read image file [${image.mimeType}].`, ...notes].join(" "),
      omitted,
    },
  };
}

function textOnly(model: DurableImageModel | undefined): boolean {
  return model !== undefined && !model.input.includes("image");
}

/**
 * The images one pi-durable call attaches: `workspace.viewImage`, images for model requests, and
 * images nested tools return, with the limits they have on Pi.
 */
export function createDurableImageCollector(input: DurableImageInput): ImageCollector {
  return createImageAttachments({
    load: (path, signal) => loadImage(input, path, signal),
    omitted: () => textOnly(input.model),
  });
}
