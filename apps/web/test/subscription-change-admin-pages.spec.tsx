import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const listPage = readFileSync(
  join(repoRoot, "apps/web/src/app/subscription-changes/page.tsx"),
  "utf8"
);
const detailPage = readFileSync(
  join(repoRoot, "apps/web/src/app/subscription-changes/[id]/page.tsx"),
  "utf8"
);
const orderPage = readFileSync(
  join(repoRoot, "apps/web/src/app/orders/[id]/page.tsx"),
  "utf8"
);

describe("Admin subscription change pages", () => {
  it("builds the center from renewal considerations with explicit retry/error and SMS failure filtering", () => {
    expect(listPage).toContain("listRenewalConsiderations");
    expect(listPage).toContain("smsFailed");
    expect(listPage).toContain("重试加载");
    expect(listPage).toContain("原合同到期日");
    expect(listPage).toContain("已签约至");
  });

  it("renders price approval, reminder failures, PDF links and only defined recovery actions", () => {
    expect(detailPage).toContain("getSubscriptionChangePriceApproval");
    expect(detailPage).toContain("提醒与渠道状态");
    expect(detailPage).toContain("generated-pdf/preview");
    expect(detailPage).toContain("retrySubscriptionChangeJob");
    expect(detailPage).toContain("人工接管");
    expect(detailPage).not.toMatch(/修改状态|setStatus|status mutation/i);
  });

  it("keeps V2 contract extensions separate from legacy order changes in the order workspace", () => {
    expect(orderPage).toContain("listSubscriptionChangesForOrder");
    expect(orderPage).toContain("合同续订 / 协议延长");
    expect(orderPage).toContain("旧版订单变更记录");
    expect(orderPage).toContain("/subscription-changes/");
  });

  it("exposes four ACTIVE-order change types and names the legacy action as pre-delivery only", () => {
    expect(orderPage).toContain('label: "发起合同变更"');
    expect(orderPage).toContain("续期");
    expect(orderPage).toContain("换车");
    expect(orderPage).toContain("提前结束");
    expect(orderPage).toContain("其他合同变更");
    expect(orderPage).toContain("交付前退回重做方案");
    expect(orderPage).toContain('activeSubscriptionPricingMode !== "ORIGINAL_PRICE"');
    expect(orderPage).toContain("请选择目标订阅套餐 ID");
    expect(orderPage).toContain("subscriptionChangesLoaded");
    expect(orderPage).toContain("合同变更状态加载完成后才可发起变更");
  });

  it("renders typed change facts and only backend-provided actions", () => {
    expect(detailPage).toContain("change.allowedActions");
    expect(detailPage).toContain("SUBSCRIPTION_CHANGE_TYPE_LABELS");
    expect(detailPage).toContain("inboundWorkOrderId");
    expect(detailPage).toContain("outboundWorkOrderId");
    expect(detailPage).toContain("closureCaseId");
    expect(detailPage).toContain("approveManagedOtherChange");
    expect(detailPage).toContain("executeManagedOtherChange");
  });
});
