export const FIELD_VIDEO_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
export const MAX_FIELD_VIDEO_SIZE_BYTES = 300 * 1024 * 1024;

export interface FieldVideoChunk {
  endByte: number;
  partNumber: number;
  sizeBytes: number;
  startByte: number;
}

export interface FieldVideoUploadProgress {
  loadedBytes: number;
  percent: number;
  totalBytes: number;
}

export function buildFieldVideoChunkPlan(
  sizeBytes: number,
  chunkSizeBytes = FIELD_VIDEO_CHUNK_SIZE_BYTES
): FieldVideoChunk[] {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error("VIDEO_SIZE_INVALID");
  }
  if (sizeBytes > MAX_FIELD_VIDEO_SIZE_BYTES) {
    throw new Error("VIDEO_TOO_LARGE");
  }
  if (!Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0) {
    throw new Error("VIDEO_CHUNK_SIZE_INVALID");
  }

  const parts: FieldVideoChunk[] = [];
  for (let startByte = 0, partNumber = 1; startByte < sizeBytes; partNumber += 1) {
    const endByte = Math.min(sizeBytes, startByte + chunkSizeBytes);
    parts.push({
      endByte,
      partNumber,
      sizeBytes: endByte - startByte,
      startByte
    });
    startByte = endByte;
  }
  return parts;
}

export function selectMissingFieldVideoParts(
  parts: FieldVideoChunk[],
  completedPartNumbers: number[]
) {
  const completed = new Set(completedPartNumbers);
  return parts.filter((part) => !completed.has(part.partNumber));
}

export async function buildFieldVideoResumeFingerprint(file: File) {
  const metadata = new TextEncoder().encode(
    `${file.name}\n${file.type}\n${file.size}\n${file.lastModified}\n`
  );
  return sha256Bytes(metadata);
}

export async function sha256Blob(blob: Blob) {
  return sha256Bytes(new Uint8Array(await blob.arrayBuffer()));
}

export function formatFieldVideoUploadProgress(
  loadedBytes: number,
  totalBytes: number
): FieldVideoUploadProgress {
  const safeTotal = Math.max(0, totalBytes);
  const safeLoaded = Math.min(safeTotal, Math.max(0, loadedBytes));
  return {
    loadedBytes: safeLoaded,
    percent: safeTotal > 0 ? Math.min(100, Math.round((safeLoaded / safeTotal) * 100)) : 0,
    totalBytes: safeTotal
  };
}

async function sha256Bytes(bytes: Uint8Array) {
  const copied = new Uint8Array(bytes.byteLength);
  copied.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copied.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
