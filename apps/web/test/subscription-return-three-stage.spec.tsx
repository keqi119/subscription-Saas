import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildCustomerSubscriptionClosureView } from "../src/lib/subscription-closure-view-model";

const root = join(__dirname, "../../..");

describe("admin subscription return three-stage workspace", () => {
  it("renders governed files, immutable comparison, contract pricing, and independent closure", () => {
    const evidence = source(
      "apps/web/src/components/subscription-closure/return-evidence-stage.tsx"
    );
    const pricing = source("apps/web/src/components/subscription-closure/return-pricing-stage.tsx");
    const settlement = source(
      "apps/web/src/components/subscription-closure/return-settlement-stage.tsx"
    );
    const page = source("apps/web/src/app/orders/[id]/page.tsx");

    for (const label of ["车辆外观", "车辆内饰", "车辆钥匙", "行驶证", "随车附件", "上传并绑定"]) {
      expect(evidence).toContain(label);
    }
    expect(evidence).not.toContain("照片 URL");
    expect(evidence).toContain("cancelSubscriptionReturnManifestSigning");
    expect(evidence).toContain("取消当前签署并更正清单");
    expect(evidence).toContain("returnManifestSigningCompleted");
    expect(evidence).toContain("已签署的退车确认单是不可变证据");
    expect(evidence).toContain("return-manifest/signed-document/preview");
    expect(evidence).toContain("closure.capabilities.receive");
    expect(evidence).toContain("const canCaptureChecklist");
    expect(evidence).toContain('allowedActionKeys.has("CAPTURE_RETURN_CHECKLIST")');
    expect(evidence).toContain("disabled={!canCaptureChecklist");
    expect(evidence).not.toContain("closure.capabilities.prepare");
    expect(evidence).toContain("确认车辆及随车资料已取回");
    expect(pricing).toContain("生成受管车况差异");
    expect(pricing).toContain("确认全部责任判定");
    expect(pricing).toContain("按合同生成正式收费清单");
    expect(pricing).toContain("currentPricingSettlementId");
    expect(settlement).toContain("保存归口");
    expect(settlement).toContain("canCompleteFinancialSettlement");
    for (const gate of [
      "canDisposition",
      "canDecideDispute",
      "canSettleFinancial",
      "canReleaseInventory",
      "canCompleteOperations",
      "canExportEvidence",
      "canTransferLegal",
      "canRecordLegalEvent"
    ]) {
      expect(settlement).toContain(gate);
    }
    expect(settlement).not.toContain("const canSettle = closure.capabilities.settle");
    expect(pricing).toContain("canProposeSettlement");
    expect(pricing).toContain("canPreviewPricing");
    expect(pricing).toContain("canFinalizePricing");
    expect(pricing).toContain("canGenerateConditionDelta");
    expect(pricing).toContain("canRecordReturnInspection");
    expect(page).toContain("GENERATE_CONDITION_DELTA");
    expect(page).toContain("RECORD_RETURN_INSPECTION");
    expect(settlement).toContain("完成订单运营闭环");
    expect(settlement).toContain("固化并导出证据包");
    expect(page).toContain("!subscriptionClosure.returnThreeStageEnabled");
  });

  it.each([
    [true, true],
    ["true", false],
    ["TRUE", false],
    [" true", false],
    [1, false],
    [undefined, false]
  ])("only enables the three-stage workspace for boolean true (%j)", (value, expected) => {
    expect(
      buildCustomerSubscriptionClosureView(customerClosure(value)).returnThreeStageEnabled
    ).toBe(expected);
  });
});

function customerClosure(returnThreeStageEnabled: unknown) {
  return {
    allowedActions: [],
    caseNo: "SC-STRICT-BOOLEAN",
    closureCaseId: "closure-1",
    closureType: "NORMAL_COMPLETION",
    financialStatus: "DRAFT",
    nextAction: "等待平台处理",
    returnThreeStageEnabled,
    status: "PREPARING_RETURN"
  };
}

function source(path: string) {
  return readFileSync(join(root, path), "utf8");
}
