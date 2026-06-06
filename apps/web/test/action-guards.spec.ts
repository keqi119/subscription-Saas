import { describe, expect, it } from "vitest";

import {
  actionAvailability,
  canCreateOrderFromApplication,
  canExecuteOrderChange,
  canGenerateApplicationQuote,
  canGenerateContract
} from "../src/lib/action-guards";

describe("action guards", () => {
  it("disables actions when the user has no permission", () => {
    expect(
      actionAvailability({
        permission: "quote:create",
        permissions: new Set<string>()
      })
    ).toEqual({ allowed: false, reason: "无操作权限" });
  });

  it("disables actions when the workflow state is not allowed", () => {
    expect(
      actionAvailability({
        allowed: false,
        disabledReason: "当前状态不允许操作",
        permissions: new Set(["quote:create"])
      })
    ).toEqual({ allowed: false, reason: "当前状态不允许操作" });
  });

  it("enables actions when permission and workflow state are both satisfied", () => {
    expect(
      actionAvailability({
        allowed: true,
        permission: "quote:create",
        permissions: new Set(["quote:create"])
      })
    ).toEqual({ allowed: true });
  });

  it("returns a Chinese disabled reason", () => {
    const result = canGenerateApplicationQuote(
      { creditReviewStatus: "PENDING", depositStatus: "PENDING_CONFIRM", status: "SUBMITTED" },
      new Set(["quote:create"])
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("请先完成客户资质审核");
  });

  it("disables generating quotes before application review is approved", () => {
    expect(
      canGenerateApplicationQuote(
        { creditReviewStatus: "PENDING", depositStatus: "CONFIRMED", status: "SUBMITTED" },
        new Set(["quote:create"])
      )
    ).toEqual({ allowed: false, reason: "请先完成客户资质审核" });
  });

  it("disables creating an official order before final plan confirmation", () => {
    expect(
      canCreateOrderFromApplication(
        { orders: [], planConfirmStatus: "PENDING", status: "APPROVED" },
        new Set(["order:create", "quote:create"])
      )
    ).toEqual({ allowed: false, reason: "请先确认最终方案" });
  });

  it("disables generating contracts outside PENDING_CONTRACT", () => {
    expect(
      canGenerateContract(
        { contract: null, orderStatus: "PENDING_SIGN" },
        new Set(["contract:generate"])
      )
    ).toEqual({ allowed: false, reason: "当前订单状态不允许生成合同" });
  });

  it("disables executing order changes before approval", () => {
    expect(
      canExecuteOrderChange(
        { executedAt: null, status: "PENDING" },
        { orderStatus: "PENDING_CONTRACT" },
        new Set(["order_change:execute"])
      )
    ).toEqual({ allowed: false, reason: "当前变更状态不允许执行" });
  });
});
