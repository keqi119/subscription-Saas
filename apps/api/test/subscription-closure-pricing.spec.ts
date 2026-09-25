import { describe, expect, it, vi } from "vitest";
import { SubscriptionReturnGovernanceService } from "../src/subscription-closure/subscription-return-governance.service";

import {
  acceptedDisputeRepricingDeltaItemIds,
  governedChargeFactsForDeltaItem,
  priceClosureCharge
} from "../src/subscription-closure/subscription-closure-pricing.service";

describe("closure contract pricing", () => {
  it("detects an accepted dispute even when pricing moves to a successor settlement", () => {
    expect(
      acceptedDisputeRepricingDeltaItemIds(
        ["delta-accepted", "delta-chargeable"],
        ["delta-accepted"]
      )
    ).toEqual(["delta-accepted"]);
    expect(acceptedDisputeRepricingDeltaItemIds(["delta-chargeable"], ["delta-accepted"])).toEqual(
      []
    );
  });

  it("derives charge types and quantities from authoritative delta facts", () => {
    expect(
      governedChargeFactsForDeltaItem({
        itemCode: "MILEAGE",
        quantityDifference: 3200,
        responsibility: "CUSTOMER",
        wearClassification: "MANUAL_REVIEW"
      })
    ).toEqual({ chargeType: "OVER_MILEAGE", quantity: 3200 });
    expect(
      governedChargeFactsForDeltaItem({
        itemCode: "KEY",
        quantityDifference: -1,
        responsibility: "CUSTOMER",
        wearClassification: "MISSING"
      })
    ).toEqual({ chargeType: "MISSING_KEY", quantity: 1 });
    expect(
      governedChargeFactsForDeltaItem({
        itemCode: "VEHICLE_EXTERIOR",
        quantityDifference: 0,
        responsibility: "CUSTOMER",
        wearClassification: "NEW_DAMAGE"
      })
    ).toEqual({ chargeType: "DAMAGE_VEHICLE_EXTERIOR", quantity: 1 });
  });

  it("prices from the immutable clause with integer-cent rounding", () => {
    expect(
      priceClosureCharge({
        chargeType: "MISSING_KEY",
        clause: {
          clauseCode: "MISSING_KEY",
          pricingSnapshot: { capCents: 30000, unitPriceCents: 12000 },
          status: "EXECUTABLE"
        },
        evidenceIds: ["evidence-1"],
        quantity: 3
      })
    ).toMatchObject({ amountCents: 30000n, status: "FINAL", unitPriceCents: 12000n });
  });

  it("creates an exception rather than using a default price", () => {
    expect(
      priceClosureCharge({
        chargeType: "DAMAGE",
        clause: null,
        evidenceIds: ["evidence-1"],
        quantity: 1
      })
    ).toMatchObject({ amountCents: 0n, status: "PRICING_EXCEPTION" });
  });

  it("requires governed evidence for a customer-responsible charge", () => {
    expect(() =>
      priceClosureCharge({
        chargeType: "DAMAGE",
        clause: {
          clauseCode: "DAMAGE",
          pricingSnapshot: { unitPriceCents: 50000 },
          status: "EXECUTABLE"
        },
        evidenceIds: [],
        quantity: 1
      })
    ).toThrow("GOVERNED_EVIDENCE_REQUIRED");
  });

  it("only prices mileage above the immutable included quantity", () => {
    expect(
      priceClosureCharge({
        chargeType: "OVER_MILEAGE",
        clause: {
          clauseCode: "OVER_MILEAGE",
          pricingSnapshot: { includedQuantity: 18_000, unitPriceCents: 125 },
          status: "EXECUTABLE"
        },
        evidenceIds: ["evidence-1"],
        quantity: 19_250
      })
    ).toMatchObject({ amountCents: 156250n, status: "FINAL", unitPriceCents: 125n });
  });

  it("prices final mileage as a true-up after prior valid mileage bills", () => {
    expect(
      priceClosureCharge({
        chargeType: "OVER_MILEAGE",
        clause: {
          clauseCode: "OVER_MILEAGE",
          pricingSnapshot: { includedQuantity: 18_000, unitPriceCents: 100 },
          status: "EXECUTABLE"
        },
        evidenceIds: ["return-mileage"],
        priorBilledAmountCents: 50_000n,
        priorBillIds: ["monthly-mileage-bill"],
        quantity: 19_000
      })
    ).toMatchObject({ amountCents: 50_000n, status: "FINAL" });
  });
});

describe("governed pricing evidence replay", () => {
  it("creates a charge and its bill through the real pricing method", async () => {
    const h = pricingHarness();
    expect(await h.price()).toEqual([
      expect.objectContaining({ amountCents: 200n, status: "FINAL" })
    ]);
    expect(h.bills).toHaveLength(1);
  });

  it.each([false, true])(
    "reuses the same evidence and bill when successor=%s",
    async (successor) => {
      const h = pricingHarness();
      const [first] = await h.price();
      const bill = structuredClone(h.bills);
      if (successor) h.nextProposal();
      const [replayed] = await h.price(["evidence-2", "evidence-1"]);
      expect(replayed).toMatchObject({ billId: first!.billId, amountCents: 200n });
      expect(h.bills).toEqual(bill);
      expect(h.billCreate).toHaveBeenCalledTimes(1);
      expect(h.lines).toHaveLength(successor ? 2 : 1);
      if (successor) expect(replayed).toMatchObject({ supersedesLineId: first!.id });
      else expect(replayed).toEqual(first);
    }
  );

  it.each([false, true])(
    "rejects changed evidence without any writes when successor=%s",
    async (successor) => {
      const h = pricingHarness();
      await h.price();
      if (successor) h.nextProposal();
      const snapshot = () =>
        JSON.stringify({ bills: h.bills, lines: h.lines }, (_key, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value
        );
      const before = snapshot();
      await expect(h.price(["evidence-2", "evidence-3"])).rejects.toMatchObject({
        response: {
          code: successor
            ? "CLOSURE_PRICING_ACTIVE_BILL_REPLACEMENT_REQUIRED"
            : "CLOSURE_PRICING_IDEMPOTENCY_CONFLICT"
        }
      });
      expect(snapshot()).toBe(before);
    }
  );
});

function pricingHarness() {
  type Row = Record<string, unknown>;
  const bills: Row[] = [];
  const lines: Row[] = [];
  let proposalId = "proposal-1";
  const evidenceIds = ["evidence-1", "evidence-2", "evidence-3"];
  const clause = {
    id: "clause-1",
    contractId: "contract-1",
    chargeType: "DAMAGE_VEHICLE_EXTERIOR",
    clauseCode: "EXTERIOR",
    status: "EXECUTABLE",
    pricingSnapshot: { unitPriceCents: "200" }
  };
  const billCreate = vi.fn(async ({ data }: { data: Row }) => {
    const row = { ...data };
    bills.push(row);
    return row;
  });
  const tx = {
    $queryRaw: vi.fn(async () => []),
    subscriptionClosureCase: {
      findUnique: vi.fn(async () => ({
        id: "closure-1",
        contractId: "contract-1",
        customerId: "customer-1",
        orderId: "order-1",
        status: "PENDING_SETTLEMENT",
        currentSettlementRevisionId: proposalId,
        currentDeltaRevisionId: "delta-1"
      }))
    },
    subscriptionClosureSettlementRevision: {
      findUnique: vi.fn(async () => ({
        id: proposalId,
        closureCaseId: "closure-1",
        stage: "PROPOSED"
      }))
    },
    subscriptionClosureChargeDisputeDecision: { findMany: vi.fn(async () => []) },
    subscriptionClosureChargeLine: {
      findMany: vi.fn(async () => lines.filter((line) => line.settlementRevisionId === proposalId)),
      findFirst: vi.fn(async () => {
        const previous = [...lines]
          .reverse()
          .find((line) => line.settlementRevisionId !== proposalId);
        return previous
          ? { ...previous, bill: bills.find((bill) => bill.id === previous.billId) }
          : null;
      }),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { ...data };
        lines.push(row);
        return row;
      })
    },
    vehicleReturnEvidenceLink: {
      findMany: vi.fn(async ({ where }: { where: { evidenceId: { in: string[] } } }) =>
        evidenceIds
          .filter((id) => where.evidenceId.in.includes(id))
          .map((evidenceId) => ({ id: `link-${evidenceId}`, evidenceId }))
      )
    },
    contractChargeClauseSnapshot: {
      findMany: vi.fn(async () => [clause]),
      findUnique: vi.fn(async () => clause)
    },
    vehicleConditionDeltaItem: {
      findUnique: vi.fn(async () => ({
        id: "item-1",
        revisionId: "delta-1",
        revision: { id: "delta-1", closureCaseId: "closure-1" },
        itemCode: "VEHICLE_EXTERIOR",
        quantityDifference: 0,
        responsibility: "CUSTOMER",
        wearClassification: "NEW_DAMAGE",
        evidenceSnapshot: { evidenceIds }
      }))
    },
    receivableBill: { create: billCreate }
  };
  // This double proves the call boundary and replay semantics, not PG rollback
  // or the upstream propose/finalize chain (covered by the governed PG suite).
  const prisma = {
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx)
  };
  const service = new SubscriptionReturnGovernanceService(
    prisma as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    { get: () => "true" } as never
  );
  return {
    bills,
    lines,
    billCreate,
    nextProposal: () => {
      proposalId = "proposal-2";
    },
    price: (proofIds = ["evidence-1", "evidence-2"]) =>
      service.createPricing(
        "closure-1",
        {
          finalize: true,
          idempotencyKey: `pricing-${proposalId}`,
          settlementRevisionId: proposalId,
          lines: [
            {
              chargeType: "DAMAGE_VEHICLE_EXTERIOR",
              clauseSnapshotId: "clause-1",
              deltaItemId: "item-1",
              evidenceIds: proofIds,
              exceptionApprovalId: null,
              lineCode: "EXTERIOR",
              quantity: 1,
              responsibility: "CUSTOMER"
            }
          ]
        },
        "actor-1"
      )
  };
}
