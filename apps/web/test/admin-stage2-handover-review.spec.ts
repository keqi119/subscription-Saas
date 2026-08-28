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
    expect(source).toContain("reopenConfirmedHandoverReview");
    expect(source).toContain("/reopen-confirmed-review");
    expect(source).toContain("重新打开交接复核");
    expect(source).toContain("createHandoverWorkOrder");
    expect(source).toContain("assignExternalHandover");
    expect(source).toContain("/assign-external");
    expect(source).toContain("targetEvidenceItemIds");
    expect(source).toContain("targetFieldKeys");
    expect(source).toContain("操作事件");
    expect(source).toContain("/handover-review-queue");
    expect(source).toContain("创建交付工单");
    expect(source).toContain("暂无 Stage 2 现场交接工单");
    expect(source).toContain("/orders/${orderId}/handover-work-orders");
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
    expect(source).toContain("fieldReceipt");
    expect(source).toContain("Field 已接收任务");
    expect(source).toContain("Field 尚未打开任务");
    expect(source).toContain("首次打开：");
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

  it("renders the governed vehicle-registration exception entry without exposing internal notes", () => {
    const source = read(orderPagePath);
    const component = read(
      "apps/web/src/components/stage2-registration-exception-actions.tsx"
    );

    expect(source).toContain("Stage2RegistrationExceptionActions");
    expect(source).toContain("VEHICLE_REGISTRATION_DOCUMENT_MISSING");
    expect(source).toContain('permissions.has("business_exception:request")');
    expect(source).toContain('permissions.has("business_exception:approve")');
    expect(component).toContain("申请例外审批");
    expect(component).toContain("批准例外");
    expect(component).toContain("驳回例外");
    expect(component).toContain("申请人与审批人不能为同一账号");
    expect(component).not.toMatch(/decisionComment|objectKey|bucket|internalNote/i);
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

    expect(confirmationBlock).toContain("scopedConfirm.confirm");
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

  it("delegates the delivery signing gate and exposes controlled void/reissue plus Admin fallback UI", () => {
    const source = read(orderPagePath);
    const signingGateBlock = source.slice(
      source.indexOf("const stage2SigningComplete ="),
      source.indexOf("const confirmDeliveryDisabledReason")
    );

    expect(signingGateBlock).toContain('handoverWorkOrdersLoadState === "LOADED"');
    expect(signingGateBlock).toContain("activeHandoverWorkOrders.length === 0");
    expect(signingGateBlock).toContain("activeHandoverWorkOrders.length === 1");
    expect(signingGateBlock).toContain("deliveryConfirmationAvailable");
    expect(signingGateBlock).not.toContain("archiveStatus");
    expect(signingGateBlock).not.toContain("signedArtifactAvailable");
    expect(source).toContain("voidAdminStage2HandoverESign");
    expect(source).toContain("startAdminStage2HandoverESign");
    expect(source).toContain("作废并重新发起");
    expect(source).toContain("后台兜底发起签署");
    expect(source).toContain("buildAdminStage2HandoverPdfDownloadUrl");
    expect(source).toContain("确认后台兜底发起签署");
    expect(source).toContain("已核对当前交接确认单");
    expect(source).toContain("PDF 版本");
    expect(source).toContain("SHA-256");
    expect(source).toContain("预览/下载 PDF");
    expect(source).toContain("validateAdminStage2HandoverFallbackReason");
  });

  it("freezes the reviewed PDF version and hash when the Admin fallback dialog opens", () => {
    const source = read(orderPagePath);
    const fallbackBlock = source.slice(
      source.indexOf("async function runAdminStage2Fallback"),
      source.indexOf("function openAdminStage2Void")
    );

    expect(fallbackBlock).toContain(
      "const sourceArtifact = stage2FallbackSourceArtifact"
    );
    expect(fallbackBlock).toContain(
      "setStage2FallbackSourceArtifact({"
    );
    expect(fallbackBlock).toContain("...status.sourceArtifact");
    expect(fallbackBlock).not.toContain(
      "handoverESignStatuses[id]?.sourceArtifact"
    );
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
