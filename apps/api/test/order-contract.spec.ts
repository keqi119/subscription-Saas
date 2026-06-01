import { BusinessType, OrderChangeType } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { ensureAllowedChangeType, ensureSubscriptionBusinessType } from "../src/order/order.service";

describe("subscription order and contract rules", () => {
  it("defaults order business type to subscription", () => {
    expect(ensureSubscriptionBusinessType()).toBe(BusinessType.SUBSCRIPTION);
    expect(ensureSubscriptionBusinessType(BusinessType.SUBSCRIPTION)).toBe(BusinessType.SUBSCRIPTION);
  });

  it("rejects rent-to-own order creation during the current phase", () => {
    expect(() => ensureSubscriptionBusinessType(BusinessType.RENT_TO_OWN)).toThrow(
      "当前阶段暂未开放以租代购订单"
    );
  });

  it("allows current-stage subscription order change types", () => {
    expect(() => ensureAllowedChangeType(OrderChangeType.PLAN_CHANGE)).not.toThrow();
    expect(() => ensureAllowedChangeType(OrderChangeType.VEHICLE_SWAP)).not.toThrow();
    expect(() => ensureAllowedChangeType(OrderChangeType.TERMINATION)).not.toThrow();
  });

  it("rejects rent-to-own only order change types during the current phase", () => {
    expect(() => ensureAllowedChangeType(OrderChangeType.BUYOUT)).toThrow("当前阶段暂未开放以租代购订单变更");
    expect(() => ensureAllowedChangeType(OrderChangeType.EARLY_SETTLEMENT)).toThrow(
      "当前阶段暂未开放以租代购订单变更"
    );
    expect(() => ensureAllowedChangeType(OrderChangeType.OWNERSHIP_TRANSFER)).toThrow(
      "当前阶段暂未开放以租代购订单变更"
    );
  });
});
