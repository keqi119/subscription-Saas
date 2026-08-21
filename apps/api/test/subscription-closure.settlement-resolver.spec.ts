import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  SUBSCRIPTION_CLOSURE_SETTLEMENT_ERROR_CODE,
  SubscriptionClosureSettlementResolver
} from "../src/subscription-closure/subscription-closure.settlement-resolver";

const IDS = {
  bill: "20000000-0000-4000-8000-000000000001",
  closureCase: "20000000-0000-4000-8000-000000000002",
  contract: "20000000-0000-4000-8000-000000000003",
  customer: "20000000-0000-4000-8000-000000000004",
  damage: "20000000-0000-4000-8000-000000000005",
  deposit: "20000000-0000-4000-8000-000000000006",
  depositCollect: "20000000-0000-4000-8000-000000000016",
  ledgerCost: "20000000-0000-4000-8000-000000000007",
  ledgerResponsibility: "20000000-0000-4000-8000-000000000008",
  ledgerWaiver: "20000000-0000-4000-8000-000000000009",
  ledgerWriteOff: "20000000-0000-4000-8000-000000000010",
  mileage: "20000000-0000-4000-8000-000000000011",
  order: "20000000-0000-4000-8000-000000000012",
  payment: "20000000-0000-4000-8000-000000000013",
  vehicle: "20000000-0000-4000-8000-000000000014",
  writeOff: "20000000-0000-4000-8000-000000000015",
  ledgerPlatformWaiver: "20000000-0000-4000-8000-000000000017",
  ledgerCustomerWaiverReversal: "20000000-0000-4000-8000-000000000018"
} as const;

describe("SubscriptionClosureSettlementResolver", () => {
  it("derives every amount and immutable input snapshot from canonical server facts", async () => {
    const tx = settlementTransaction();
    const resolver = new SubscriptionClosureSettlementResolver();

    const resolved = await resolver.resolveInTransaction(tx, IDS.closureCase);

    expect(resolved).toMatchObject({
      amountDueCents: 0n,
      amountRefundableCents: 0n,
      costTotalCents: 500n,
      depositAppliedCents: 150n,
      depositFinal: true,
      depositRefundCents: 0n,
      obligationsResolved: true,
      paidTotalCents: 750n,
      receivableTotalCents: 1_000n,
      waiverTotalCents: 200n,
      writeOffTotalCents: 50n
    });
    expect(resolved.ledgerInputSnapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: IDS.ledgerCost }),
        expect.objectContaining({ id: IDS.ledgerWaiver })
      ])
    );
    expect(resolved.billInputSnapshot).toMatchObject({
      bills: [expect.objectContaining({ id: IDS.bill, remainingAmountCents: "250" })],
      paymentAllocations: [expect.objectContaining({ id: IDS.writeOff })],
      payments: [expect.objectContaining({ id: IDS.payment })]
    });
    expect(resolved.responsibilitySnapshot).toMatchObject({
      damages: [expect.objectContaining({ id: IDS.damage })],
      mileageReadings: [expect.objectContaining({ id: IDS.mileage })]
    });
    expect(resolved.inputSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(resolved.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(resolved.authorityLocks).toEqual(
      expect.arrayContaining([
        { id: IDS.order, mode: "UPDATE", table: "subscription_order" },
        { id: IDS.ledgerCost, mode: "UPDATE", table: "vehicle_cost_ledger_entry" },
        { id: IDS.bill, mode: "UPDATE", table: "receivable_bill" },
        { id: IDS.payment, mode: "UPDATE", table: "payment_record" },
        { id: IDS.writeOff, mode: "UPDATE", table: "payment_write_off" },
        { id: IDS.deposit, mode: "UPDATE", table: "deposit_ledger" }
      ])
    );
  });

  it("does not treat partial payment or an unsettled deposit balance as durable resolution", async () => {
    const tx = settlementTransaction({
      depositBalanceAfter: 50n,
      waiverAmount: 100n
    });

    const resolved = await new SubscriptionClosureSettlementResolver().resolveInTransaction(
      tx,
      IDS.closureCase
    );

    expect(resolved).toMatchObject({
      amountDueCents: 100n,
      depositFinal: false,
      obligationsResolved: false
    });
  });

  it("rejects over-resolution instead of flooring an excessive waiver to zero due", async () => {
    try {
      await new SubscriptionClosureSettlementResolver().resolveInTransaction(
        settlementTransaction({ waiverAmount: 500n }),
        IDS.closureCase
      );
      throw new Error("Expected authoritative settlement over-resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: SUBSCRIPTION_CLOSURE_SETTLEMENT_ERROR_CODE.FACT_INCONSISTENT
      });
    }
  });

  it.each([
    ["missing DEDUCT bill linkage", { deductBillId: null }],
    ["drifted deposit running balance", { deductBalanceAfter: 1n }],
    ["bill paid amount not backed by payment plus DEDUCT", { billPaidAmount: 749n }]
  ] as const)("rejects production deposit reconciliation with %s", async (_case, options) => {
    await expectSettlementFactConflict(settlementTransaction(options));
  });

  it("does not subtract a production DEDUCT from an already reduced bill remaining amount", async () => {
    const resolved = await new SubscriptionClosureSettlementResolver().resolveInTransaction(
      settlementTransaction(),
      IDS.closureCase
    );

    expect(resolved).toMatchObject({
      amountDueCents: 0n,
      depositAppliedCents: 150n,
      paidTotalCents: 750n,
      waiverTotalCents: 200n,
      writeOffTotalCents: 50n
    });
  });

  it("only customer-authoritative waiver and write-off entries offset this order's receivables", async () => {
    const resolved = await new SubscriptionClosureSettlementResolver().resolveInTransaction(
      settlementTransaction({ mixedResponsibility: true }),
      IDS.closureCase
    );

    expect(resolved).toMatchObject({
      amountDueCents: 200n,
      obligationsResolved: false,
      waiverTotalCents: 0n,
      writeOffTotalCents: 50n
    });
  });
});

function settlementTransaction(
  options: {
    billPaidAmount?: bigint;
    deductBalanceAfter?: bigint;
    deductBillId?: string | null;
    depositBalanceAfter?: bigint;
    mixedResponsibility?: boolean;
    waiverAmount?: bigint;
  } = {}
) {
  const occurredAt = new Date("2026-08-21T10:00:00.000Z");
  const collectedDeposit = 150n + (options.depositBalanceAfter ?? 0n);
  return {
    depositLedger: {
      findMany: async () => [
        {
          amount: collectedDeposit,
          balanceAfter: collectedDeposit,
          billId: null,
          createdAt: new Date(occurredAt.getTime() - 1_000),
          customerId: IDS.customer,
          deletedAt: null,
          id: IDS.depositCollect,
          occurredAt: new Date(occurredAt.getTime() - 1_000),
          orderId: IDS.order,
          paymentId: IDS.payment,
          transactionStatus: "CONFIRMED",
          transactionType: "COLLECT"
        },
        {
          amount: 150n,
          balanceAfter: options.deductBalanceAfter ?? options.depositBalanceAfter ?? 0n,
          billId: options.deductBillId === undefined ? IDS.bill : options.deductBillId,
          createdAt: occurredAt,
          customerId: IDS.customer,
          deletedAt: null,
          id: IDS.deposit,
          occurredAt,
          orderId: IDS.order,
          paymentId: null,
          transactionStatus: "CONFIRMED",
          transactionType: "DEDUCT"
        }
      ]
    },
    paymentRecord: {
      findMany: async () => [
        {
          createdAt: occurredAt,
          customerId: IDS.customer,
          deletedAt: null,
          id: IDS.payment,
          orderId: IDS.order,
          paymentAmount: 600n,
          paymentStatus: "CONFIRMED",
          receivedAt: occurredAt
        }
      ]
    },
    paymentWriteOff: {
      findMany: async () => [
        {
          billId: IDS.bill,
          createdAt: occurredAt,
          customerId: IDS.customer,
          deletedAt: null,
          id: IDS.writeOff,
          orderId: IDS.order,
          paymentId: IDS.payment,
          writeOffAmount: 600n,
          writeOffAt: occurredAt
        }
      ]
    },
    receivableBill: {
      findMany: async () => [
        {
          amount: 1_000n,
          billNo: "BILL-1",
          billStatus: "PARTIALLY_PAID",
          billType: "DAMAGE_FEE",
          cancelledAt: null,
          createdAt: occurredAt,
          customerId: IDS.customer,
          deletedAt: null,
          dueDate: occurredAt,
          id: IDS.bill,
          orderId: IDS.order,
          paidAmount: options.billPaidAmount ?? 750n,
          remainingAmount: 1_000n - (options.billPaidAmount ?? 750n)
        }
      ]
    },
    subscriptionClosureCase: {
      findUnique: async () => ({
        closureType: "NORMAL_COMPLETION",
        contractId: IDS.contract,
        customerId: IDS.customer,
        id: IDS.closureCase,
        orderId: IDS.order,
        status: "PENDING_SETTLEMENT",
        vehicleId: IDS.vehicle,
        vehicleReturnId: IDS.damage
      })
    },
    subscriptionOrder: {
      findUnique: async () => ({
        contractId: IDS.contract,
        customerId: IDS.customer,
        deletedAt: null,
        depositAmount: collectedDeposit,
        depositStatus: "CONFIRMED",
        finalDepositAmount: collectedDeposit,
        id: IDS.order,
        vehicleId: IDS.vehicle
      })
    },
    vehicleCostLedgerEntry: {
      findMany: async () =>
        options.mixedResponsibility
          ? [
              ledger(IDS.ledgerCost, "ACTUAL_COST", 500n),
              ledger(IDS.ledgerResponsibility, "RESPONSIBILITY_CONFIRMED", 500n),
              ledger(IDS.ledgerWaiver, "WAIVER", 200n),
              ledger(IDS.ledgerCustomerWaiverReversal, "WAIVER", -200n, {
                entryKind: "REVERSAL",
                reversalOfEntryId: IDS.ledgerWaiver
              }),
              ledger(IDS.ledgerPlatformWaiver, "WAIVER", 200n, {
                customerId: null,
                responsiblePartyId: null,
                responsiblePartyType: "PLATFORM"
              }),
              ledger(IDS.ledgerWriteOff, "WRITE_OFF", 50n)
            ]
          : [
              ledger(IDS.ledgerCost, "ACTUAL_COST", 500n),
              ledger(IDS.ledgerResponsibility, "RESPONSIBILITY_CONFIRMED", 500n),
              ledger(IDS.ledgerWaiver, "WAIVER", options.waiverAmount ?? 200n),
              ledger(IDS.ledgerWriteOff, "WRITE_OFF", 50n)
            ]
    },
    vehicleMileageReading: {
      findMany: async () => [
        {
          confirmedAt: occurredAt,
          confirmedBy: IDS.customer,
          createdAt: occurredAt,
          deltaKm: 100,
          evidenceSnapshot: { source: "return" },
          id: IDS.mileage,
          mileageKm: 10_000,
          orderId: IDS.order,
          recordedAt: occurredAt,
          sourceRecordId: IDS.damage,
          sourceType: "VEHICLE_RETURN",
          status: "ACTIVE",
          vehicleId: IDS.vehicle
        }
      ]
    },
    vehicleReturnDamage: {
      findMany: async () => [
        {
          createdAt: occurredAt,
          damageLevel: "MINOR",
          damageType: "BODY",
          deletedAt: null,
          description: "scratch",
          estimatedRepairAmount: 500n,
          id: IDS.damage,
          orderId: IDS.order,
          responsibleParty: "CUSTOMER",
          returnId: IDS.damage,
          status: "CONFIRMED",
          vehicleId: IDS.vehicle
        }
      ]
    }
  } as unknown as Prisma.TransactionClient;

  function ledger(
    id: string,
    actionType: string,
    amountCents: bigint,
    overrides: Record<string, unknown> = {}
  ) {
    return {
      actionType,
      amountCents,
      confirmedAt: occurredAt,
      contractId: IDS.contract,
      costCategory: "DAMAGE",
      createdAt: occurredAt,
      customerId: IDS.customer,
      entryKind: "ORIGINAL",
      id,
      orderId: IDS.order,
      responsibilitySnapshot: { basis: "inspection" },
      responsiblePartyId: IDS.customer,
      responsiblePartyType: "CUSTOMER",
      reversalOfEntryId: null,
      vehicleId: IDS.vehicle,
      ...overrides
    };
  }
}

async function expectSettlementFactConflict(tx: Prisma.TransactionClient) {
  try {
    await new SubscriptionClosureSettlementResolver().resolveInTransaction(tx, IDS.closureCase);
    throw new Error("Expected authoritative settlement facts to be rejected");
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: SUBSCRIPTION_CLOSURE_SETTLEMENT_ERROR_CODE.FACT_INCONSISTENT
    });
  }
}
