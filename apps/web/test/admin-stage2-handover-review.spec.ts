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

  it("provides an Admin objection queue entry with links back to the order workflow", () => {
    const source = read(reviewQueuePagePath);

    expect(source).toContain("/handover-work-orders/review-queue");
    expect(source).toContain("客户异议处理队列");
    expect(source).toContain("/orders/${row.orderId}");
    expect(source).toContain("进入订单处理");
    expect(source).not.toMatch(/accessToken|objectKey|bucket|signingUrl|idCard|fullPhone/i);
  });

  it("integrates safe Stage 2 eSign status and actions into the existing review panel and detail modal", () => {
    const source = read(orderPagePath);

    expect(source).toContain("Stage2HandoverESignCell");
    expect(source).toContain("loadAdminStage2HandoverESign");
    expect(source).toContain("startAdminStage2HandoverESign");
    expect(source).toContain("retryAdminStage2PlatformSeal");
    expect(source).toContain("retryAdminStage2HandoverArchive");
    expect(source).toContain("getAdminStage2HandoverESignErrorMessage");
    expect(source).toContain('canManageESign={permissions.has("delivery:confirm")}');
    expect(source).toContain("发起电子签");
    expect(source).toContain("发起平台盖章");
    expect(source).toContain("重试平台盖章");
    expect(source).toContain("重试签署文件归档");
    expect(source).toContain("电子签状态");
    expect(source).toContain("客户签署");
    expect(source).toContain("平台盖章");
    expect(source).toContain("签署文件归档");
    expect(source).not.toMatch(
      /signUrl|providerTransactionId|providerTaskId|providerEnvelopeId|objectKey|bucket|idCard|fullPhone/i
    );
  });

  it("refreshes Stage 2 eSign status after every signing action without coupling it to delivery confirmation", () => {
    const source = read(orderPagePath);
    const actionBlock = source.slice(
      source.indexOf("async function runStage2HandoverESignAction"),
      source.indexOf("function openAssignExternalHandover")
    );

    expect(actionBlock).toContain("await action(id)");
    expect(actionBlock).toContain("await refreshStage2HandoverESignStatus(id)");
    expect(actionBlock).not.toMatch(/confirmDelivery|prepareDelivery|lease|billing|payment/i);
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
