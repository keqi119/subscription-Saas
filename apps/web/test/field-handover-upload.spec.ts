import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EvidenceUploadControls } from "../src/components/field-handover-evidence-upload-controls";

import {
  MAX_FIELD_PHOTO_SIZE_BYTES,
  MAX_FIELD_VIDEO_SIZE_BYTES,
  buildFieldEvidenceUploadInputContracts,
  buildFieldEvidenceUploadRetryDisplay,
  completeFieldEvidenceUploadSelection,
  detectFieldEvidenceUploadEnvironment,
  formatUploadBytes,
  routeFieldEvidenceUploadPrimaryAction,
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

  it("uses exact direct library contracts on desktop", () => {
    expect(buildFieldEvidenceUploadInputContracts(["PHOTO"], true, "DESKTOP")).toEqual([
      {
        accept: "image/*",
        key: "library",
        label: "资料上传",
        multiple: true
      }
    ]);
    expect(buildFieldEvidenceUploadInputContracts(["VIDEO"], false, "DESKTOP")).toEqual([
      {
        accept: "video/*",
        key: "library",
        label: "资料上传",
        multiple: false
      }
    ]);
    expect(buildFieldEvidenceUploadInputContracts(["PHOTO", "VIDEO"], true, "DESKTOP")).toEqual([
      {
        accept: "image/*,video/*",
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

  it("keeps exact video and mixed-media input contracts on mobile", () => {
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
    expect(buildFieldEvidenceUploadInputContracts(["PHOTO", "VIDEO"], true, "MOBILE")).toEqual([
      {
        accept: "image/*",
        capture: "environment",
        key: "photo-capture",
        label: "现场拍摄",
        multiple: false
      },
      {
        accept: "video/*",
        capture: "environment",
        key: "video-capture",
        label: "现场录像",
        multiple: false
      },
      {
        accept: "image/*,video/*",
        key: "library",
        label: "从相册/文件选择",
        multiple: true
      }
    ]);
  });

  it("detects mobile devices from browser signals and defaults SSR to desktop", () => {
    expect(detectFieldEvidenceUploadEnvironment()).toBe("DESKTOP");
    expect(detectFieldEvidenceUploadEnvironment({ userAgentDataMobile: true })).toBe("MOBILE");
    expect(
      detectFieldEvidenceUploadEnvironment({
        pointerCoarse: true,
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
        userAgentDataMobile: false,
        viewportWidth: 640
      })
    ).toBe("DESKTOP");
    expect(
      detectFieldEvidenceUploadEnvironment({
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"
      })
    ).toBe("MOBILE");
    expect(detectFieldEvidenceUploadEnvironment({ pointerCoarse: true, viewportWidth: 640 })).toBe(
      "MOBILE"
    );
    expect(detectFieldEvidenceUploadEnvironment({ pointerCoarse: true, viewportWidth: 1280 })).toBe(
      "DESKTOP"
    );
  });

  it("routes desktop primary upload directly to the library picker", () => {
    const selectedKeys: string[] = [];
    let mobileChooserOpenCount = 0;
    const contracts = buildFieldEvidenceUploadInputContracts(["PHOTO"], true, "DESKTOP");

    routeFieldEvidenceUploadPrimaryAction("DESKTOP", contracts, {
      openMobileChooser: () => {
        mobileChooserOpenCount += 1;
      },
      selectContract: (contract) => {
        selectedKeys.push(contract.key);
      }
    });

    expect(mobileChooserOpenCount).toBe(0);
    expect(selectedKeys).toEqual(["library"]);
  });

  it("routes mobile primary upload to the secondary chooser and completes selections", () => {
    const selectedKeys: string[] = [];
    let mobileChooserOpen = false;
    const contracts = buildFieldEvidenceUploadInputContracts(["PHOTO"], true, "MOBILE");

    routeFieldEvidenceUploadPrimaryAction("MOBILE", contracts, {
      openMobileChooser: () => {
        mobileChooserOpen = true;
      },
      selectContract: (contract) => {
        selectedKeys.push(contract.key);
      }
    });

    const selectedFiles = [fileOfSize("capture.jpg", "image/jpeg", 1)];
    const forwardedFiles: File[][] = [];
    completeFieldEvidenceUploadSelection(selectedFiles, {
      closeMobileChooser: () => {
        mobileChooserOpen = false;
      },
      onFiles: (files) => {
        forwardedFiles.push(files);
      }
    });

    expect(mobileChooserOpen).toBe(false);
    expect(selectedKeys).toEqual([]);
    expect(forwardedFiles).toEqual([selectedFiles]);
  });

  it("renders one isolated desktop primary upload button per evidence item", () => {
    const markup = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(EvidenceUploadControls, {
          allowedMediaTypes: ["PHOTO"],
          disabled: false,
          environment: "DESKTOP",
          id: "photo-item",
          multiple: true,
          onFiles: () => undefined
        }),
        createElement(EvidenceUploadControls, {
          allowedMediaTypes: ["VIDEO"],
          disabled: false,
          environment: "DESKTOP",
          id: "video-item",
          multiple: false,
          onFiles: () => undefined
        })
      )
    );

    expect(markup.match(/资料上传/g)).toHaveLength(2);
    expect(markup).toContain('id="photo-item-library"');
    expect(markup).toContain('id="video-item-library"');
    expect(markup).not.toContain("现场拍摄");
  });

  it("points retry progress at the first remaining file with a reset ordinal", () => {
    const second = fileOfSize("second.jpg", "image/jpeg", 20);
    const third = fileOfSize("third.jpg", "image/jpeg", 30);

    expect(buildFieldEvidenceUploadRetryDisplay("evidence-item-1", [second, third])).toEqual({
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
