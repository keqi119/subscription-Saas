import { describe, expect, it } from "vitest";

import { compileContractChargeClauses } from "../src/contract/contract-charge-clause";

describe("contract charge clause compiler", () => {
  it("compiles an exact customer-visible over-mileage term deterministically", () => {
    const clauses = compileContractChargeClauses({
      contentTemplate: "超里程费以订单附件为准。",
      order: { mileageLimitKm: 1_500, overMileageFeeAmount: 125, periodMonths: 12 },
      quoteSnapshot: { mileageLimitKm: 1_500, overMileageFeeAmount: 125 }
    });

    expect(clauses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        chargeType: "OVER_MILEAGE",
        clauseCode: "OVER_MILEAGE",
        status: "EXECUTABLE",
        unit: "KILOMETER"
      })
    ]));
    expect(clauses[0]?.pricingSnapshot).toEqual({
      includedQuantity: 18000,
      monthlyIncludedQuantity: 1500,
      periodMonths: 12,
      unitPriceCents: 125
    });
    expect(clauses[0]?.compilationHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed instead of inventing a missing customer-visible price", () => {
    expect(
      compileContractChargeClauses({ contentTemplate: "车辆损伤费用另行确认", order: {} })
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({
        chargeType: "OVER_MILEAGE",
        status: "MANUAL_CLAUSE_REVIEW_REQUIRED"
      })
    ]));
  });
});
