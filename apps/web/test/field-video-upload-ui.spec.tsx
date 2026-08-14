import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { FieldVideoUploadProgressCard } from "../src/components/field-video-upload-progress-card";
import { FieldVideoUploadRecoveryAlert } from "../src/components/field-video-upload-recovery-alert";

describe("field video upload UI", () => {
  it("shows durable progress instead of relying on a toast", () => {
    const markup = renderToStaticMarkup(
      createElement(FieldVideoUploadProgressCard, {
        onCancel: vi.fn(),
        onPause: vi.fn(),
        onResume: vi.fn(),
        onRetry: vi.fn(),
        view: {
          completedParts: 18,
          errorMessage: null,
          fileName: "IMG_0284.MOV",
          percent: 62,
          phaseLabel: "上传中",
          status: "UPLOADING",
          totalParts: 29
        }
      })
    );

    expect(markup).toContain("18/29");
    expect(markup).toContain("上传中");
    expect(markup).toContain("暂停上传");
    expect(markup).not.toContain("重试处理");
  });

  it("keeps a persistent actionable error inside the progress card", () => {
    const markup = renderToStaticMarkup(
      createElement(FieldVideoUploadProgressCard, {
        onCancel: vi.fn(),
        onPause: vi.fn(),
        onResume: vi.fn(),
        onRetry: vi.fn(),
        view: {
          completedParts: 29,
          errorMessage: "视频清晰度不足，请重新录制。",
          fileName: "IMG_0284.MOV",
          percent: 100,
          phaseLabel: "校验失败",
          status: "VALIDATION_FAILED",
          totalParts: 29
        }
      })
    );

    expect(markup).toContain("视频清晰度不足，请重新录制。");
    expect(markup).toContain("取消本次上传");
  });

  it("asks the operator to reselect the original file after reload", () => {
    const markup = renderToStaticMarkup(
      createElement(FieldVideoUploadRecoveryAlert, {
        records: [recovery({ fileName: "IMG_0284.MOV" })]
      })
    );

    expect(markup).toContain("IMG_0284.MOV");
    expect(markup).toContain("重新选择同一文件后可继续");
    expect(markup).toContain("/field/handover/tasks/work-order-1");
  });
});

function recovery(overrides: Record<string, unknown> = {}) {
  return {
    evidenceItemId: "item-1",
    expiresAt: "2099-01-01T00:00:00.000Z",
    fileName: "video.mov",
    fingerprintSha256: "a".repeat(64),
    lastModifiedMs: 1,
    sessionId: "session-1",
    sizeBytes: 226_900_000,
    workOrderId: "work-order-1",
    ...overrides
  };
}
