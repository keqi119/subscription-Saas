import { Readable } from "node:stream";

const SUPPORTED_RASTER_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function isSupportedRasterMimeType(
  value: string | null | undefined
): value is "image/jpeg" | "image/png" | "image/webp" {
  return Boolean(value && SUPPORTED_RASTER_MIME_TYPES.has(value.toLowerCase()));
}

export function detectRasterMimeType(
  value: Uint8Array
): "image/jpeg" | "image/png" | "image/webp" | null {
  const buffer = Buffer.from(value);
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export async function readRasterHeader(stream: Readable) {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      size += buffer.length;
      if (size >= 12) {
        break;
      }
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks, size).subarray(0, 12);
}
