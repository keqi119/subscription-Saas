import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const orderPagePath = "apps/web/src/app/orders/[id]/page.tsx";
const reviewQueuePagePath = "apps/web/src/app/handover-review-queue/page.tsx";

describe("Admin Stage 2 handover review order page", () => {
  it("loads Stage 2 work orders and renders review, evidence, and objection actions safely", () => {
    const source = read(orderPagePath);

    expect(source).toContain("/handover-work-orders");
    expect(source).toContain("Stage 2");
    expect(source).toContain("viewHandoverWorkOrderDetail");
    expect(source).toContain("acknowledgeCustomerObjection");
    expect(source).toContain("requestCustomerObjectionResubmission");
    expect(source).toContain("sendCustomerObjectionBackToReview");
    expect(source).toContain("createHandoverWorkOrder");
    expect(source).toContain("assignExternalHandover");
    expect(source).toContain("/assign-external");
    expect(source).toContain("targetEvidenceItemIds");
    expect(source).toContain("targetFieldKeys");
    expect(source).toContain("操作事件");
    expect(source).toContain("/handover-review-queue");
    expect(source).toContain("创建交付工单");
    expect(source).toContain("暂无 Stage 2 现场交接工单");
    expect(source).toContain("/orders/${params.id}/handover-work-orders");
    expect(source).toContain("/objection/${action}");
    expect(source).toContain("\"acknowledge\"");
    expect(source).toContain("\"request-resubmission\"");
    expect(source).toContain("\"send-customer-review\"");
    expect(source).toContain("buildAdminHandoverFileUrl");
    expect(source).toContain("previewUrl");
    expect(source).toContain("downloadUrl");
    expect(source).toContain("预览");
    expect(source).toContain("下载/打开");
    expect(source).toContain("已登记收款，待核销");
    expect(source).toContain("0 元押金，自动满足");
    expect(source).toContain("/vehicle-insurance-policies");
    expect(source).not.toMatch(/accessTokenHash|objectKey|bucket|signingUrl|idCard|fullPhone|raw DTO/i);
  });

  it("renders canonical full Field identity and states equal OTP task permissions", () => {
    const source = read(orderPagePath);

    expect(source).toContain("row.operator?.phone || \"-\"");
    expect(source).toContain("请填写用于 Field 登录的手机号");
    expect(source).not.toContain("row.operator?.phoneMasked || \"-\"");
  });

  it("provides an Admin objection queue entry with links back to the order workflow", () => {
    const source = read(reviewQueuePagePath);

    expect(source).toContain("/handover-work-orders/review-queue");
    expect(source).toContain("客户异议处理队列");
    expect(source).toContain("/orders/${row.orderId}");
    expect(source).toContain("进入订单处理");
    expect(source).not.toMatch(/accessToken|objectKey|bucket|signingUrl|idCard|fullPhone/i);
  });

  it("integrates the Stage 2 workflow timeline and dead-letter recovery into the review surfaces", () => {
    const source = read(orderPagePath);

    expect(source).toContain("Stage2HandoverWorkflowCell");
    expect(source).toContain("loadAdminStage2HandoverESign");
    expect(source).toContain("getAdminStage2HandoverWorkflowDisplay");
    expect(source).toContain("retryAdminStage2WorkflowJob");
    expect(source).toContain("reconcileAdminStage2CustomerSignature");
    expect(source).toContain("getAdminStage2HandoverESignErrorMessage");
    expect(source).toContain('canRecoverWorkflow={permissions.has("delivery:confirm")}');
    expect(source).toContain("display.recoveries.map");
    expect(source).toContain("<Timeline");
    expect(source).not.toContain("function Stage2HandoverPdfCell");
    expect(source).not.toContain("function Stage2HandoverESignCell");
    expect(source).not.toMatch(
      /signUrl|providerTransactionId|providerTaskId|providerEnvelopeId|objectKey|bucket|idCard|fullPhone/i
    );
  });

  it("refreshes order and workflow state after recovery without advancing delivery", () => {
    const source = read(orderPagePath);
    const actionBlock = source.slice(
      source.indexOf("async function runStage2WorkflowRecovery"),
      source.indexOf("function openAssignExternalHandover")
    );

    expect(actionBlock).toContain("await loadOrder()");
    expect(actionBlock).toContain("retryAdminStage2WorkflowJob");
    expect(actionBlock).toContain("reconcileAdminStage2CustomerSignature");
    expect(actionBlock).not.toMatch(
      /confirmDelivery|prepareDelivery|activateLease|leaseActivation|billing|payment/i
    );
  });

  it("requires explicit confirmation before an exception recovery mutation", () => {
    const source = read(orderPagePath);
    const confirmationBlock = source.slice(
      source.indexOf("function confirmStage2WorkflowRecovery"),
      source.indexOf("function openAssignExternalHandover")
    );

    expect(confirmationBlock).toContain("modal.confirm");
    expect(confirmationBlock).toContain("确认执行异常恢复？");
    expect(confirmationBlock).toContain("runStage2WorkflowRecovery");
    expect(confirmationBlock).toContain("onOk");
  });

  it("uses a synchronous ref guard and disables recovery while one is pending", () => {
    const source = read(orderPagePath);
    const guardBlock = source.slice(
      source.indexOf("async function runStage2WorkflowRecovery"),
      source.indexOf("function confirmStage2WorkflowRecovery")
    );
    const cellBlock = source.slice(
      source.indexOf("function Stage2HandoverWorkflowCell"),
      source.indexOf("function Stage2HandoverReviewPanel")
    );

    expect(source).toContain("stage2WorkflowRecoveryInFlightRef = useRef(false)");
    expect(guardBlock).toContain("stage2WorkflowRecoveryInFlightRef.current");
    expect(guardBlock).toContain("stage2WorkflowRecoveryInFlightRef.current = true");
    expect(guardBlock).toContain("stage2WorkflowRecoveryInFlightRef.current = false");
    expect(cellBlock).toContain("disabled={!canRecoverWorkflow || mutationInFlight}");
  });

  it("keeps delivery blocked until archive and exposes no manual void or reissue UI", () => {
    const source = read(orderPagePath);

    expect(source).toContain("交接签署文件归档完成后才可确认交付");
    expect(source).toContain("deliveryConfirmationAvailable");
    expect(source).toMatch(
      /const stage2ArchiveReady = activeHandoverWorkOrder[\s\S]*?: true;/
    );
    expect(source).not.toContain("voidAdminStage2HandoverESign");
    expect(source).not.toContain("作废签署任务");
    expect(source).not.toContain("重新发起电子签");
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
