import { describe, expect, it } from "vitest";

import {
  MAX_FIELD_PHOTO_SIZE_BYTES,
  MAX_FIELD_VIDEO_SIZE_BYTES,
  formatUploadBytes,
  resolveFieldEvidenceMediaType,
  validateFieldEvidenceFile
} from "../src/lib/field-handover-upload";

describe("field handover evidence upload validation", () => {
  it("accepts a photo at the 10MiB limit", () => {
    expect(
      validateFieldEvidenceFile(
        ["PHOTO"],
        fileOfSize("photo.jpg", "image/jpeg", MAX_FIELD_PHOTO_SIZE_BYTES)
      )
    ).toBeNull();
  });

  it("rejects a photo above the 10MiB limit", () => {
    expect(
      validateFieldEvidenceFile(
        ["PHOTO"],
        fileOfSize("photo.jpg", "image/jpeg", MAX_FIELD_PHOTO_SIZE_BYTES + 1)
      )
    ).toContain("超过 10MB");
  });

  it("accepts a video at the 300MiB limit", () => {
    expect(
      validateFieldEvidenceFile(
        ["VIDEO"],
        fileOfSize("video.mp4", "video/mp4", MAX_FIELD_VIDEO_SIZE_BYTES)
      )
    ).toBeNull();
  });

  it("rejects a video above the 300MiB limit", () => {
    expect(
      validateFieldEvidenceFile(
        ["VIDEO"],
        fileOfSize("video.mp4", "video/mp4", MAX_FIELD_VIDEO_SIZE_BYTES + 1)
      )
    ).toContain("超过 300MB");
  });

  it("recognizes HEIC photos when the browser omits the MIME type", () => {
    expect(resolveFieldEvidenceMediaType(fileOfSize("capture.heic", "", 1))).toBe("PHOTO");
  });

  it("recognizes MOV videos when the browser omits the MIME type", () => {
    expect(resolveFieldEvidenceMediaType(fileOfSize("capture.mov", "", 1))).toBe("VIDEO");
  });

  it("rejects media types outside the evidence item allowance", () => {
    expect(
      validateFieldEvidenceFile(["PHOTO"], fileOfSize("capture.mov", "video/quicktime", 1))
    ).toBe("请选择符合要求的图片或视频");
  });

  it("formats upload byte counts for the existing evidence display", () => {
    expect(formatUploadBytes(1024)).toBe("1KB");
    expect(formatUploadBytes(1024 * 1024)).toBe("1MB");
  });
});

function fileOfSize(name: string, type: string, size: number) {
  const file = new File([""], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}
