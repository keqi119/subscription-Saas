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

describe("manual pricing approval evidence membership", () => {
  it("accepts checklist and damage links for the same evidence and preserves unique approval IDs", async () => {
    const h = pricingHarness({ manual: true, evidenceLinks: multiLinkedEvidence() });
    const approval = await h.requestApproval(["evidence-2", "evidence-1", "evidence-1"]);
    expect(approval).toMatchObject({
      subjectField: "pricingOverride:item-1",
      subjectSnapshot: { evidenceIds: ["evidence-1", "evidence-2"] }
    });
    expect(h.approvalRequest).toHaveBeenCalledTimes(1);
    expect(h.bills).toHaveLength(0);
    expect(h.lines).toHaveLength(0);
  });

  it("reaches the missing approval guard after validating legitimate multi-linked evidence", async () => {
    const h = pricingHarness({ manual: true, evidenceLinks: multiLinkedEvidence() });
    await expect(h.price()).rejects.toMatchObject({
      response: { code: "CLOSURE_PRICING_APPROVAL_REQUIRED" }
    });
    expect(h.billCreate).not.toHaveBeenCalled();
    expect(h.lines).toHaveLength(0);
  });

  it("prices exactly once with a controlled currently approved snapshot and multi-linked evidence", async () => {
    const h = pricingHarness({ manual: true, evidenceLinks: multiLinkedEvidence() });
    await h.requestApproval();
    h.approve();
    const first = await h.price();
    expect(first).toEqual([
      expect.objectContaining({
        amountCents: 200n,
        status: "FINAL",
        exceptionApprovalId: "approval-1"
      })
    ]);
    expect(await h.price()).toEqual(first);
    expect(h.billCreate).toHaveBeenCalledTimes(1);
    expect(h.lines).toHaveLength(1);
  });

  it.each(["missing", "foreign", "duplicate masking missing", "duplicate masking foreign"])(
    "rejects %s evidence through the real approval entry without delegating or writing",
    async (kind) => {
      const rows = multiLinkedEvidence().filter((row) => row.evidenceId !== "evidence-2");
      if (!kind.startsWith("duplicate")) rows.splice(1, 1);
      if (kind.includes("foreign"))
        rows.push({
          id: "foreign-link",
          closureCaseId: "other-case",
          evidenceId: "evidence-2",
          evidencePurpose: "CHECKLIST_PROOF"
        });
      const h = pricingHarness({ manual: true, evidenceLinks: rows });
      await expect(h.requestApproval()).rejects.toMatchObject({
        response: { code: "CLOSURE_PRICING_APPROVAL_AUTHORITY_MISMATCH" }
      });
      expect(h.approvalRequest).not.toHaveBeenCalled();
      expect(h.billCreate).not.toHaveBeenCalled();
      expect(h.lines).toHaveLength(0);
    }
  );

  it.each(["rejected", "pending", "expired", "changed price", "changed proposal"])(
    "preserves the approval guard for %s despite valid multi-linked evidence",
    async (kind) => {
      const h = pricingHarness({ manual: true, evidenceLinks: multiLinkedEvidence() });
      await h.requestApproval();
      h.approve(
        kind === "rejected"
          ? { status: "REJECTED", decision: "REJECTED" }
          : kind === "pending"
            ? { status: "PENDING", decision: null }
            : kind === "expired"
              ? { expiredAt: new Date("2026-09-01T00:00:00Z") }
              : {}
      );
      if (kind === "changed proposal") h.nextProposal();
      await expect(
        h.price(undefined, kind === "changed price" ? { manualUnitPriceCents: "201" } : {})
      ).rejects.toMatchObject({
        response: { code: "CLOSURE_PRICING_APPROVAL_REQUIRED" }
      });
      expect(h.billCreate).not.toHaveBeenCalled();
      expect(h.lines).toHaveLength(0);
    }
  );

  it.each(["contract", "clause status", "delta revision"])(
    "preserves the %s authority guard",
    async (kind) => {
      const h = pricingHarness({
        manual: true,
        evidenceLinks: multiLinkedEvidence(),
        clauseContractId: kind === "contract" ? "other-contract" : undefined,
        clauseStatus: kind === "clause status" ? "EXECUTABLE" : undefined,
        deltaRevisionId: kind === "delta revision" ? "old-delta" : undefined
      });
      await expect(h.requestApproval()).rejects.toMatchObject({
        response: { code: "CLOSURE_PRICING_APPROVAL_AUTHORITY_MISMATCH" }
      });
      expect(h.approvalRequest).not.toHaveBeenCalled();
    }
  );

  it("retains the empty evidence and stale settlement guards", async () => {
    const h = pricingHarness({ manual: true, evidenceLinks: multiLinkedEvidence() });
    await expect(h.requestApproval([])).rejects.toMatchObject({
      response: { code: "CLOSURE_APPROVAL_EVIDENCE_REQUIRED" }
    });
    await expect(h.requestApproval(undefined, "old-proposal")).rejects.toMatchObject({
      response: { code: "CLOSURE_APPROVAL_STALE" }
    });
    expect(h.approvalRequest).not.toHaveBeenCalled();
    expect(h.billCreate).not.toHaveBeenCalled();
    expect(h.lines).toHaveLength(0);
  });
});

type EvidenceLinkRow = {
  id: string;
  closureCaseId: string;
  evidenceId: string;
  evidencePurpose: string;
};
function multiLinkedEvidence(): EvidenceLinkRow[] {
  return [
    {
      id: "link-a-checklist",
      closureCaseId: "closure-1",
      evidenceId: "evidence-1",
      evidencePurpose: "CHECKLIST_PROOF"
    },
    {
      id: "link-a-damage",
      closureCaseId: "closure-1",
      evidenceId: "evidence-1",
      evidencePurpose: "DAMAGE_PROOF"
    },
    {
      id: "link-b-checklist",
      closureCaseId: "closure-1",
      evidenceId: "evidence-2",
      evidencePurpose: "CHECKLIST_PROOF"
    }
  ];
}

function pricingHarness(
  options: {
    manual?: boolean;
    evidenceLinks?: EvidenceLinkRow[];
    clauseContractId?: string;
    clauseStatus?: string;
    deltaRevisionId?: string;
  } = {}
) {
  type Row = Record<string, unknown>;
  const bills: Row[] = [];
  const lines: Row[] = [];
  let proposalId = "proposal-1";
  const evidenceIds = ["evidence-1", "evidence-2", "evidence-3"];
  const evidenceLinks =
    options.evidenceLinks ??
    evidenceIds.map((evidenceId) => ({
      id: `link-${evidenceId}`,
      closureCaseId: "closure-1",
      evidenceId,
      evidencePurpose: "CHECKLIST_PROOF"
    }));
  type EvidenceQuery = {
    where: { closureCaseId: string; evidenceId: { in: readonly string[] } };
    select?: { evidenceId: boolean };
  };
  const matchingEvidence = ({ where }: EvidenceQuery) =>
    evidenceLinks.filter(
      (row) =>
        row.closureCaseId === where.closureCaseId && where.evidenceId.in.includes(row.evidenceId)
    );
  const approvals = new Map<string, Row>();
  // This dependency double captures the real governance authority snapshot. Approval
  // status is an explicit controlled fact; it does not prove Asset Accounting authorization.
  const approvalRequest = vi.fn(
    async (
      _client: unknown,
      command: {
        exceptionType: string;
        subject: { subjectField: string; subjectId: string; subjectType: string };
      },
      _context: unknown,
      resolveSnapshot: () => Promise<unknown>
    ) => {
      const row = {
        id: "approval-1",
        ...command.subject,
        exceptionType: command.exceptionType,
        status: "PENDING",
        decision: null,
        expiredAt: null,
        subjectSnapshot: await resolveSnapshot()
      };
      approvals.set(row.id, row);
      return row;
    }
  );
  const clause = {
    id: "clause-1",
    contractId: options.clauseContractId ?? "contract-1",
    chargeType: "DAMAGE_VEHICLE_EXTERIOR",
    clauseCode: "EXTERIOR",
    status:
      options.clauseStatus ?? (options.manual ? "MANUAL_CLAUSE_REVIEW_REQUIRED" : "EXECUTABLE"),
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
        stage: "PROPOSED",
        resultHash: `hash-${proposalId}`
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
      count: vi.fn(async (query: EvidenceQuery) => matchingEvidence(query).length),
      findMany: vi.fn(async (query: EvidenceQuery) =>
        matchingEvidence(query).map((row) =>
          query.select?.evidenceId ? { evidenceId: row.evidenceId } : { ...row }
        )
      )
    },
    contractChargeClauseSnapshot: {
      findMany: vi.fn(async () => [clause]),
      findUnique: vi.fn(async () => clause)
    },
    vehicleConditionDeltaItem: {
      findUnique: vi.fn(async () => ({
        id: "item-1",
        revisionId: options.deltaRevisionId ?? "delta-1",
        revision: { id: "delta-1", closureCaseId: "closure-1" },
        itemCode: "VEHICLE_EXTERIOR",
        quantityDifference: 0,
        responsibility: "CUSTOMER",
        wearClassification: "NEW_DAMAGE",
        evidenceSnapshot: { evidenceIds }
      }))
    },
    receivableBill: { create: billCreate },
    businessExceptionApproval: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => approvals.get(where.id) ?? null
      )
    }
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
    { requestApprovalInTransaction: approvalRequest } as never,
    { get: () => "true" } as never
  );
  return {
    bills,
    lines,
    billCreate,
    approvalRequest,
    approve: (changes: Row = {}) => {
      const approval = approvals.get("approval-1");
      if (!approval) throw new Error("Request the controlled approval first.");
      Object.assign(approval, { status: "APPROVED", decision: "APPROVED" }, changes);
    },
    requestApproval: (proofIds = ["evidence-1", "evidence-2"], settlementRevisionId = proposalId) =>
      service.requestApproval(
        "closure-1",
        {
          approvalType: "PRICING_OVERRIDE",
          clauseSnapshotId: "clause-1",
          deltaItemId: "item-1",
          evidenceIds: proofIds,
          idempotencyKey: "request-1",
          manualBasis: "Repair estimate",
          manualUnitPriceCents: "200",
          requestReason: "Manual contract clause",
          settlementRevisionId
        },
        {
          id: "actor-1",
          menus: [],
          name: "Fixture operator",
          username: "fixture-operator",
          roles: ["OP"],
          permissions: ["business_exception:request"]
        },
        {}
      ),
    nextProposal: () => {
      proposalId = "proposal-2";
    },
    price: (proofIds = ["evidence-1", "evidence-2"], lineChanges: Row = {}) =>
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
              exceptionApprovalId: options.manual ? "approval-1" : null,
              ...(options.manual
                ? { manualBasis: "Repair estimate", manualUnitPriceCents: "200" }
                : {}),
              lineCode: "EXTERIOR",
              quantity: 1,
              responsibility: "CUSTOMER",
              ...lineChanges
            }
          ]
        },
        "actor-1"
      )
  };
}
