import { describe, expect, it } from "vitest";
import { SYSTEM_MENUS } from "@subscription-saas/shared";

import {
  actionAvailability,
  canCreateOrderFromApplication,
  canExecuteOrderChange,
  canGenerateApplicationQuote,
  canGenerateContract,
  canRunSubscriptionChangeAction,
  canRunSubscriptionJourneyAction,
  shouldHideLegacyJourneyAction
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
      {
        applicationSource: "SALES_ASSISTED",
        creditReviewStatus: "PENDING",
        depositStatus: "PENDING_CONFIRM",
        materialReviewStatus: "APPROVED",
        status: "SUBMITTED"
      },
      new Set(["quote:create"])
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("请先完成客户资质 / 授信审核");
  });

  it("disables generating quotes before application review is approved", () => {
    expect(
      canGenerateApplicationQuote(
        {
          applicationSource: "SALES_ASSISTED",
          creditReviewStatus: "APPROVED",
          depositStatus: "CONFIRMED",
          materialReviewStatus: "PENDING",
          status: "SUBMITTED"
        },
        new Set(["quote:create"])
      )
    ).toEqual({ allowed: false, reason: "请先完成资料审核" });
  });

  it("enables assisted applications after material credit and deposit review", () => {
    expect(
      canGenerateApplicationQuote(
        {
          applicationSource: "SALES_ASSISTED",
          creditReviewStatus: "APPROVED",
          depositStatus: "CONFIRMED",
          finalSubscriptionPlanId: null,
          finalVehicleId: null,
          materialReviewStatus: "APPROVED",
          planConfirmStatus: "PENDING",
          productReviewStatus: "PENDING",
          status: "SUBMITTED",
          vehicleReviewStatus: "PENDING"
        },
        new Set(["quote:create"])
      )
    ).toEqual({ allowed: true });
  });

  it("does not require product vehicle or final plan review before assisted quote generation", () => {
    expect(
      canGenerateApplicationQuote(
        {
          applicationSource: "SALES_ASSISTED",
          creditReviewStatus: "APPROVED",
          depositStatus: "CONFIRMED",
          finalSubscriptionPlanId: null,
          finalVehicleId: null,
          materialReviewStatus: "APPROVED",
          planConfirmStatus: "PENDING",
          productReviewStatus: "PENDING",
          status: "SUBMITTED",
          vehicleReviewStatus: "PENDING"
        },
        new Set(["quote:create"])
      )
    ).toEqual({ allowed: true });
  });

  it("keeps legacy approved assisted applications eligible for quote generation", () => {
    expect(
      canGenerateApplicationQuote(
        {
          applicationSource: "SALES_ASSISTED",
          creditReviewStatus: "PENDING",
          depositStatus: "PENDING_CONFIRM",
          materialReviewStatus: "PENDING",
          status: "APPROVED"
        },
        new Set(["quote:create"])
      )
    ).toEqual({ allowed: true });
  });

  it("routes self-service applications away from the assisted quote button", () => {
    expect(
      canGenerateApplicationQuote(
        {
          applicationSource: "SELF_SERVICE",
          creditReviewStatus: "APPROVED",
          depositStatus: "CONFIRMED",
          materialReviewStatus: "APPROVED",
          status: "SUBMITTED"
        },
        new Set(["quote:create"])
      )
    ).toEqual({ allowed: false, reason: "客户自助进件请使用确认最终方案 / 生成正式订单流程" });
  });

  it("disables assisted quote generation without quote permission", () => {
    expect(
      canGenerateApplicationQuote(
        {
          applicationSource: "SALES_ASSISTED",
          creditReviewStatus: "APPROVED",
          depositStatus: "CONFIRMED",
          materialReviewStatus: "APPROVED",
          status: "SUBMITTED"
        },
        new Set<string>()
      )
    ).toEqual({ allowed: false, reason: "无生成订阅报价权限" });
  });

  it("disables assisted quote generation before deposit confirmation", () => {
    expect(
      canGenerateApplicationQuote(
        {
          applicationSource: "SALES_ASSISTED",
          creditReviewStatus: "APPROVED",
          depositStatus: "PENDING_CONFIRM",
          materialReviewStatus: "APPROVED",
          status: "SUBMITTED"
        },
        new Set(["quote:create"])
      )
    ).toEqual({ allowed: false, reason: "请先确认押金" });
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

  it.each([
    ["QUOTE", "subscription_change:quote"],
    ["APPROVE_PRICE", "subscription_change:price_override_approve"],
    ["WAIT_CUSTOMER", "subscription_change:submit"],
    ["GENERATE_CONTRACT", "contract:generate"],
    ["START_ESIGN", "subscription_change:esign_retry"],
    ["RETRY", "subscription_change:execute"],
    ["MANUAL", "subscription_change:manual_takeover"]
  ] as const)("gates the %s subscription-change action with %s", (kind, permission) => {
    expect(canRunSubscriptionChangeAction(kind, new Set([permission]))).toEqual({ allowed: true });
    expect(canRunSubscriptionChangeAction(kind, new Set())).toEqual({
      allowed: false,
      reason: "无合同变更操作权限"
    });
  });

  it("never turns waiting or completed presentations into mutation buttons", () => {
    expect(canRunSubscriptionChangeAction("WAIT_ARCHIVE", new Set(["subscription_change:execute"]))).toEqual({
      allowed: false,
      reason: "当前步骤无需人工操作"
    });
    expect(canRunSubscriptionChangeAction("DONE", new Set(["subscription_change:execute"]))).toEqual({
      allowed: false,
      reason: "当前步骤无需人工操作"
    });
  });

  it.each([
    ["FINAL_PLAN_DECISION", "subscription_journey:plan_decide"],
    ["FINAL_VEHICLE_ALLOCATION", "subscription_journey:vehicle_allocate"],
    ["DELIVERY_EVIDENCE_DECISION", "subscription_journey:delivery_evidence_decide"],
    ["RETRY", "subscription_journey:recover"],
    ["PAUSE", "subscription_journey:recover"],
    ["RESUME", "subscription_journey:recover"],
    ["CANCEL", "subscription_journey:cancel"]
  ] as const)("gates Journey action %s with %s", (action, permission) => {
    expect(canRunSubscriptionJourneyAction(action, [action], new Set([permission]))).toEqual({
      allowed: true
    });
    expect(canRunSubscriptionJourneyAction(action, [action], new Set())).toEqual({
      allowed: false,
      reason: "无订阅流程操作权限"
    });
  });

  it("hides only conflicting legacy progression for Journey-backed records", () => {
    for (const action of [
      "CREATE_ORDER",
      "GENERATE_INITIAL_BILLS",
      "REGISTER_INITIAL_PAYMENT",
      "SIGN_OR_ARCHIVE_CONTRACT",
      "CONFIRM_DELIVERY"
    ] as const) {
      expect(shouldHideLegacyJourneyAction(true, action)).toBe(true);
      expect(shouldHideLegacyJourneyAction(false, action)).toBe(false);
    }
    expect(shouldHideLegacyJourneyAction(true, "GENERATE_MONTHLY_RENT")).toBe(false);
  });

  it("does not add a top-level Journey navigation page", () => {
    expect(SYSTEM_MENUS.some((menu) => menu.code === "subscription_journeys")).toBe(false);
  });
});
