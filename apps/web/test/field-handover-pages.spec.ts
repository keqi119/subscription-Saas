import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  abandonFieldEvidenceUploadRecovery,
  canRetryFieldEvidenceUploadBatch,
  canStartFieldEvidenceUploadBatch,
  canSubmitWithFieldEvidenceUploadBatch,
  canMutateFieldEvidenceWithUploadBatch,
  hasFieldEvidenceUploadRecoveries,
  replaceAndStartFieldEvidenceUploadRecovery,
  retryFieldEvidenceUploadBatch,
  startFieldEvidenceUploadBatch,
  startFieldEvidenceUploadBatchFromState
} from "../src/lib/field-handover-upload-batch";

const repoRoot = join(__dirname, "..", "..", "..");
const loginPagePath = "apps/web/src/app/field/handover/page.tsx";
const tasksPagePath = "apps/web/src/app/field/handover/tasks/page.tsx";
const detailPagePath = "apps/web/src/app/field/handover/tasks/[id]/page.tsx";
const viewModelPath = "apps/web/src/lib/field-handover-view-model.ts";
const evidenceUploadControlsPath =
  "apps/web/src/components/field-handover-evidence-upload-controls.tsx";

describe("field handover H5 pages", () => {
  it("adds the fixed login route without Admin or Portal auth redirects", () => {
    const source = read(loginPagePath);

    expect(source).toContain("车辆现场交接");
    expect(source).toContain("请使用被分配交接任务的手机号登录");
    expect(source).toContain("sendFieldHandoverCode");
    expect(source).toContain("loginFieldHandover");
    expect(source).toContain('router.replace("/field/handover/tasks")');
    expect(source).not.toContain("disabled={checkingSession");
    expect(source).not.toContain("loading={submitting || checkingSession}");
    expect(source).not.toContain("/portal/login");
    expect(source).not.toContain("/auth/login");
    expect(source).not.toMatch(
      /localStorage|sessionStorage|debugCode|access_token|field_access_token/
    );
  });

  it("adds a mobile task list route with loading, empty, error, and logout states", () => {
    const source = read(tasksPagePath);

    expect(source).toContain("我的交接任务");
    expect(source).toContain("正在加载交接任务...");
    expect(source).toContain("暂无待处理交接任务");
    expect(source).toContain("任务加载失败，请稍后重试");
    expect(source).toContain("重新加载");
    expect(source).toContain("loadTasks");
    expect(source).toContain("logoutFieldHandover");
    expect(source).toContain('router.replace("/field/handover")');
    expect(source).toContain("/field/handover/tasks/${task.id}");
    expect(source).toContain("活动中");
    expect(source).toContain("已结束");
    expect(source).toContain("activeTasks");
    expect(source).toContain("endedTasks");
    expect(source).toContain("card.statusColor");
    expect(source).not.toContain("/portal/login");
    expect(source).not.toContain("/login");
    expect(source).not.toMatch(
      /finance|payment|deposit|objectKey|providerPayload|signingUrl|token|cookie/i
    );
  });

  it("wires capture contracts, processing state, reconciliation, and cancellation", () => {
    const source = read(detailPagePath);
    const uploadControlsSource = read(evidenceUploadControlsPath);

    expect(source).toContain("现场资料采集");
    expect(source).toContain("保存现场信息");
    expect(source).toContain("提交现场资料");
    expect(source).toContain("当前交接任务已提交或不可继续编辑");
    expect(source).toContain("uploadAndAttachFieldHandoverEvidenceFile");
    expect(source).toContain("removeFieldHandoverEvidenceFile");
    expect(source).toContain("validateFieldEvidenceFile");
    expect(source).toContain("import { EvidenceUploadControls }");
    expect(source).toContain("evidenceType={item.evidenceType}");
    expect(source).toContain("export default function");
    expect(source.match(/^export (?!default)/gm)).toBeNull();
    expect(uploadControlsSource).toContain("buildFieldEvidenceUploadInputContracts");
    expect(uploadControlsSource).toContain("capture={contract.capture}");
    expect(uploadControlsSource).toContain("multiple={contract.multiple}");
    expect(source).toContain("fieldEvidenceUploadSnapshot");
    expect(source).toContain("preserveFacts: true");
    expect(source).toContain("onUploadComplete");
    expect(source).toContain('phase: "PROCESSING"');
    expect(source).toContain("服务端处理中");
    expect(source).toContain("请求体已上传，正在保存并绑定资料");
    expect(source).toContain("cancelFieldEvidenceUploadRequest");
    expect(source).not.toContain("buildFieldEvidenceUploadRetryDisplay");
    expect(source).toContain("canMutateFieldEvidenceWithUploadBatch");
    expect(source).toContain("取消上传");
    expect(source).toContain("重试原文件");
    expect(source).toContain("重新选择");
    expect(source).toContain("放弃本次上传");
    expect(source).toContain("资料正在上传或等待重试，请完成后再提交");
    expect(source).toContain("canSubmitWithFieldEvidenceUploadBatch");
    expect(source).toContain("hasFieldEvidenceUploadRecoveries");
    expect(source).toContain("startFieldEvidenceUploadBatchFromState");
    expect(source).toContain("replaceAndStartFieldEvidenceUploadRecovery");
    expect(source).toContain("abandonFieldEvidenceUploadRecovery");
    expect(source).toContain("canStartFieldEvidenceUploadBatch");
    expect(source.match(/uploadOperation/g)).toHaveLength(4);
    expect(source).not.toContain("startFieldEvidenceUploadBatch(");
    expect(source).not.toContain('status === "RETRY_PENDING"');
    expect(source.match(/await loadDetail\(\{ preserveFacts: true \}\);/g)).toHaveLength(2);
    expect(uploadControlsSource).toContain('label = "资料上传"');
    expect(uploadControlsSource).toContain('variant = "primary"');
    expect(source).toContain('uploadAbortReasonRef.current = "UNMOUNT"');
    expect(source).toContain("正在同步最新资料");
    expect(source).toContain("重新加载状态");
    expect(source).toContain("reviewContext.customerObjectionReason");
    expect(source).toContain("reviewContext.customerObjectionDetails");
    expect(source).toContain("reviewContext.requestedEvidenceItems");
    expect(source).not.toContain("reviewContext.objectionReason");
    expect(source).not.toContain("function validateEvidenceFile");
    expect(source).not.toContain("MAX_PHOTO_SIZE_BYTES");
    expect(source).not.toContain("MAX_VIDEO_SIZE_BYTES");
    expect(source).not.toMatch(/signingUrl|objectKey/i);
  });

  it("keeps the confirmed task read-only and adds one reviewed PDF eSign action", () => {
    const tasksSource = read(tasksPagePath);
    const source = read(detailPagePath);
    const viewModelSource = read(viewModelPath);

    expect(tasksSource).not.toContain('filter((task) => task.status !== "CUSTOMER_CONFIRMED")');
    expect(viewModelSource).toContain("detail.stage2Pdf");
    expect(source).toContain("交接确认单");
    expect(source).toContain("文档编号");
    expect(source).toContain("生成时间");
    expect(source).toContain("文件大小");
    expect(source).toContain("SHA-256");
    expect(source).toContain("通知状态");
    expect(source).toContain("预览");
    expect(source).toContain("下载");
    expect(source).toContain("发起电子签");
    expect(source).toContain("<Modal");
    expect(source).toContain("<Checkbox");
    expect(source).toContain("createFieldESignSubmissionController");
    expect(source).toContain("acknowledgement: eSignAcknowledged");
    expect(source).toContain("artifactVersion: stage2View.artifactVersion");
    expect(source).toContain("sourcePdfHash: stage2View.sourcePdfHash");
    expect(source).toContain('actionLoading === "esign"');
    expect(source).toContain("eSignInFlightRef.current");
    expect(source).toContain("stage2View?.shouldPollESign");
    expect(source).toContain("window.setInterval");
    expect(source).toContain("const refreshedDetail = await loadDetail({ showLoading: false })");
    expect(source).toContain("refreshedStage2?.shouldPollESign");
    expect(viewModelSource).toContain('detail.status === "CUSTOMER_CONFIRMED"');
    expect(source).toContain("overflowWrap: \"anywhere\"");
    expect(source).not.toMatch(/notification(?:Status)?.{0,80}(?:mobile|phone|手机号)/i);
  });

  it("shows customer objection recheck guidance before the evidence capture overview", () => {
    const source = read(detailPagePath);
    const reviewGuidanceIndex = source.indexOf("message={`客户异议：");
    const captureOverviewIndex = source.indexOf("现场资料采集");

    expect(reviewGuidanceIndex).toBeGreaterThan(-1);
    expect(captureOverviewIndex).toBeGreaterThan(-1);
    expect(reviewGuidanceIndex).toBeLessThan(captureOverviewIndex);
  });
});

describe("field handover upload batch gates", () => {
  it("keeps one file for singleton evidence and all files for multi-file evidence", () => {
    const baseline = { count: 1, ids: ["existing"] };

    expect(
      startFieldEvidenceUploadBatch("single", ["first.jpg", "second.jpg"], false, baseline).batch
        ?.files
    ).toEqual(["first.jpg"]);
    expect(
      startFieldEvidenceUploadBatch("damage", ["first.jpg", "second.jpg"], true, baseline).batch
        ?.files
    ).toEqual(["first.jpg", "second.jpg"]);
  });

  it("blocks submit and retry while upload evidence is not authoritative", () => {
    const uploading = startFieldEvidenceUploadBatch("damage", ["first.jpg"], true, {
      count: 0,
      ids: []
    });
    const refreshing = {
      ...uploading,
      refreshTarget: "RECOVERABLE" as const,
      status: "REFRESHING" as const
    };
    const refreshFailed = {
      ...refreshing,
      status: "REFRESH_FAILED" as const
    };
    const recoverable = {
      batch: null,
      fileIndex: 0,
      recoveries: {
        damage: {
          baseline: { count: 0, ids: [] },
          errorMessage: "upload failed",
          files: ["first.jpg"],
          itemViewId: "damage",
          operation: { type: "APPEND" as const }
        }
      },
      status: "IDLE" as const
    };

    expect(canSubmitWithFieldEvidenceUploadBatch(uploading)).toBe(false);
    expect(canSubmitWithFieldEvidenceUploadBatch(refreshing)).toBe(false);
    expect(canSubmitWithFieldEvidenceUploadBatch(refreshFailed)).toBe(false);
    expect(canSubmitWithFieldEvidenceUploadBatch(recoverable)).toBe(false);
    expect(canStartFieldEvidenceUploadBatch(refreshing, "side")).toBe(false);
    expect(canStartFieldEvidenceUploadBatch(refreshFailed, "side")).toBe(false);
    expect(canStartFieldEvidenceUploadBatch(recoverable, "side")).toBe(true);
    expect(canStartFieldEvidenceUploadBatch(recoverable, "damage")).toBe(false);
    expect(canRetryFieldEvidenceUploadBatch(recoverable, "damage", true)).toBe(true);
    expect(canRetryFieldEvidenceUploadBatch(recoverable, "side", true)).toBe(false);
    expect(canRetryFieldEvidenceUploadBatch(recoverable, "damage", false)).toBe(false);
    expect(canMutateFieldEvidenceWithUploadBatch(uploading)).toBe(false);
    expect(canMutateFieldEvidenceWithUploadBatch(refreshing)).toBe(false);
    expect(canMutateFieldEvidenceWithUploadBatch(refreshFailed)).toBe(false);
    expect(canMutateFieldEvidenceWithUploadBatch(recoverable)).toBe(true);
    expect(hasFieldEvidenceUploadRecoveries(recoverable)).toBe(true);
    expect(
      canMutateFieldEvidenceWithUploadBatch({
        batch: null,
        fileIndex: 0,
        recoveries: {},
        status: "IDLE"
      })
    ).toBe(true);
  });

  it("does not allow a locked task to retry or abandon a recovery", () => {
    const refreshFailed = {
      batch: {
        baseline: { count: 0, ids: [] },
        files: ["first.jpg"],
        itemViewId: "damage",
        operation: { type: "APPEND" as const }
      },
      fileIndex: 0,
      recoveries: {
        damage: {
          baseline: { count: 0, ids: [] },
          errorMessage: "upload failed",
          files: ["first.jpg"],
          itemViewId: "damage",
          operation: { type: "APPEND" as const }
        }
      },
      refreshTarget: "RECOVERABLE" as const,
      status: "REFRESH_FAILED" as const
    };

    expect(retryFieldEvidenceUploadBatch(refreshFailed, "damage", true)).toBe(refreshFailed);
    expect(canRetryFieldEvidenceUploadBatch(refreshFailed, "damage", true)).toBe(false);
    expect(abandonFieldEvidenceUploadRecovery(refreshFailed, "damage")).toBe(refreshFailed);
    expect(startFieldEvidenceUploadBatchFromState(refreshFailed, "side", ["side.jpg"], false)).toBe(
      refreshFailed
    );
    expect(
      replaceAndStartFieldEvidenceUploadRecovery(
        refreshFailed,
        "damage",
        ["replacement.jpg"],
        false,
        true
      )
    ).toBe(refreshFailed);
  });

  it("overrides a stale replacement operation for retry and reselect", () => {
    const staleRecovery = {
      batch: null,
      fileIndex: 0,
      recoveries: {
        front: {
          baseline: { count: 1, ids: ["deleted-evidence-id"] },
          errorMessage: "upload failed",
          files: ["original.jpg"],
          itemViewId: "front",
          operation: {
            replaceEvidenceFileId: "deleted-evidence-id",
            type: "REPLACE" as const
          }
        }
      },
      status: "IDLE" as const
    };

    expect(
      retryFieldEvidenceUploadBatch(staleRecovery, "front", true, { type: "APPEND" }).batch
        ?.operation
    ).toEqual({ type: "APPEND" });
    expect(
      replaceAndStartFieldEvidenceUploadRecovery(staleRecovery, "front", ["new.jpg"], false, true, {
        type: "APPEND"
      }).batch?.operation
    ).toEqual({ type: "APPEND" });
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
