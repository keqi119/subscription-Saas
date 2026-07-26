import { describe, expect, it } from "vitest";

import {
  MAX_FIELD_PHOTO_SIZE_BYTES,
  MAX_FIELD_VIDEO_SIZE_BYTES,
  buildFieldEvidenceUploadInputContracts,
  buildFieldEvidenceUploadRetryDisplay,
  detectFieldEvidenceUploadEnvironment,
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

  it("uses one direct library contract on desktop", () => {
    expect(buildFieldEvidenceUploadInputContracts(["PHOTO"], true, "DESKTOP")).toEqual([
      {
        accept: "image/*",
        key: "library",
        label: "资料上传",
        multiple: true
      }
    ]);
  });

  it("offers capture and library contracts on mobile", () => {
    expect(buildFieldEvidenceUploadInputContracts(["PHOTO"], true, "MOBILE")).toEqual([
      {
        accept: "image/*",
        capture: "environment",
        key: "photo-capture",
        label: "现场拍摄",
        multiple: false
      },
      {
        accept: "image/*",
        key: "library",
        label: "从相册选择",
        multiple: true
      }
    ]);
  });

  it("keeps video and mixed-media input semantics on mobile", () => {
    expect(buildFieldEvidenceUploadInputContracts(["VIDEO"], false, "MOBILE")).toEqual([
      {
        accept: "video/*",
        capture: "environment",
        key: "video-capture",
        label: "现场录像",
        multiple: false
      },
      {
        accept: "video/*",
        key: "library",
        label: "从相册/文件选择",
        multiple: false
      }
    ]);
    expect(
      buildFieldEvidenceUploadInputContracts(["PHOTO", "VIDEO"], true, "MOBILE").map(
        ({ capture, key, multiple }) => ({ capture, key, multiple })
      )
    ).toEqual([
      { capture: "environment", key: "photo-capture", multiple: false },
      { capture: "environment", key: "video-capture", multiple: false },
      { capture: undefined, key: "library", multiple: true }
    ]);
  });

  it("detects mobile devices from browser signals and defaults SSR to desktop", () => {
    expect(detectFieldEvidenceUploadEnvironment()).toBe("DESKTOP");
    expect(detectFieldEvidenceUploadEnvironment({ userAgentDataMobile: true })).toBe("MOBILE");
    expect(
      detectFieldEvidenceUploadEnvironment({
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"
      })
    ).toBe("MOBILE");
    expect(
      detectFieldEvidenceUploadEnvironment({ pointerCoarse: true, viewportWidth: 640 })
    ).toBe("MOBILE");
    expect(
      detectFieldEvidenceUploadEnvironment({ pointerCoarse: true, viewportWidth: 1280 })
    ).toBe("DESKTOP");
  });

  it("points retry progress at the first remaining file with a reset ordinal", () => {
    const second = fileOfSize("second.jpg", "image/jpeg", 20);
    const third = fileOfSize("third.jpg", "image/jpeg", 30);

    expect(
      buildFieldEvidenceUploadRetryDisplay("evidence-item-1", [second, third])
    ).toEqual({
      fileCount: 2,
      fileIndex: 1,
      fileName: "second.jpg",
      itemId: "evidence-item-1",
      loadedBytes: 0,
      percent: 0,
      phase: "RETRY_PENDING",
      totalBytes: 20
    });
  });
});

function fileOfSize(name: string, type: string, size: number) {
  const file = new File([""], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}
