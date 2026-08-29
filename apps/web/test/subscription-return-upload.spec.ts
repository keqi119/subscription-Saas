import { describe, expect, it } from "vitest";

import {
  completeSubscriptionReturnUpload,
  failSubscriptionReturnUpload,
  initialSubscriptionReturnUploadState,
  selectSubscriptionReturnFile,
  uploadingSubscriptionReturnFile
} from "../src/lib/subscription-return-upload";

describe("subscription return governed upload", () => {
  it("accepts supported direct files and preserves retry state", () => {
    const selected = selectSubscriptionReturnFile(file("return.webp", "image/webp", 1024));
    expect(selected.status).toBe("READY");
    expect(uploadingSubscriptionReturnFile(selected)).toMatchObject({ progress: 20, status: "UPLOADING" });
    expect(completeSubscriptionReturnUpload(selected)).toMatchObject({ progress: 100, status: "SUCCEEDED" });
    expect(failSubscriptionReturnUpload(selected, "network")).toMatchObject({
      error: "network",
      file: selected.file,
      status: "FAILED"
    });
  });

  it("rejects URL-like text and oversized or unsupported files", () => {
    expect(initialSubscriptionReturnUploadState()).toMatchObject({ file: null, status: "IDLE" });
    expect(selectSubscriptionReturnFile(file("evidence.txt", "text/plain", 20)).status).toBe("FAILED");
    expect(
      selectSubscriptionReturnFile(file("evidence.mp4", "video/mp4", 20 * 1024 * 1024 + 1)).status
    ).toBe("FAILED");
  });
});

function file(name: string, type: string, size: number) {
  return { name, size, type } as File;
}
