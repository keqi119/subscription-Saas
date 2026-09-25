import { describe, expect, it, vi } from "vitest";

import { SubscriptionReturnGovernanceService } from "../src/subscription-closure/subscription-return-governance.service";

describe("governed return completion audit", () => {
  it.each(["COMPLETE", "TERMINATE"] as const)(
    "audits actual prior states once for %s and does not duplicate on replay",
    async (finalDisposition) => {
      const h = completionHarness({ finalDisposition });
      const terminal = finalDisposition === "TERMINATE" ? "TERMINATED" : "COMPLETED";

      await expect(h.complete()).resolves.toEqual({
        closureCaseId: "closure-1",
        financialStatus: "SETTLED",
        replayed: false,
        status: terminal
      });
      expect(h.auditCreate).toHaveBeenCalledExactlyOnceWith({
        data: {
          action: "UPDATE",
          afterSnapshot: {
            closureCaseId: "closure-1",
            closureStatus: terminal,
            contractId: "contract-1",
            contractStatus: terminal,
            financialStatus: "SETTLED",
            idempotencyKey: "complete-1",
            orderId: "order-1",
            orderStatus: terminal
          },
          beforeSnapshot: {
            closureCaseId: "closure-1",
            closureStatus: "PENDING_SETTLEMENT",
            contractId: "contract-1",
            contractStatus: "ARCHIVED",
            financialStatus: "DRAFT",
            orderId: "order-1",
            orderStatus: "RETURNED_PENDING_SETTLEMENT"
          },
          createdAt: h.occurredAt,
          entityId: "closure-1",
          entityType: "subscription_closure_case",
          module: "subscription_closure",
          operatorId: "operator-1"
        }
      });
      expect(h.outerAuditCreate).not.toHaveBeenCalled();
      const after = h.snapshot();
      await expect(h.complete()).resolves.toEqual({
        closureCaseId: "closure-1",
        replayed: true,
        status: terminal
      });
      expect(h.snapshot()).toEqual(after);
      expect(h.auditCreate).toHaveBeenCalledTimes(1);
    }
  );

  it("propagates an audit failure through the transaction after all status writes", async () => {
    const failure = new Error("audit persistence unavailable");
    const h = completionHarness({ auditFailure: failure });
    const before = h.snapshot();

    await expect(h.complete()).rejects.toBe(failure);
    expect(h.statusWrites).toEqual(["order", "contract", "closure"]);
    expect(h.auditCreate).toHaveBeenCalledTimes(1);
    expect(h.outerAuditCreate).not.toHaveBeenCalled();
    expect(h.snapshot()).toEqual(before);
  });

  it("does not emit a successful audit when a status update fails", async () => {
    const failure = new Error("contract write rejected");
    const h = completionHarness({ contractFailure: failure });
    const before = h.snapshot();

    await expect(h.complete()).rejects.toBe(failure);
    expect(h.auditCreate).not.toHaveBeenCalled();
    expect(h.snapshot()).toEqual(before);
  });

  it.each([
    [
      "pending response",
      { pendingResponse: true },
      "CLOSURE_OPERATIONAL_CUSTOMER_RESPONSE_REQUIRED"
    ],
    ["unowned receivable", { openReceivable: true }, "CLOSURE_OPERATIONAL_FINANCIAL_OWNER_REQUIRED"]
  ] as const)(
    "keeps the existing %s guard before writes and audit",
    async (_name, options, code) => {
      const h = completionHarness(options);
      const before = h.snapshot();

      await expect(h.complete()).rejects.toMatchObject({ response: { code } });
      expect(h.statusWrites).toEqual([]);
      expect(h.auditCreate).not.toHaveBeenCalled();
      expect(h.snapshot()).toEqual(before);
    }
  );
});

function completionHarness(
  options: {
    auditFailure?: Error;
    contractFailure?: Error;
    finalDisposition?: "COMPLETE" | "TERMINATE";
    openReceivable?: boolean;
    pendingResponse?: boolean;
  } = {}
) {
  const occurredAt = new Date("2026-09-25T01:00:00.000Z");
  let state = {
    audits: [] as unknown[],
    closure: {
      contractId: "contract-1",
      currentDeltaRevisionId: "delta-1",
      currentSettlementRevisionId: "settlement-1",
      finalDisposition: options.finalDisposition ?? "COMPLETE",
      financialStatus: "DRAFT",
      id: "closure-1",
      orderId: "order-1",
      physicalControlledAt: new Date("2026-09-24T01:00:00.000Z"),
      status: "PENDING_SETTLEMENT",
      vehicleId: "vehicle-1",
      version: 4
    },
    contract: { id: "contract-1", status: "ARCHIVED" },
    order: { id: "order-1", orderStatus: "RETURNED_PENDING_SETTLEMENT" }
  };
  let transactionState = structuredClone(state);
  const statusWrites: string[] = [];
  const auditCreate = vi.fn(async ({ data }: { data: unknown }) => {
    if (options.auditFailure) throw options.auditFailure;
    transactionState.audits.push(structuredClone(data));
    return { id: "audit-1", data };
  });
  const outerAuditCreate = vi.fn(async () => {
    throw new Error("audit escaped the caller transaction");
  });
  const tx = {
    $queryRaw: vi.fn(async () => []),
    auditLog: { create: auditCreate },
    contract: {
      findUniqueOrThrow: vi.fn(async () => structuredClone(transactionState.contract)),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        statusWrites.push("contract");
        if (options.contractFailure) throw options.contractFailure;
        Object.assign(transactionState.contract, data);
        return structuredClone(transactionState.contract);
      })
    },
    receivableBill: {
      findMany: vi.fn(async () => [
        {
          id: "bill-1",
          paidAmount: 100n,
          remainingAmount: options.openReceivable ? 50n : 0n
        }
      ])
    },
    subscriptionClosureCase: {
      findUnique: vi.fn(async () => structuredClone(transactionState.closure)),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        statusWrites.push("closure");
        const version = transactionState.closure.version + 1;
        Object.assign(transactionState.closure, data, { version });
        return structuredClone(transactionState.closure);
      })
    },
    subscriptionClosureChargeDispute: { count: vi.fn(async () => 0) },
    subscriptionClosureChargeDisputeDecision: { count: vi.fn(async () => 0) },
    subscriptionClosureCustomerResponse: {
      findUnique: vi.fn(async () => ({
        settlementHash: "settlement-hash",
        status: options.pendingResponse ? "PENDING" : "CONFIRMED"
      }))
    },
    subscriptionClosureReceivableDisposition: { findMany: vi.fn(async () => []) },
    subscriptionClosureSettlementRevision: {
      findUnique: vi.fn(async () => ({
        id: "settlement-1",
        resultHash: "settlement-hash",
        stage: "FINALIZED"
      }))
    },
    subscriptionOrder: {
      findUniqueOrThrow: vi.fn(async () => structuredClone(transactionState.order)),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        statusWrites.push("order");
        Object.assign(transactionState.order, data);
        return structuredClone(transactionState.order);
      })
    },
    vehicle: { findUnique: vi.fn(async () => ({ status: "AVAILABLE" })) },
    vehicleConditionDeltaRevision: {
      findUnique: vi.fn(async () => ({ closureCaseId: "closure-1", items: [] }))
    },
    vehicleOperationalRestriction: { count: vi.fn(async () => 0) }
  };
  // This double checks transaction membership and error propagation only;
  // the governed PostgreSQL suite owns actual rollback proof.
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => {
      transactionState = structuredClone(state);
      const result = await operation(tx);
      state = structuredClone(transactionState);
      return result;
    }),
    auditLog: { create: outerAuditCreate }
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
    auditCreate,
    complete: () =>
      service.completeOperations(
        "closure-1",
        { idempotencyKey: "complete-1", occurredAt },
        "operator-1"
      ),
    occurredAt,
    outerAuditCreate,
    snapshot: () => structuredClone(state),
    statusWrites
  };
}
