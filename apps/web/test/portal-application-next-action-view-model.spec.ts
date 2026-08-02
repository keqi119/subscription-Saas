import { describe, expect, it } from "vitest";

import { buildPortalApplicationNextActionCard } from "../src/lib/portal-application-next-action-view-model";
import type { PortalApplicationProgress } from "../src/lib/portal-types";

function progress(
  nextAction: string,
  overallStatus: string,
  nextActionTarget: PortalApplicationProgress["nextActionTarget"]
) {
  return {
    nextAction,
    nextActionTarget,
    overallStatus
  } as PortalApplicationProgress;
}

describe("buildPortalApplicationNextActionCard", () => {
  it.each([
    [
      progress("GO_CONTRACT", "PENDING_CONTRACT", {
        label: "去签署合同",
        url: "/portal/contracts/contract-1"
      }),
      "warning"
    ],
    [
      progress("GO_PAYMENT", "PENDING_PAYMENT", {
        label: "去支付",
        url: "/portal/bills?orderId=order-1"
      }),
      "warning"
    ],
    [
      progress("WAIT_DELIVERY", "PENDING_DELIVERY", {
        label: "处理车辆交接",
        url: "/portal/handover-reviews/handover-1"
      }),
      "info"
    ],
    [
      progress("NONE", "ACTIVE", {
        label: "查看已交付订单",
        url: "/portal/orders/order-1"
      }),
      "success"
    ]
  ])("builds the server-projected portal action card", (applicationProgress, tone) => {
    expect(buildPortalApplicationNextActionCard(applicationProgress, "下一步处理提示")).toEqual({
      label: applicationProgress.nextActionTarget?.label,
      message: "下一步处理提示",
      tone,
      url: applicationProgress.nextActionTarget?.url
    });
  });

  it("keeps page-local and waiting states without a navigation card", () => {
    expect(
      buildPortalApplicationNextActionCard(
        progress("WAIT_ORDER_CREATION", "PENDING_ORDER", null),
        "等待平台生成正式订单"
      )
    ).toBeNull();
  });

  it("keeps My Application guidance actionable for a due mileage review", () => {
    expect(
      buildPortalApplicationNextActionCard(
        progress("SUBMIT_MILEAGE_REVIEW", "ACTIVE", {
          label: "提交本月里程",
          url: "/portal/mileage-reviews/review-1"
        }),
        "订单已交付"
      )
    ).toEqual({
      label: "提交本月里程",
      message: "本月里程复核待提交，请填写累计里程并上传仪表盘照片。",
      tone: "warning",
      url: "/portal/mileage-reviews/review-1"
    });
  });
});
