import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { dateRangesOverlap, toDepositRuleView, toRiskResultView } from "../src/risk/risk.service";

describe("risk rule helpers", () => {
  it("detects overlapping open-ended deposit rule date ranges", () => {
    expect(
      dateRangesOverlap(
        new Date("2026-01-01T00:00:00.000Z"),
        null,
        new Date("2026-06-01T00:00:00.000Z"),
        new Date("2026-12-31T00:00:00.000Z")
      )
    ).toBe(true);

    expect(
      dateRangesOverlap(
        new Date("2026-01-01T00:00:00.000Z"),
        new Date("2026-03-31T00:00:00.000Z"),
        new Date("2026-04-01T00:00:00.000Z"),
        null
      )
    ).toBe(false);
  });

  it("serializes deposit rules and risk results without bigint or decimal leaks", () => {
    const depositRuleView = toDepositRuleView({
      createdAt: new Date("2026-05-30T00:00:00.000Z"),
      createdBy: null,
      customerRatio: new Prisma.Decimal("0.350000"),
      defaultRate: new Prisma.Decimal("0.028000"),
      deletedAt: null,
      depositAmount: 1000000n,
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      effectiveTo: null,
      grade: "B",
      id: "00000000-0000-4000-8000-000000000501",
      status: "ACTIVE",
      updatedAt: new Date("2026-05-30T00:00:00.000Z"),
      updatedBy: null
    });

    const riskResultView = toRiskResultView({
      applicationId: "00000000-0000-4000-8000-000000000201",
      approvedAt: new Date("2026-05-30T00:00:00.000Z"),
      approvedBy: "00000000-0000-4000-8000-000000000001",
      approvedDepositAmount: 1000000n,
      approver: { id: "00000000-0000-4000-8000-000000000001", name: "风控", username: "rc" },
      createdAt: new Date("2026-05-30T00:00:00.000Z"),
      createdBy: "00000000-0000-4000-8000-000000000001",
      customerId: "00000000-0000-4000-8000-000000000101",
      defaultRate: new Prisma.Decimal("0.028000"),
      deletedAt: null,
      grade: "B",
      id: "00000000-0000-4000-8000-000000000601",
      maxVehiclePurchasePriceAmount: 18000000n,
      remark: "通过",
      result: "APPROVED",
      score: 720,
      updatedAt: new Date("2026-05-30T00:00:00.000Z"),
      updatedBy: "00000000-0000-4000-8000-000000000001"
    } as Parameters<typeof toRiskResultView>[0]);

    expect(depositRuleView.depositAmount).toBe(1000000);
    expect(depositRuleView.defaultRate).toBe(0.028);
    expect(riskResultView.approvedDepositAmount).toBe(1000000);
    expect(riskResultView.maxVehiclePurchasePriceAmount).toBe(18000000);
  });
});
