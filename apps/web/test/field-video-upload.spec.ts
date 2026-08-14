import { describe, expect, it } from "vitest";

import {
  buildFieldVideoChunkPlan,
  buildFieldVideoResumeFingerprint,
  formatFieldVideoUploadProgress,
  MAX_FIELD_VIDEO_SIZE_BYTES,
  selectMissingFieldVideoParts,
  sha256Blob
} from "../src/lib/field-video-upload";

describe("field video upload primitives", () => {
  it("plans 38 sequential parts for exactly 300 MiB", () => {
    const parts = buildFieldVideoChunkPlan(300 * 1024 * 1024, 8 * 1024 * 1024);

    expect(parts).toHaveLength(38);
    expect(parts.at(-1)).toMatchObject({
      partNumber: 38,
      sizeBytes: 4 * 1024 * 1024
    });
    expect(parts[1]).toMatchObject({
      endByte: 16 * 1024 * 1024,
      partNumber: 2,
      startByte: 8 * 1024 * 1024
    });
  });

  it("rejects 300 MiB plus one byte", () => {
    expect(() => buildFieldVideoChunkPlan(MAX_FIELD_VIDEO_SIZE_BYTES + 1)).toThrow(
      "VIDEO_TOO_LARGE"
    );
  });

  it("fingerprints metadata plus at most the first and last MiB", async () => {
    const file = trackedFile(226_900_000);

    const fingerprint = await buildFieldVideoResumeFingerprint(file);

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(file.slices).toEqual([
      [0, 1_048_576],
      [225_851_424, 226_900_000]
    ]);
  });

  it("selects only missing parts and formats aggregate progress", () => {
    const parts = buildFieldVideoChunkPlan(20, 8);

    expect(selectMissingFieldVideoParts(parts, [1, 3]).map((part) => part.partNumber)).toEqual([2]);
    expect(formatFieldVideoUploadProgress(8, 20)).toEqual({
      loadedBytes: 8,
      percent: 40,
      totalBytes: 20
    });
  });

  it("hashes one blob without reading any surrounding file bytes", async () => {
    await expect(sha256Blob(new Blob(["chunk"]))).resolves.toMatch(/^[a-f0-9]{64}$/);
  });
});

function trackedFile(size: number) {
  const slices: Array<[number, number]> = [];
  const file = {
    lastModified: 1_786_723_200_000,
    name: "IMG_0284.MOV",
    size,
    slices,
    slice(start = 0, end = size) {
      slices.push([start, end]);
      return new Blob([new Uint8Array(Math.max(0, end - start))]);
    },
    type: "video/quicktime"
  };
  return file as unknown as File & { slices: Array<[number, number]> };
}
