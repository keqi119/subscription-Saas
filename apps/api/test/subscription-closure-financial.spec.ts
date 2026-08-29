import { describe, expect, it } from "vitest";

import {
  deriveClosureFinancialState,
  mayCompleteOperations
} from "../src/subscription-closure/subscription-closure-financial.service";
import {
  assertLegalCollectionTransferReady,
  hasBlockingLegalCollectionDispute
} from "../src/subscription-closure/subscription-return-governance.service";

describe("closure financial disposition", () => {
  it("does not treat legal transfer as payment while permitting governed operational completion", () => {
    const result = deriveClosureFinancialState([
      {
        billId: "bill-1",
        disposition: "LEGAL_COLLECTION",
        remainingAmountCents: 9000n,
        ownerId: "legal-team"
      }
    ]);

    expect(result).toEqual({
      financialStatus: "LEGAL_COLLECTION",
      openAmountCents: 9000n,
      paidAmountCents: 0n
    });
    expect(mayCompleteOperations(result, { inventoryReleased: true, physicalReceiptComplete: true }))
      .toBe(true);
  });

  it("fails closed on an orphaned open receivable", () => {
    const result = deriveClosureFinancialState([
      { billId: "bill-1", disposition: "OPEN", remainingAmountCents: 500n, ownerId: null }
    ]);
    expect(mayCompleteOperations(result, { inventoryReleased: true, physicalReceiptComplete: true }))
      .toBe(false);
  });

  it.each(["PAID", "MANUAL_PAYMENT_CONFIRMED", "WAIVED", "WRITTEN_OFF"] as const)(
    "does not let a %s label erase a positive database balance",
    (disposition) => {
      const result = deriveClosureFinancialState([
        {
          billId: "bill-1",
          disposition,
          remainingAmountCents: 1200n,
          ownerId: "finance-team"
        }
      ]);

      expect(result.openAmountCents).toBe(1200n);
      expect(
        mayCompleteOperations(result, {
          inventoryReleased: true,
          physicalReceiptComplete: true
        })
      ).toBe(false);
    }
  );

  it("keeps written-off debt distinct while allowing operational completion", () => {
    const result = deriveClosureFinancialState([
      {
        billId: "bill-1",
        disposition: "WRITTEN_OFF",
        remainingAmountCents: 0n,
        ownerId: "finance-team"
      }
    ]);

    expect(result).toMatchObject({ financialStatus: "WRITTEN_OFF", openAmountCents: 0n });
    expect(
      mayCompleteOperations(result, { inventoryReleased: true, physicalReceiptComplete: true })
    ).toBe(true);
  });

  it.each([
    [
      "CLOSURE_LEGAL_FINAL_SETTLEMENT_REQUIRED",
      { settlement: { id: "settlement-1", resultHash: "hash-1", stage: "PROPOSED" } }
    ],
    ["CLOSURE_LEGAL_CUSTOMER_RESPONSE_REQUIRED", { response: null }],
    ["CLOSURE_LEGAL_DISPUTE_BLOCKED", { hasBlockingDispute: true }],
    ["CLOSURE_LEGAL_COLLECTION_DISPOSITION_REQUIRED", { disposition: null }],
    ["CLOSURE_LEGAL_OWNER_MISMATCH", { transferOwnerId: "legal-owner-2" }]
  ])("blocks an out-of-order legal transfer with %s", (code, override) => {
    let caught: unknown;
    try {
      assertLegalCollectionTransferReady({ ...legalReadyFixture(), ...override } as never);
    } catch (error) {
      caught = error;
    }
    expect((caught as { getResponse: () => unknown }).getResponse()).toMatchObject({ code });
  });

  it("allows legal transfer only after final publication, response and owned collection routing", () => {
    expect(() => assertLegalCollectionTransferReady(legalReadyFixture())).not.toThrow();
  });

  it("uses the immutable dispute decision rather than a stale OPEN projection", () => {
    expect(
      hasBlockingLegalCollectionDispute([
        { decision: { decision: "REJECTED_BY_PLATFORM" }, status: "OPEN" }
      ])
    ).toBe(false);
    expect(
      hasBlockingLegalCollectionDispute([{ decision: null, status: "OPEN" }])
    ).toBe(true);
    expect(
      hasBlockingLegalCollectionDispute([
        { decision: { decision: "ACCEPTED_BY_PLATFORM" }, status: "OPEN" }
      ])
    ).toBe(true);
  });
});

function legalReadyFixture() {
  return {
    disposition: {
      disposition: "COLLECTION_PENDING",
      id: "disposition-1",
      ownerId: "legal-owner-1",
      ownerType: "LEGAL_TEAM"
    },
    hasBlockingDispute: false,
    response: {
      settlementHash: "hash-1",
      settlementRevisionId: "settlement-1",
      status: "NO_RESPONSE"
    },
    settlement: { id: "settlement-1", resultHash: "hash-1", stage: "FINALIZED" },
    transferOwnerId: "legal-owner-1",
    transferOwnerType: "LEGAL_TEAM"
  };
}
