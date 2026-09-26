import { ConfigService } from "@nestjs/config";
import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { hashBusinessExceptionSnapshot } from "../src/asset-accounting/asset-accounting.domain";
import type { AssetAccountingRepository } from "../src/asset-accounting/asset-accounting.repository";
import { AssetAccountingService } from "../src/asset-accounting/asset-accounting.service";
import type { BusinessExceptionApprovalSnapshot } from "../src/asset-accounting/asset-accounting.types";
import type { RequestUser } from "../src/auth/auth.types";

import {
  deriveClosureFinancialState,
  mayCompleteOperations
} from "../src/subscription-closure/subscription-closure-financial.service";
import {
  assertLegalCollectionTransferReady,
  hasBlockingLegalCollectionDispute,
  SubscriptionReturnGovernanceService
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
    expect(
      mayCompleteOperations(result, { inventoryReleased: true, physicalReceiptComplete: true })
    ).toBe(true);
  });

  it("fails closed on an orphaned open receivable", () => {
    const result = deriveClosureFinancialState([
      { billId: "bill-1", disposition: "OPEN", remainingAmountCents: 500n, ownerId: null }
    ]);
    expect(
      mayCompleteOperations(result, { inventoryReleased: true, physicalReceiptComplete: true })
    ).toBe(false);
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
    expect(hasBlockingLegalCollectionDispute([{ decision: null, status: "OPEN" }])).toBe(true);
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

describe.each(["WAIVER", "WRITE_OFF"] as const)("%s approval accounting context", (type) => {
  it("consumes the financial request boundary without an external requestedAt", async () => {
    const h = financialApprovalHarness(type);
    await expect(h.request()).resolves.toMatchObject({ status: "PENDING" });
    expect(h.repository.requestClosureFinancialExceptionApproval).toHaveBeenCalledTimes(1);
    const command = h.repository.requestClosureFinancialExceptionApproval.mock.calls[0]![1];
    expect(command).not.toHaveProperty("requestedAt");
    expect(command).toMatchObject({
      requestedBy: FINANCIAL_IDS.requester,
      exceptionType: type === "WAIVER" ? "SETTLEMENT_WAIVER" : "SETTLEMENT_WRITE_OFF"
    });
  });

  it("consumes the financial decision boundary without an external decidedAt", async () => {
    const h = financialApprovalHarness(type);
    await expect(h.decide()).resolves.toMatchObject({ status: "APPROVED", version: 1 });
    expect(h.repository.decideClosureFinancialExceptionApproval).toHaveBeenCalledTimes(1);
    const command = h.repository.decideClosureFinancialExceptionApproval.mock.calls[0]![1];
    expect(command).not.toHaveProperty("decidedAt");
    expect(command).toMatchObject({ decidedBy: FINANCIAL_IDS.decider, expectedVersion: 0 });
  });

  it("requests through the real Accounting service with the exact server-derived source key", async () => {
    const h = financialApprovalHarness(type);
    await expect(h.request()).resolves.toMatchObject({ status: "PENDING" });
    expect(h.repository.requestExceptionApproval).toHaveBeenCalledTimes(1);
    expect(h.repository.requestExceptionApproval.mock.calls[0]?.[1]).toMatchObject({
      requestedBy: FINANCIAL_IDS.requester,
      source: {
        id: FINANCIAL_IDS.closure,
        key: "closure-approval-request:financial-request",
        type: "SUBSCRIPTION_CLOSURE_APPROVAL"
      }
    });
    expect(h.audit.write).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: "CREATE",
        operatorId: FINANCIAL_IDS.requester,
        after: expect.objectContaining({
          permission: "business_exception:request",
          requestContext: expect.objectContaining({
            idempotencyKey: "closure-approval-request:financial-request"
          })
        })
      }),
      h.tx
    );
  });

  it("decides a controlled PENDING input through real Accounting using its distinct decision key", async () => {
    const h = financialApprovalHarness(type);
    await expect(h.decide()).resolves.toMatchObject({ status: "APPROVED", version: 1 });
    expect(h.repository.decideExceptionApproval).toHaveBeenCalledTimes(1);
    expect(h.repository.decideExceptionApproval.mock.calls[0]?.[1]).toMatchObject({
      decidedBy: FINANCIAL_IDS.decider,
      source: {
        id: FINANCIAL_IDS.closure,
        key: "closure-approval-decision:financial-decision",
        type: "SUBSCRIPTION_CLOSURE_APPROVAL"
      }
    });
    expect(h.audit.write).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: "APPROVE",
        operatorId: FINANCIAL_IDS.decider,
        after: expect.objectContaining({
          permission: "business_exception:approve",
          requestContext: expect.objectContaining({
            idempotencyKey: "closure-approval-decision:financial-decision"
          })
        })
      }),
      h.tx
    );
  });

  it.each(["request", "decide"] as const)("retains the real %s permission guard", async (entry) => {
    const h = financialApprovalHarness(type);
    const user = financialUser(
      entry === "request" ? FINANCIAL_IDS.requester : FINANCIAL_IDS.decider,
      []
    );
    await expect(h[entry](user)).rejects.toMatchObject({
      response: { code: "ASSET_ACCOUNTING_PERMISSION_REQUIRED" }
    });
    expect(h.repository.requestExceptionApproval).not.toHaveBeenCalled();
    expect(h.repository.decideExceptionApproval).not.toHaveBeenCalled();
    expect(h.audit.write).not.toHaveBeenCalled();
  });

  it("retains the real independent-decider guard", async () => {
    const h = financialApprovalHarness(type);
    await expect(
      h.decide(financialUser(FINANCIAL_IDS.requester, ["business_exception:approve"]))
    ).rejects.toMatchObject({ response: { code: "ASSET_ACCOUNTING_SELF_APPROVAL_FORBIDDEN" } });
    expect(h.repository.decideExceptionApproval).not.toHaveBeenCalled();
    expect(h.audit.write).not.toHaveBeenCalled();
  });
});

describe.each(["WAIVER", "WRITE_OFF"] as const)("%s financial evidence membership", (type) => {
  describe.each(["request", "decide"] as const)("%s entry", (entry) => {
    it.each([
      "missing B",
      "foreign link B",
      "foreign proof B",
      "missing P",
      "wrong proof directory P",
      "foreign proof P",
      "unmasked missing B"
    ] as const)(
      "rejects %s using actual where-filtered rows without any writes",
      async (variant) => {
        const links = multiFinancialEvidence();
        const files = [financialProofRow()];
        const evidenceIds = variant.endsWith(" P")
          ? [FINANCIAL_IDS.evidenceA, FINANCIAL_IDS.proof]
          : [FINANCIAL_IDS.evidenceA, FINANCIAL_IDS.evidenceB, FINANCIAL_IDS.proof];
        if (variant === "foreign link B") {
          links.push({
            closureCaseId: FINANCIAL_IDS.foreignClosure,
            evidenceId: FINANCIAL_IDS.evidenceB,
            evidencePurpose: "CHECKLIST_PROOF"
          });
        }
        if (variant === "foreign proof B") {
          files.push({
            id: FINANCIAL_IDS.evidenceB,
            objectKey: `subscription-closure/${FINANCIAL_IDS.foreignClosure}/financial-proof/b.png`
          });
        }
        if (variant === "missing P") files.splice(0);
        if (variant === "wrong proof directory P")
          files[0]!.objectKey = `subscription-closure/${FINANCIAL_IDS.closure}/evidence-package/proof.png`;
        if (variant === "foreign proof P")
          files[0]!.objectKey = `subscription-closure/${FINANCIAL_IDS.foreignClosure}/financial-proof/proof.png`;
        if (variant === "unmasked missing B") links.splice(1, 1);
        const h = financialApprovalHarness(type, { links, files, evidenceIds });
        const before = structuredClone(h.bill);
        await expect(h[entry]()).rejects.toMatchObject({
          response: { code: "CLOSURE_FINANCIAL_APPROVAL_AUTHORITY_MISMATCH" }
        });
        expect(h.repository.requestExceptionApproval).not.toHaveBeenCalled();
        expect(h.repository.decideExceptionApproval).not.toHaveBeenCalled();
        expect(h.audit.write).not.toHaveBeenCalled();
        expect(h.bill).toEqual(before);
      }
    );

    it.each(["duplicate IDs", "link only", "proof only", "complete union"] as const)(
      "preserves %s without requiring each ID in both sources",
      async (variant) => {
        const links = multiFinancialEvidence();
        const evidenceIds =
          variant === "link only"
            ? [FINANCIAL_IDS.evidenceA]
            : variant === "proof only"
              ? [FINANCIAL_IDS.proof, FINANCIAL_IDS.proof]
              : variant === "complete union"
                ? [FINANCIAL_IDS.evidenceA, FINANCIAL_IDS.evidenceB, FINANCIAL_IDS.proof]
                : [FINANCIAL_IDS.proof, FINANCIAL_IDS.evidenceA, FINANCIAL_IDS.evidenceA];
        if (variant === "complete union") {
          links.push({
            closureCaseId: FINANCIAL_IDS.closure,
            evidenceId: FINANCIAL_IDS.evidenceB,
            evidencePurpose: "CHECKLIST_PROOF"
          });
        }
        const h = financialApprovalHarness(type, { links, evidenceIds });
        expect(await h[entry]()).toMatchObject({
          subjectSnapshot: { evidenceIds: [...new Set(evidenceIds)].sort() }
        });
        expect(h.audit.write).toHaveBeenCalledTimes(1);
      }
    );

    it.each([
      ["empty evidence", "CLOSURE_APPROVAL_EVIDENCE_REQUIRED"],
      ["missing bill input", "CLOSURE_FINANCIAL_APPROVAL_INPUT_INVALID"],
      ["missing bill row", "CLOSURE_FINANCIAL_APPROVAL_AUTHORITY_MISMATCH"],
      ["unpublished settlement", "CLOSURE_FINANCIAL_APPROVAL_INPUT_INVALID"],
      ["retired case", "CLOSURE_APPROVAL_STALE"],
      ["old revision", "CLOSURE_APPROVAL_STALE"],
      ["foreign settlement", "CLOSURE_APPROVAL_STALE"],
      ["foreign bill", "CLOSURE_FINANCIAL_APPROVAL_AUTHORITY_MISMATCH"],
      ["zero balance", "CLOSURE_FINANCIAL_APPROVAL_AUTHORITY_MISMATCH"]
    ] as const)("retains the first guard for %s", async (variant, code) => {
      const h = financialApprovalHarness(type, {
        evidenceIds: variant === "empty evidence" ? [] : undefined,
        omitBill: variant === "missing bill input"
      });
      if (variant === "missing bill row") h.tx.receivableBill.findUnique.mockResolvedValue(null);
      if (variant === "unpublished settlement") h.settlement.stage = "PROPOSED";
      if (variant === "retired case") h.closureCase.retiredAt = new Date();
      if (variant === "old revision")
        h.closureCase.currentSettlementRevisionId = FINANCIAL_IDS.foreignClosure;
      if (variant === "foreign settlement")
        h.settlement.closureCaseId = FINANCIAL_IDS.foreignClosure;
      if (variant === "foreign bill") h.bill.orderId = FINANCIAL_IDS.foreignClosure;
      if (variant === "zero balance") h.bill.remainingAmount = 0n;
      await expect(h[entry]()).rejects.toMatchObject({ response: { code } });
      expect(h.repository.requestExceptionApproval).not.toHaveBeenCalled();
      expect(h.repository.decideExceptionApproval).not.toHaveBeenCalled();
      expect(h.audit.write).not.toHaveBeenCalled();
    });
  });
});

const FINANCIAL_IDS = {
  closure: "00000000-0000-4000-8000-000000000101",
  order: "00000000-0000-4000-8000-000000000102",
  settlement: "00000000-0000-4000-8000-000000000103",
  bill: "00000000-0000-4000-8000-000000000104",
  proof: "00000000-0000-4000-8000-000000000105",
  approval: "00000000-0000-4000-8000-000000000106",
  requester: "00000000-0000-4000-8000-000000000107",
  decider: "00000000-0000-4000-8000-000000000108",
  evidenceA: "00000000-0000-4000-8000-000000000109",
  evidenceB: "00000000-0000-4000-8000-000000000110",
  foreignClosure: "00000000-0000-4000-8000-000000000111"
};

function financialUser(id: string, permissions: string[]): RequestUser {
  return { id, permissions, menus: [], name: "Financial fixture", username: id, roles: ["OP"] };
}

type FinancialEvidenceLink = {
  closureCaseId: string;
  evidenceId: string | null;
  evidencePurpose: string;
};

function multiFinancialEvidence(): FinancialEvidenceLink[] {
  return [
    {
      closureCaseId: FINANCIAL_IDS.closure,
      evidenceId: FINANCIAL_IDS.evidenceA,
      evidencePurpose: "CHECKLIST_PROOF"
    },
    {
      closureCaseId: FINANCIAL_IDS.closure,
      evidenceId: FINANCIAL_IDS.evidenceA,
      evidencePurpose: "DAMAGE_PROOF"
    },
    { closureCaseId: FINANCIAL_IDS.closure, evidenceId: null, evidencePurpose: "UNRELATED" }
  ];
}

function financialProofRow() {
  return {
    id: FINANCIAL_IDS.proof,
    objectKey: `subscription-closure/${FINANCIAL_IDS.closure}/financial-proof/proof.png`
  };
}

function financialApprovalHarness(
  approvalType: "WAIVER" | "WRITE_OFF",
  options: {
    links?: FinancialEvidenceLink[];
    files?: Array<{ id: string; objectKey: string }>;
    evidenceIds?: string[];
    omitBill?: boolean;
  } = {}
) {
  const subjectField = `${approvalType === "WAIVER" ? "settlementWaiver" : "settlementWriteOff"}:${FINANCIAL_IDS.bill}`;
  const subjectSnapshot = {
    approvalType,
    amountCents: "100",
    billId: options.omitBill ? null : FINANCIAL_IDS.bill,
    clauseSnapshotId: null,
    closureCaseId: FINANCIAL_IDS.closure,
    deltaItemId: null,
    evidenceIds: [...new Set(options.evidenceIds ?? [FINANCIAL_IDS.proof])].sort(),
    manualBasis: null,
    manualUnitPriceCents: null,
    settlementResultHash: "financial-result-hash",
    settlementRevisionId: FINANCIAL_IDS.settlement
  };
  // A controlled PENDING row lets the decision RED run independently of the
  // broken request call. Only the PG test proves actual approval persistence.
  let approval: BusinessExceptionApprovalSnapshot = {
    approvalNo: "BEA-fixture",
    id: FINANCIAL_IDS.approval,
    exceptionType: approvalType === "WAIVER" ? "SETTLEMENT_WAIVER" : "SETTLEMENT_WRITE_OFF",
    subjectType: "SETTLEMENT_CASE",
    subjectId: FINANCIAL_IDS.closure,
    subjectField,
    subjectSnapshot,
    subjectSnapshotHash: hashBusinessExceptionSnapshot(subjectSnapshot),
    requestReason: "Financial fixture",
    requestEvidenceSnapshot: { evidenceIds: subjectSnapshot.evidenceIds },
    requestedBy: FINANCIAL_IDS.requester,
    requestedAt: new Date("2026-09-26T00:00:00.000Z"),
    requestSourceType: "SUBSCRIPTION_CLOSURE_APPROVAL",
    requestSourceId: FINANCIAL_IDS.closure,
    requestSourceKey: "closure-approval-request:financial-request",
    status: "PENDING",
    decision: null,
    version: 0
  };
  const closureCase = {
    id: FINANCIAL_IDS.closure,
    orderId: FINANCIAL_IDS.order,
    retiredAt: null as Date | null,
    currentSettlementRevisionId: FINANCIAL_IDS.settlement
  };
  const settlement = {
    id: FINANCIAL_IDS.settlement,
    closureCaseId: FINANCIAL_IDS.closure,
    resultHash: "financial-result-hash",
    stage: "FINALIZED"
  };
  const bill = { id: FINANCIAL_IDS.bill, orderId: FINANCIAL_IDS.order, remainingAmount: 100n };
  const files = options.files ?? [financialProofRow()];
  const links = options.links ?? [];
  const matchingLinks = ({
    where
  }: {
    where: { closureCaseId: string; evidenceId: { in: string[] } };
  }) =>
    links.filter(
      (row) =>
        row.closureCaseId === where.closureCaseId &&
        row.evidenceId !== null &&
        where.evidenceId.in.includes(row.evidenceId)
    );
  const matchingFiles = ({
    where
  }: {
    where: { id: { in: string[] }; objectKey: { startsWith: string } };
  }) =>
    files.filter(
      (row) => where.id.in.includes(row.id) && row.objectKey.startsWith(where.objectKey.startsWith)
    );
  const tx = {
    $queryRaw: vi.fn(async () => []),
    subscriptionClosureCase: { findUnique: vi.fn(async () => closureCase) },
    subscriptionClosureSettlementRevision: { findUnique: vi.fn(async () => settlement) },
    receivableBill: { findUnique: vi.fn(async (): Promise<typeof bill | null> => bill) },
    vehicleReturnEvidenceLink: {
      count: vi.fn(
        async (query: Parameters<typeof matchingLinks>[0]) => matchingLinks(query).length
      ),
      findMany: vi.fn(async (query: Parameters<typeof matchingLinks>[0]) =>
        matchingLinks(query).map(({ evidenceId }) => ({ evidenceId }))
      )
    },
    fileObject: {
      count: vi.fn(
        async (query: Parameters<typeof matchingFiles>[0]) => matchingFiles(query).length
      ),
      findMany: vi.fn(async (query: Parameters<typeof matchingFiles>[0]) =>
        matchingFiles(query).map(({ id }) => ({ id }))
      )
    },
    businessExceptionApproval: { findUnique: vi.fn(async () => approval) }
  };
  // Only persistence and audit IO are doubled; both governance and Accounting
  // services execute their real guards and authority callback. This does not
  // model repository locking, snapshot/version enforcement or PG rollback.
  const repository = {
    lockBusinessExceptionSourceAndSubject: vi.fn(async () => undefined),
    requestExceptionApproval: vi.fn(
      async (
        _tx: Prisma.TransactionClient,
        command: Parameters<AssetAccountingRepository["requestExceptionApproval"]>[1]
      ) => {
        approval = {
          ...approval,
          subjectSnapshot: command.authoritySnapshot,
          subjectSnapshotHash: hashBusinessExceptionSnapshot(command.authoritySnapshot),
          requestedBy: command.requestedBy
        };
        return { outcome: approval, wrote: true };
      }
    ),
    decideExceptionApproval: vi.fn(
      async (
        _tx: Prisma.TransactionClient,
        command: Parameters<AssetAccountingRepository["decideExceptionApproval"]>[1]
      ) => {
        approval = {
          ...approval,
          status: command.decision,
          decision: command.decision,
          decidedBy: command.decidedBy,
          decidedAt: command.decidedAt,
          version: approval.version + 1
        };
        return { outcome: approval, wrote: true };
      }
    )
  };
  // This harness proves the actual governance/service consumption boundary.
  // Server-time admission and receipt replay are exercised with the real
  // repository in asset-accounting.repository.spec.ts and by the parent PG owner.
  const financialRepository = {
    ...repository,
    requestClosureFinancialExceptionApproval: vi.fn(
      async (
        tx: Prisma.TransactionClient,
        command: Omit<
          Parameters<AssetAccountingRepository["requestExceptionApproval"]>[1],
          "requestedAt"
        >
      ) =>
        repository.requestExceptionApproval(tx, {
          ...command,
          requestedAt: new Date("2026-09-26T00:00:00.000Z")
        })
    ),
    decideClosureFinancialExceptionApproval: vi.fn(
      async (
        tx: Prisma.TransactionClient,
        command: Omit<
          Parameters<AssetAccountingRepository["decideExceptionApproval"]>[1],
          "decidedAt"
        >
      ) =>
        repository.decideExceptionApproval(tx, {
          ...command,
          decidedAt: new Date("2026-09-26T00:00:01.000Z")
        })
    )
  };
  const audit = { write: vi.fn(async () => undefined) };
  const prisma = { $transaction: async <T>(work: (client: typeof tx) => Promise<T>) => work(tx) };
  const accounting = new AssetAccountingService(
    prisma as never,
    financialRepository as never,
    audit as never
  );
  const governance = new SubscriptionReturnGovernanceService(
    prisma as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    accounting,
    new ConfigService({ SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED: "true" })
  );
  return {
    audit,
    repository: financialRepository,
    tx,
    bill,
    closureCase,
    settlement,
    request: (user = financialUser(FINANCIAL_IDS.requester, ["business_exception:request"])) =>
      governance.requestApproval(
        FINANCIAL_IDS.closure,
        {
          approvalType,
          billId: options.omitBill ? undefined : FINANCIAL_IDS.bill,
          evidenceIds: options.evidenceIds ?? [FINANCIAL_IDS.proof],
          settlementRevisionId: FINANCIAL_IDS.settlement,
          idempotencyKey: "financial-request",
          requestReason: "Financial fixture"
        },
        user,
        {}
      ),
    decide: (user = financialUser(FINANCIAL_IDS.decider, ["business_exception:approve"])) =>
      governance.decideApproval(
        FINANCIAL_IDS.closure,
        FINANCIAL_IDS.approval,
        {
          decision: "APPROVED",
          decisionComment: "Independent review",
          expectedVersion: 0,
          idempotencyKey: "financial-decision"
        },
        user,
        {}
      )
  };
}
