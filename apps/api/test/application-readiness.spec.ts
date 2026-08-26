import {
  ApplicationStatus,
  DepositStatus,
  OrderReviewStatus
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import { classifyApplicationReadiness } from "../src/subscription-journey/application-readiness";

describe("application journey readiness", () => {
  it("is ready only after material, credit, and deposit facts are approved", () => {
    expect(classifyApplicationReadiness(readinessFacts())).toEqual({
      factVersion: 4,
      outcome: "READY",
      reasonCodes: []
    });
  });

  it("returns a manual wait for pending platform reviews", () => {
    expect(
      classifyApplicationReadiness(
        readinessFacts({
          creditReviewStatus: OrderReviewStatus.PENDING,
          depositStatus: DepositStatus.PENDING_CONFIRM,
          finalDepositAmount: null,
          materialReviewStatus: OrderReviewStatus.PENDING
        })
      )
    ).toEqual({
      factVersion: 4,
      outcome: "WAITING_MANUAL",
      reasonCodes: [
        "MATERIAL_REVIEW_PENDING",
        "CREDIT_REVIEW_PENDING",
        "DEPOSIT_CONFIRMATION_PENDING"
      ]
    });
  });

  it("returns a customer wait when reviewed facts require supplementation", () => {
    expect(
      classifyApplicationReadiness(
        readinessFacts({ materialReviewStatus: OrderReviewStatus.NEED_MORE_INFO })
      )
    ).toEqual({
      factVersion: 4,
      outcome: "WAITING_CUSTOMER",
      reasonCodes: ["MATERIAL_SUPPLEMENT_REQUIRED"]
    });
  });

  it.each([
    [
      { materialReviewStatus: OrderReviewStatus.REJECTED },
      "MATERIAL_REVIEW_REJECTED"
    ],
    [{ creditReviewStatus: OrderReviewStatus.REJECTED }, "CREDIT_REVIEW_REJECTED"],
    [{ depositStatus: DepositStatus.REJECTED }, "DEPOSIT_REJECTED"],
    [{ status: ApplicationStatus.CANCELLED }, "APPLICATION_CANCELLED"]
  ])("returns a terminal rejection for %s", (override, reasonCode) => {
    expect(classifyApplicationReadiness(readinessFacts(override))).toEqual({
      factVersion: 4,
      outcome: "REJECTED",
      reasonCodes: [reasonCode]
    });
  });
});

function readinessFacts(overrides: Record<string, unknown> = {}) {
  return {
    creditReviewStatus: OrderReviewStatus.APPROVED,
    depositStatus: DepositStatus.CONFIRMED,
    finalDepositAmount: 300_000n,
    journeyFactVersion: 4,
    materialReviewStatus: OrderReviewStatus.APPROVED,
    status: ApplicationStatus.SUBMITTED,
    ...overrides
  };
}
