import { describe, expect, it } from "vitest";

import { CollectionPriorityModel } from "../src/fleet-ops/risk/collection-priority.model";
import { CollectionPriorityLevel } from "../src/fleet-ops/risk/risk.types";

describe("CollectionPriorityModel", () => {
  it.each([
    [0, CollectionPriorityLevel.NONE],
    [1, CollectionPriorityLevel.D1],
    [3, CollectionPriorityLevel.D1],
    [4, CollectionPriorityLevel.D2],
    [7, CollectionPriorityLevel.D2],
    [8, CollectionPriorityLevel.D3],
    [15, CollectionPriorityLevel.D3],
    [16, CollectionPriorityLevel.D4],
    [30, CollectionPriorityLevel.D4],
    [31, CollectionPriorityLevel.D5]
  ])("maps %i overdue day(s) to %s", (overdueDays, expectedLevel) => {
    expect(new CollectionPriorityModel().assignByOverdueDays(overdueDays)).toBe(expectedLevel);
  });

  it("keeps risk score escalation separate from aging bucket", () => {
    const level = new CollectionPriorityModel().assign({
      exposure: {
        evidence: [],
        maxOverdueDays: 0,
        overdueAmount: 0,
        overdueBillCount: 0,
        overdueBillRefs: [],
        overdueRemainingAmount: 0,
        partialPaymentCount: 0,
        partialPaymentEvidence: [],
        score: 90,
        unpaidAmount: 0,
        warnings: [],
        writeOffEvidence: []
      },
      exposureScore: 90,
      riskScore: 95
    });

    expect(level).toBe(CollectionPriorityLevel.NONE);
  });
});
