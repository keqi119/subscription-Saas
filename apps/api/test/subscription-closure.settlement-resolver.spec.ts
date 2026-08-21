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
  ledgerCost: "20000000-0000-4000-8000-000000000007",
  ledgerResponsibility: "20000000-0000-4000-8000-000000000008",
  ledgerWaiver: "20000000-0000-4000-8000-000000000009",
  ledgerWriteOff: "20000000-0000-4000-8000-000000000010",
  mileage: "20000000-0000-4000-8000-000000000011",
  order: "20000000-0000-4000-8000-000000000012",
  payment: "20000000-0000-4000-8000-000000000013",
  vehicle: "20000000-0000-4000-8000-000000000014",
  writeOff: "20000000-0000-4000-8000-000000000015"
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
      paidTotalCents: 600n,
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
      bills: [expect.objectContaining({ id: IDS.bill, remainingAmountCents: "400" })],
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
});

function settlementTransaction(
  options: { depositBalanceAfter?: bigint; waiverAmount?: bigint } = {}
) {
  const occurredAt = new Date("2026-08-21T10:00:00.000Z");
  return {
    depositLedger: {
      findMany: async () => [
        {
          amount: 150n,
          balanceAfter: options.depositBalanceAfter ?? 0n,
          billId: IDS.bill,
          createdAt: occurredAt,
          customerId: IDS.customer,
          deletedAt: null,
          id: IDS.deposit,
          occurredAt,
          orderId: IDS.order,
          paymentId: IDS.payment,
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
          billType: "OTHER",
          cancelledAt: null,
          createdAt: occurredAt,
          customerId: IDS.customer,
          deletedAt: null,
          dueDate: occurredAt,
          id: IDS.bill,
          orderId: IDS.order,
          paidAmount: 600n,
          remainingAmount: 400n
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
        depositAmount: 150n,
        depositStatus: "CONFIRMED",
        finalDepositAmount: 150n,
        id: IDS.order,
        vehicleId: IDS.vehicle
      })
    },
    vehicleCostLedgerEntry: {
      findMany: async () => [
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

  function ledger(id: string, actionType: string, amountCents: bigint) {
    return {
      actionType,
      amountCents,
      confirmedAt: occurredAt,
      costCategory: "DAMAGE",
      createdAt: occurredAt,
      entryKind: "ORIGINAL",
      id,
      orderId: IDS.order,
      responsibilitySnapshot: { basis: "inspection" },
      responsiblePartyId: IDS.customer,
      responsiblePartyType: "CUSTOMER",
      reversalOfEntryId: null,
      vehicleId: IDS.vehicle
    };
  }
}
