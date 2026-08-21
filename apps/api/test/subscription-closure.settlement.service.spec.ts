import { ConflictException, BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE,
  SubscriptionClosureService
} from "../src/subscription-closure/subscription-closure.service";
import type { ResolvedSubscriptionClosureSettlement } from "../src/subscription-closure/subscription-closure.settlement-resolver";

const IDS = {
  actor: "30000000-0000-4000-8000-000000000001",
  approvalWaiver: "30000000-0000-4000-8000-000000000002",
  approvalWriteOff: "30000000-0000-4000-8000-000000000003",
  case: "30000000-0000-4000-8000-000000000004",
  contract: "30000000-0000-4000-8000-000000000005",
  customer: "30000000-0000-4000-8000-000000000006",
  ledger: "30000000-0000-4000-8000-000000000007",
  order: "30000000-0000-4000-8000-000000000008",
  settlement: "30000000-0000-4000-8000-000000000009",
  vehicle: "30000000-0000-4000-8000-000000000010"
} as const;

describe("SubscriptionClosureService settlement", () => {
  it("rejects client-provided totals and hashes before opening a transaction", async () => {
    const harness = settlementHarness();

    await expectCode(
      harness.service.proposeManagedSettlement({
        ...settlementInput("proposal-client-facts"),
        costTotalCents: "1",
        inputSnapshotHash: "a".repeat(64)
      } as never),
      BadRequestException,
      SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE.SETTLEMENT_CLIENT_FACTS_FORBIDDEN
    );

    expect(harness.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("owns all settlement and approval sources before one authority pass and appends only server facts", async () => {
    const harness = settlementHarness();

    const outcome = await harness.service.proposeManagedSettlement(
      settlementInput("proposal-mixed-resolution")
    );

    expect(harness.timeline).toEqual([
      "source:proposal-mixed-resolution",
      "source:proposal-mixed-resolution:waiver-current",
      "source:proposal-mixed-resolution:write-off-current",
      "authority",
      "approval:waiver-check",
      "approval:write-off-check",
      "append:settlement-proposed"
    ]);
    expect(outcome).toMatchObject({ id: IDS.settlement, stage: "PROPOSED" });
    expect(harness.repository.appendPreparedSettlementRevisionInTransaction).toHaveBeenCalledWith(
      harness.tx,
      harness.session,
      expect.objectContaining({
        amountDueCents: 0n,
        costTotalCents: 500n,
        waiverApprovalId: IDS.approvalWaiver,
        writeOffApprovalId: IDS.approvalWriteOff
      }),
      expect.anything(),
      expect.anything(),
      expect.arrayContaining([
        { id: IDS.ledger, mode: "UPDATE", table: "vehicle_cost_ledger_entry" }
      ]),
      expect.any(Function),
      "settlement-proposed"
    );
    expect(
      harness.repository.appendPreparedSettlementRevisionInTransaction.mock.calls[0]![2]
    ).not.toHaveProperty("inputSnapshotHash");
    expect(harness.repository.prepareAuthorityInTransaction).toHaveBeenCalledTimes(1);
  });

  it("rejects a resolver snapshot that changes after the coordinated authority lock", async () => {
    const harness = settlementHarness();
    harness.resolve
      .mockResolvedValueOnce(resolution())
      .mockResolvedValueOnce(resolution({ inputSnapshotHash: "b".repeat(64) }));

    await expectCode(
      harness.service.proposeManagedSettlement(settlementInput("proposal-drift")),
      ConflictException,
      SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE.SETTLEMENT_FACT_DRIFT
    );

    expect(harness.repository.appendPreparedSettlementRevisionInTransaction).not.toHaveBeenCalled();
  });

  it("finalizes by appending a successor only when the proposed server snapshot is still current", async () => {
    const harness = settlementHarness();
    harness.findClosureCase.mockResolvedValue(
      closureCase({
        currentSettlementRevision: currentSettlement("PROPOSED"),
        currentSettlementRevisionId: IDS.settlement,
        version: 5
      })
    );

    await harness.service.finalizeManagedSettlement(settlementInput("finalize-current"));

    expect(harness.repository.appendPreparedSettlementRevisionInTransaction).toHaveBeenCalledWith(
      harness.tx,
      harness.session,
      expect.objectContaining({
        expectedCurrentRevisionId: IDS.settlement,
        expectedVersion: 5,
        finalizedAt: new Date("2026-08-21T12:00:00.000Z"),
        finalizedBy: IDS.actor,
        stage: "FINALIZED"
      }),
      expect.anything(),
      expect.anything(),
      expect.any(Array),
      expect.any(Function),
      "settlement-finalized"
    );
  });

  it("refuses SETTLED while any receivable or deposit obligation lacks durable resolution", async () => {
    const harness = settlementHarness();
    harness.findClosureCase.mockResolvedValue(
      closureCase({
        currentSettlementRevision: currentSettlement("FINALIZED"),
        currentSettlementRevisionId: IDS.settlement,
        version: 5
      })
    );
    harness.resolve.mockResolvedValue(
      resolution({ amountDueCents: 100n, depositFinal: false, obligationsResolved: false })
    );

    await expectCode(
      harness.service.settleManagedSettlement(settlementInput("settle-partial")),
      ConflictException,
      SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE.SETTLEMENT_NOT_RESOLVED
    );

    expect(harness.repository.prepareSourceInTransaction).not.toHaveBeenCalled();
    expect(harness.repository.appendPreparedSettlementRevisionInTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["NORMAL_COMPLETION", "COMPLETE", "COMPLETED"],
    ["EARLY_TERMINATION", "TERMINATE", "TERMINATED"],
    ["NORMAL_COMPLETION", "TERMINATE", "TERMINATED"]
  ] as const)(
    "settles %s/%s as %s without changing vehicle availability",
    async (closureType, finalDisposition, terminalStatus) => {
      const harness = settlementHarness();
      harness.findClosureCase.mockResolvedValue(
        closureCase({
          closureType,
          currentSettlementRevision: currentSettlement("FINALIZED"),
          currentSettlementRevisionId: IDS.settlement,
          finalDisposition,
          version: 5
        })
      );

      await harness.service.settleManagedSettlement(settlementInput("settle-complete"));

      expect(harness.repository.appendPreparedSettlementRevisionInTransaction).toHaveBeenCalledWith(
        harness.tx,
        harness.session,
        expect.objectContaining({ stage: "SETTLED" }),
        expect.anything(),
        expect.anything(),
        expect.any(Array),
        expect.any(Function),
        "settlement-settled"
      );
      expect(harness.tx.subscriptionOrder.update).toHaveBeenCalledWith({
        data: { orderStatus: terminalStatus, updatedBy: IDS.actor },
        where: { id: IDS.order }
      });
      expect(harness.tx.contract.update).toHaveBeenCalledWith({
        data: { status: terminalStatus, updatedBy: IDS.actor },
        where: { id: IDS.contract }
      });
      expect(harness.repository.appendPreparedEventInTransaction).toHaveBeenCalledWith(
        harness.tx,
        harness.session,
        expect.objectContaining({ afterStatus: terminalStatus, eventType: "STATUS_TRANSITIONED" }),
        expect.anything(),
        expect.anything(),
        expect.any(Function),
        "closure-complete"
      );
      expect(harness.tx.vehicle.update).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["order", "COMPLETED"],
    ["contract", "TERMINATED"]
  ] as const)(
    "refuses to overwrite a %s that is no longer in its pre-settlement state",
    async (authority, status) => {
      const harness = settlementHarness();
      harness.findClosureCase.mockResolvedValue(
        closureCase({
          currentSettlementRevision: currentSettlement("FINALIZED"),
          currentSettlementRevisionId: IDS.settlement,
          version: 5
        })
      );
      if (authority === "order") {
        harness.findOrder.mockResolvedValue({ id: IDS.order, orderStatus: status });
      } else {
        harness.findContract.mockResolvedValue({ id: IDS.contract, status });
      }

      await expectCode(
        harness.service.settleManagedSettlement(settlementInput(`settle-stale-${authority}`)),
        ConflictException,
        SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE.SETTLEMENT_STATUS_CONFLICT
      );

      expect(harness.tx.subscriptionOrder.update).not.toHaveBeenCalled();
      expect(harness.tx.contract.update).not.toHaveBeenCalled();
    }
  );

  it("commits stale approval expiry and rejects outside the transaction", async () => {
    const harness = settlementHarness();
    harness.assetAccounting.requirePreparedApprovedExceptionInTransaction
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expectCode(
      harness.service.proposeManagedSettlement(settlementInput("proposal-stale-approval")),
      ConflictException,
      SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE.SETTLEMENT_APPROVAL_STALE
    );

    expect(harness.prisma.$transaction).toHaveResolved();
    expect(harness.repository.appendPreparedSettlementRevisionInTransaction).not.toHaveBeenCalled();
  });

  it("returns the immutable receipt outcome for an exact proposal replay", async () => {
    const harness = settlementHarness();
    harness.findReceipt.mockResolvedValue({
      commandType: "CREATE_SETTLEMENT_REVISION",
      outcomeSnapshot: { id: IDS.settlement, revisionNumber: 1, stage: "PROPOSED" },
      payloadSnapshot: {
        actorId: IDS.actor,
        closureCaseId: IDS.case,
        managedOccurredAt: "2026-08-21T12:00:00.000Z",
        stage: "PROPOSED",
        waiverApprovalId: IDS.approvalWaiver,
        writeOffApprovalId: IDS.approvalWriteOff
      }
    });

    const replay = await harness.service.proposeManagedSettlement(
      settlementInput("proposal-replay")
    );

    expect(replay).toEqual({ id: IDS.settlement, revisionNumber: 1, stage: "PROPOSED" });
    expect(harness.resolve).not.toHaveBeenCalled();
    expect(harness.repository.prepareSourceInTransaction).not.toHaveBeenCalled();

    await expectCode(
      harness.service.proposeManagedSettlement({
        ...settlementInput("proposal-replay"),
        occurredAt: new Date("2026-08-21T12:00:01.000Z")
      }),
      ConflictException,
      "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT"
    );
  });

  it("rechecks exact replay after source serialization and before authority locking", async () => {
    const harness = settlementHarness();
    harness.findReceipt.mockResolvedValueOnce(null).mockResolvedValueOnce({
      commandType: "CREATE_SETTLEMENT_REVISION",
      outcomeSnapshot: { id: IDS.settlement, revisionNumber: 1, stage: "PROPOSED" },
      payloadSnapshot: {
        actorId: IDS.actor,
        closureCaseId: IDS.case,
        managedOccurredAt: "2026-08-21T12:00:00.000Z",
        stage: "PROPOSED",
        waiverApprovalId: IDS.approvalWaiver,
        writeOffApprovalId: IDS.approvalWriteOff
      }
    });

    const replay = await harness.service.proposeManagedSettlement(
      settlementInput("proposal-source-serialized-replay")
    );

    expect(replay).toEqual({ id: IDS.settlement, revisionNumber: 1, stage: "PROPOSED" });
    expect(harness.findReceipt).toHaveBeenCalledTimes(2);
    expect(harness.repository.prepareSourceInTransaction).toHaveBeenCalled();
    expect(harness.repository.prepareAuthorityInTransaction).not.toHaveBeenCalled();
    expect(harness.repository.appendPreparedSettlementRevisionInTransaction).not.toHaveBeenCalled();
  });
});

function settlementHarness() {
  const timeline: string[] = [];
  const session = Object.freeze({ kind: "settlement-session" });
  const proofs = new Map(
    [
      "settlement-proposed",
      "settlement-finalized",
      "settlement-settled",
      "closure-complete",
      "waiver-check",
      "write-off-check"
    ].map((key) => [key, Object.freeze({ key })])
  );
  const findClosureCase = vi.fn(async () => closureCase());
  const findReceipt = vi.fn(async () => null as Record<string, unknown> | null);
  const findContract = vi.fn(async () => ({ id: IDS.contract, status: "ARCHIVED" }));
  const findOrder = vi.fn(async () => ({
    id: IDS.order,
    orderStatus: "RETURNED_PENDING_SETTLEMENT"
  }));
  const tx = {
    $queryRaw: vi.fn(async () => [{ now: new Date("2026-08-21T12:00:00.000Z") }]),
    businessExceptionApproval: {
      findUnique: vi.fn(async ({ where }) => ({ id: where.id, version: 1 }))
    },
    contract: {
      findUnique: findContract,
      update: vi.fn(async ({ data }) => ({ id: IDS.contract, ...data }))
    },
    subscriptionClosureCase: {
      findUnique: findClosureCase
    },
    subscriptionClosureCommandReceipt: {
      findUnique: findReceipt
    },
    subscriptionOrder: {
      findUnique: findOrder,
      update: vi.fn(async ({ data }) => ({ id: IDS.order, ...data }))
    },
    vehicle: {
      update: vi.fn()
    }
  } as unknown as Prisma.TransactionClient;
  const repository = {
    appendPreparedEventInTransaction: vi.fn(async () => ({ outcome: {}, wrote: true })),
    appendPreparedSettlementRevisionInTransaction: vi.fn(async (...args) => {
      const key = args.at(-1);
      timeline.push(`append:${key}`);
      return {
        outcome: {
          id: IDS.settlement,
          stage:
            key === "settlement-finalized"
              ? "FINALIZED"
              : key === "settlement-settled"
                ? "SETTLED"
                : "PROPOSED"
        },
        wrote: true
      };
    }),
    bindAuthorityRequirement: vi.fn((_session, requirement) => requirement),
    createAuthoritySessionInTransaction: vi.fn(() => session),
    prepareAuthorityInTransaction: vi.fn(async () => {
      timeline.push("authority");
      return proofs;
    }),
    prepareSourceInTransaction: vi.fn(async (_tx, source) => {
      timeline.push(`source:${source.key}`);
      return Object.freeze({ source });
    }),
    subscriptionClosureSettlementAuthorityRequirement: vi.fn()
  };
  const assetAccounting = {
    approvedExceptionAuthorityRequirement: vi.fn(
      (_session, _command, _context, _snapshot, key) => ({
        key,
        locks: [
          { id: IDS.case, mode: "UPDATE", table: "subscription_closure_case" },
          {
            id: key === "waiver-check" ? IDS.approvalWaiver : IDS.approvalWriteOff,
            mode: "UPDATE",
            table: "business_exception_approval"
          },
          { id: IDS.actor, mode: "SHARE", table: "user" }
        ]
      })
    ),
    attestPreparedApprovedExceptionInTransaction: vi.fn(
      async (_tx, _session, _command, _context, _snapshot, _source, _proof, key) =>
        Object.freeze({ key })
    ),
    prepareCallerOwnedTransaction: vi.fn(async (_tx, source) => {
      timeline.push(`source:${source.key}`);
      return Object.freeze({ source });
    }),
    requirePreparedApprovedExceptionInTransaction: vi.fn(async (_tx, capability) => {
      timeline.push(`approval:${capability.key}`);
      return true;
    })
  };
  const resolve = vi.fn(async () => resolution());
  const prisma = {
    $transaction: vi.fn(async (work) => work(tx))
  };
  const service = new SubscriptionClosureService(
    repository as never,
    {} as never,
    {} as never,
    { write: vi.fn(async () => undefined) } as never,
    prisma as never,
    undefined,
    assetAccounting as never,
    undefined,
    { resolveInTransaction: resolve } as never
  );
  return {
    assetAccounting,
    findClosureCase,
    findContract,
    findOrder,
    findReceipt,
    prisma,
    repository,
    resolve,
    service,
    session,
    timeline,
    tx
  };
}

function settlementInput(idempotencyKey: string) {
  return {
    actorId: IDS.actor,
    closureCaseId: IDS.case,
    idempotencyKey,
    occurredAt: new Date("2026-08-21T12:00:00.000Z"),
    waiverApprovalId: IDS.approvalWaiver,
    writeOffApprovalId: IDS.approvalWriteOff
  };
}

function closureCase(patch: Record<string, unknown> = {}) {
  return {
    closureType: "NORMAL_COMPLETION",
    contractId: IDS.contract,
    currentSettlementRevision: null,
    currentSettlementRevisionId: null,
    customerId: IDS.customer,
    finalDisposition: "COMPLETE",
    id: IDS.case,
    orderId: IDS.order,
    physicalControlMode: "VOLUNTARY_RETURN",
    status: "PENDING_SETTLEMENT",
    vehicleId: IDS.vehicle,
    version: 4,
    ...patch
  };
}

function currentSettlement(stage: "PROPOSED" | "FINALIZED") {
  return {
    finalizedAt: stage === "FINALIZED" ? new Date("2026-08-21T11:00:00.000Z") : null,
    finalizedBy: stage === "FINALIZED" ? IDS.actor : null,
    id: IDS.settlement,
    inputSnapshotHash: "a".repeat(64),
    resultHash: "c".repeat(64),
    stage
  };
}

function resolution(
  patch: Partial<ResolvedSubscriptionClosureSettlement> = {}
): ResolvedSubscriptionClosureSettlement {
  return {
    amountDueCents: 0n,
    amountRefundableCents: 0n,
    authorityLocks: [
      { id: IDS.case, mode: "UPDATE", table: "subscription_closure_case" },
      { id: IDS.order, mode: "UPDATE", table: "subscription_order" },
      { id: IDS.ledger, mode: "UPDATE", table: "vehicle_cost_ledger_entry" }
    ],
    billInputSnapshot: { bills: [] },
    closureCaseId: IDS.case,
    contractId: IDS.contract,
    costTotalCents: 500n,
    customerId: IDS.customer,
    depositAppliedCents: 150n,
    depositFinal: true,
    depositInputSnapshot: { ledgers: [] },
    depositRefundCents: 0n,
    inputSnapshotHash: "a".repeat(64),
    ledgerInputSnapshot: { entries: [] },
    obligationsResolved: true,
    orderId: IDS.order,
    paidTotalCents: 600n,
    receivableTotalCents: 1_000n,
    responsibilitySnapshot: { damages: [], mileageReadings: [] },
    resultHash: "c".repeat(64),
    resultSnapshot: { obligationsResolved: true },
    vehicleId: IDS.vehicle,
    waiverTotalCents: 200n,
    writeOffTotalCents: 50n,
    ...patch
  };
}

async function expectCode(
  promise: Promise<unknown>,
  type: typeof ConflictException | typeof BadRequestException,
  code: string
) {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(type);
    expect((error as ConflictException).getResponse()).toMatchObject({ code });
  }
}
