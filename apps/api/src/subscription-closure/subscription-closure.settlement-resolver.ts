import { ConflictException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import {
  freezeSubscriptionClosureOutcome,
  hashSubscriptionClosureSnapshot
} from "./subscription-closure.domain";
import type { SubscriptionClosureAuthorityLock } from "./subscription-closure.repository";
import type { SubscriptionClosureJsonObject } from "./subscription-closure.types";

export const SUBSCRIPTION_CLOSURE_SETTLEMENT_ERROR_CODE = {
  AUTHORITY_NOT_FOUND: "SUBSCRIPTION_CLOSURE_SETTLEMENT_AUTHORITY_NOT_FOUND",
  FACT_INCONSISTENT: "SUBSCRIPTION_CLOSURE_SETTLEMENT_FACT_INCONSISTENT"
} as const;

export type ResolvedSubscriptionClosureSettlement = Readonly<{
  amountDueCents: bigint;
  amountRefundableCents: bigint;
  authorityLocks: readonly SubscriptionClosureAuthorityLock[];
  billInputSnapshot: SubscriptionClosureJsonObject;
  closureCaseId: string;
  contractId: string;
  costTotalCents: bigint;
  customerId: string;
  depositAppliedCents: bigint;
  depositFinal: boolean;
  depositInputSnapshot: SubscriptionClosureJsonObject;
  depositRefundCents: bigint;
  inputSnapshotHash: string;
  ledgerInputSnapshot: SubscriptionClosureJsonObject;
  obligationsResolved: boolean;
  orderId: string;
  paidTotalCents: bigint;
  receivableTotalCents: bigint;
  responsibilitySnapshot: SubscriptionClosureJsonObject;
  resultHash: string;
  resultSnapshot: SubscriptionClosureJsonObject;
  vehicleId: string;
  waiverTotalCents: bigint;
  writeOffTotalCents: bigint;
}>;

@Injectable()
export class SubscriptionClosureSettlementResolver {
  async resolveInTransaction(
    tx: Prisma.TransactionClient,
    closureCaseId: string
  ): Promise<ResolvedSubscriptionClosureSettlement> {
    const closureCase = await tx.subscriptionClosureCase.findUnique({
      select: {
        closureType: true,
        contractId: true,
        customerId: true,
        id: true,
        orderId: true,
        physicalControlMode: true,
        status: true,
        vehicleId: true,
        vehicleReturnId: true
      },
      where: { id: closureCaseId }
    });
    if (!closureCase) throw settlementConflict("AUTHORITY_NOT_FOUND");
    const order = await tx.subscriptionOrder.findUnique({
      select: {
        contractId: true,
        customerId: true,
        deletedAt: true,
        depositAmount: true,
        depositStatus: true,
        finalDepositAmount: true,
        id: true,
        vehicleId: true
      },
      where: { id: closureCase.orderId }
    });
    if (
      !order ||
      order.deletedAt ||
      order.contractId !== closureCase.contractId ||
      order.customerId !== closureCase.customerId ||
      order.vehicleId !== closureCase.vehicleId
    ) {
      throw settlementConflict("FACT_INCONSISTENT");
    }

    const ledger = await tx.vehicleCostLedgerEntry.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        actionType: true,
        amountCents: true,
        confirmedAt: true,
        confirmedBy: true,
        contractId: true,
        costCategory: true,
        createdAt: true,
        customerId: true,
        entryKind: true,
        id: true,
        orderId: true,
        responsibilitySnapshot: true,
        responsiblePartyId: true,
        responsiblePartyType: true,
        reversalOfEntryId: true,
        vehicleId: true
      },
      where: { orderId: closureCase.orderId }
    });
    const damages = await tx.vehicleReturnDamage.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        createdAt: true,
        damageLevel: true,
        damageType: true,
        deletedAt: true,
        description: true,
        estimatedRepairAmount: true,
        id: true,
        photoUrls: true,
        responsibleParty: true,
        returnId: true,
        status: true,
        updatedAt: true,
        vehicleId: true
      },
      where: { deletedAt: null, orderId: closureCase.orderId }
    });
    const mileageReadings = await tx.vehicleMileageReading.findMany({
      orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
      select: {
        confirmedAt: true,
        confirmedBy: true,
        createdAt: true,
        deltaKm: true,
        evidenceSnapshot: true,
        id: true,
        mileageKm: true,
        recordedAt: true,
        sourceRecordId: true,
        sourceType: true,
        status: true,
        updatedAt: true,
        vehicleId: true
      },
      where: { orderId: closureCase.orderId, status: "ACTIVE" }
    });
    const bills = await tx.receivableBill.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        amount: true,
        billNo: true,
        billStatus: true,
        billType: true,
        cancelledAt: true,
        createdAt: true,
        customerId: true,
        dueDate: true,
        id: true,
        paidAmount: true,
        remainingAmount: true,
        snapshot: true,
        updatedAt: true,
        orderId: true
      },
      where: {
        billStatus: { not: "CANCELLED" },
        deletedAt: null,
        orderId: closureCase.orderId
      }
    });
    const payments = await tx.paymentRecord.findMany({
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      select: {
        createdAt: true,
        customerId: true,
        id: true,
        paymentAmount: true,
        paymentStatus: true,
        receivedAt: true,
        updatedAt: true
      },
      where: {
        deletedAt: null,
        orderId: closureCase.orderId,
        paymentStatus: "CONFIRMED"
      }
    });
    const paymentAllocations = await tx.paymentWriteOff.findMany({
      orderBy: [{ writeOffAt: "asc" }, { id: "asc" }],
      select: {
        billId: true,
        createdAt: true,
        customerId: true,
        id: true,
        paymentId: true,
        writeOffAmount: true,
        writeOffAt: true
      },
      where: { deletedAt: null, orderId: closureCase.orderId }
    });
    const deposits = await tx.depositLedger.findMany({
      orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        amount: true,
        balanceAfter: true,
        billId: true,
        createdAt: true,
        customerId: true,
        id: true,
        occurredAt: true,
        orderId: true,
        paymentId: true,
        snapshot: true,
        transactionStatus: true,
        transactionType: true
      },
      where: {
        deletedAt: null,
        orderId: closureCase.orderId,
        transactionStatus: "CONFIRMED"
      }
    });

    const reconciliation = assertFinancialCoherence(
      closureCase.orderId,
      closureCase.customerId,
      bills,
      payments,
      paymentAllocations,
      deposits
    );
    const costTotalCents = ledgerTotal(ledger, "ACTUAL_COST");
    const customerResolution = (entry: (typeof ledger)[number]) =>
      entry.responsiblePartyType === "CUSTOMER" &&
      entry.responsiblePartyId === closureCase.customerId &&
      entry.customerId === closureCase.customerId &&
      entry.orderId === closureCase.orderId &&
      entry.contractId === closureCase.contractId &&
      entry.vehicleId === closureCase.vehicleId;
    const waiverTotalCents = ledgerTotal(ledger, "WAIVER", customerResolution);
    const writeOffTotalCents = ledgerTotal(ledger, "WRITE_OFF", customerResolution);
    const receivableTotalCents = sum(bills.map(({ amount }) => amount));
    const paidTotalCents = reconciliation.paidTotalCents;
    const remainingTotalCents = sum(bills.map(({ remainingAmount }) => remainingAmount));
    const depositAppliedCents = sum(
      deposits
        .filter(({ transactionType }) => transactionType === "DEDUCT")
        .map(({ amount }) => amount)
    );
    const depositRefundCents = sum(
      deposits
        .filter(({ transactionType }) => transactionType === "REFUND")
        .map(({ amount }) => amount)
    );
    for (const value of [
      costTotalCents,
      waiverTotalCents,
      writeOffTotalCents,
      receivableTotalCents,
      paidTotalCents,
      remainingTotalCents,
      depositAppliedCents,
      depositRefundCents
    ]) {
      if (value < 0n) throw settlementConflict("FACT_INCONSISTENT");
    }
    if (waiverTotalCents + writeOffTotalCents > remainingTotalCents) {
      throw settlementConflict("FACT_INCONSISTENT");
    }
    const amountDueCents = nonnegative(remainingTotalCents - waiverTotalCents - writeOffTotalCents);
    const effectiveDeposit = order.finalDepositAmount ?? order.depositAmount;
    const depositFinal =
      order.depositStatus === "WAIVED" ||
      order.depositStatus === "REJECTED" ||
      effectiveDeposit === 0n ||
      (deposits.length > 0 && deposits.at(-1)!.balanceAfter === 0n);
    const amountRefundableCents = depositRefundCents;

    const ledgerInputSnapshot = freezeSubscriptionClosureOutcome({
      entries: ledger.map((entry) => settlementJson(entry))
    });
    const billInputSnapshot = freezeSubscriptionClosureOutcome({
      bills: bills.map((bill) => ({
        ...settlementJson(bill),
        amountCents: bill.amount.toString(),
        paidAmountCents: bill.paidAmount.toString(),
        remainingAmountCents: bill.remainingAmount.toString()
      })),
      paymentAllocations: paymentAllocations.map((allocation) => settlementJson(allocation)),
      payments: payments.map((payment) => settlementJson(payment))
    });
    const depositInputSnapshot = freezeSubscriptionClosureOutcome({
      depositAmountCents: order.depositAmount,
      depositFinal,
      depositStatus: order.depositStatus,
      finalDepositAmountCents: order.finalDepositAmount,
      ledgers: deposits.map((deposit) => settlementJson(deposit))
    });
    const responsibilitySnapshot = freezeSubscriptionClosureOutcome({
      damages: damages.map((damage) => settlementJson(damage)),
      mileageReadings: mileageReadings.map((reading) => settlementJson(reading)),
      responsibilityEntries: ledger
        .filter(({ actionType }) => actionType === "RESPONSIBILITY_CONFIRMED")
        .map((entry) => settlementJson(entry))
    });
    const inputSnapshotHash = hashSubscriptionClosureSnapshot({
      bill: billInputSnapshot,
      deposit: depositInputSnapshot,
      ledger: ledgerInputSnapshot,
      responsibility: responsibilitySnapshot
    });
    const obligationsResolved = amountDueCents === 0n && depositFinal;
    const resultSnapshot = freezeSubscriptionClosureOutcome({
      amountDueCents,
      amountRefundableCents,
      depositFinal,
      inputSnapshotHash,
      obligationsResolved,
      resolution: {
        depositAppliedCents,
        paidTotalCents,
        waiverTotalCents,
        writeOffTotalCents
      }
    });

    return Object.freeze({
      amountDueCents,
      amountRefundableCents,
      authorityLocks: authorityLocks({
        bills,
        closureCase,
        damages,
        deposits,
        ledger,
        mileageReadings,
        paymentAllocations,
        payments
      }),
      billInputSnapshot,
      closureCaseId: closureCase.id,
      contractId: closureCase.contractId,
      costTotalCents,
      customerId: closureCase.customerId,
      depositAppliedCents,
      depositFinal,
      depositInputSnapshot,
      depositRefundCents,
      inputSnapshotHash,
      ledgerInputSnapshot,
      obligationsResolved,
      orderId: closureCase.orderId,
      paidTotalCents,
      receivableTotalCents,
      responsibilitySnapshot,
      resultHash: hashSubscriptionClosureSnapshot(resultSnapshot),
      resultSnapshot,
      vehicleId: closureCase.vehicleId,
      waiverTotalCents,
      writeOffTotalCents
    });
  }
}

function settlementJson(value: object) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return item.toString();
      if (item instanceof Date) return item.toISOString();
      return item;
    })
  ) as Record<string, unknown>;
}

function assertFinancialCoherence(
  orderId: string,
  customerId: string,
  bills: readonly Readonly<{
    id: string;
    amount: bigint;
    billStatus: string;
    billType: string;
    paidAmount: bigint;
    remainingAmount: bigint;
    customerId: string;
    orderId: string;
  }>[],
  payments: readonly Readonly<{ id: string; customerId: string; paymentAmount: bigint }>[],
  allocations: readonly Readonly<{
    billId: string;
    customerId: string;
    paymentId: string;
    writeOffAmount: bigint;
  }>[],
  deposits: readonly Readonly<{
    amount: bigint;
    balanceAfter: bigint;
    billId: string | null;
    customerId: string;
    orderId: string;
    paymentId: string | null;
    transactionType: string;
  }>[]
) {
  const billById = new Map(bills.map((bill) => [bill.id, bill]));
  const paymentById = new Map(payments.map((payment) => [payment.id, payment]));
  if (
    bills.some(
      (bill) =>
        bill.customerId !== customerId ||
        bill.amount < 0n ||
        bill.paidAmount < 0n ||
        bill.remainingAmount < 0n ||
        bill.paidAmount + bill.remainingAmount !== bill.amount
    ) ||
    payments.some((payment) => payment.customerId !== customerId || payment.paymentAmount <= 0n) ||
    deposits.some(
      (deposit) =>
        deposit.customerId !== customerId || deposit.orderId !== orderId || deposit.amount <= 0n
    )
  ) {
    throw settlementConflict("FACT_INCONSISTENT");
  }
  const allocatedByBill = new Map<string, bigint>();
  const allocatedByPayment = new Map<string, bigint>();
  for (const allocation of allocations) {
    if (
      allocation.customerId !== customerId ||
      allocation.writeOffAmount <= 0n ||
      !billById.has(allocation.billId) ||
      !paymentById.has(allocation.paymentId)
    ) {
      throw settlementConflict("FACT_INCONSISTENT");
    }
    allocatedByBill.set(
      allocation.billId,
      (allocatedByBill.get(allocation.billId) ?? 0n) + allocation.writeOffAmount
    );
    allocatedByPayment.set(
      allocation.paymentId,
      (allocatedByPayment.get(allocation.paymentId) ?? 0n) + allocation.writeOffAmount
    );
  }
  const deductedByBill = new Map<string, bigint>();
  let depositBalance = 0n;
  for (const deposit of deposits) {
    const signedAmount =
      deposit.transactionType === "COLLECT"
        ? deposit.amount
        : deposit.transactionType === "DEDUCT" ||
            deposit.transactionType === "REFUND" ||
            deposit.transactionType === "RELEASE"
          ? -deposit.amount
          : deposit.transactionType === "FREEZE"
            ? 0n
            : null;
    if (signedAmount === null) throw settlementConflict("FACT_INCONSISTENT");
    depositBalance += signedAmount;
    if (depositBalance < 0n || deposit.balanceAfter !== depositBalance) {
      throw settlementConflict("FACT_INCONSISTENT");
    }
    if (deposit.transactionType !== "DEDUCT") continue;
    const bill = deposit.billId ? billById.get(deposit.billId) : undefined;
    if (
      !bill ||
      bill.orderId !== orderId ||
      bill.customerId !== customerId ||
      bill.billType !== "DAMAGE_FEE" ||
      bill.billStatus === "CANCELLED" ||
      deposit.paymentId !== null
    ) {
      throw settlementConflict("FACT_INCONSISTENT");
    }
    deductedByBill.set(bill.id, (deductedByBill.get(bill.id) ?? 0n) + deposit.amount);
  }
  if (
    bills.some(
      (bill) =>
        (allocatedByBill.get(bill.id) ?? 0n) + (deductedByBill.get(bill.id) ?? 0n) !==
        bill.paidAmount
    ) ||
    payments.some((payment) => (allocatedByPayment.get(payment.id) ?? 0n) > payment.paymentAmount)
  ) {
    throw settlementConflict("FACT_INCONSISTENT");
  }
  return Object.freeze({ paidTotalCents: sum(bills.map(({ paidAmount }) => paidAmount)) });
}

function ledgerTotal<T extends Readonly<{ actionType: string; amountCents: bigint }>>(
  entries: readonly T[],
  actionType: string,
  predicate: (entry: T) => boolean = () => true
) {
  return sum(
    entries
      .filter((entry) => entry.actionType === actionType && predicate(entry))
      .map((entry) => entry.amountCents)
  );
}

function sum(values: readonly bigint[]) {
  return values.reduce((total, value) => total + value, 0n);
}

function nonnegative(value: bigint) {
  return value < 0n ? 0n : value;
}

function authorityLocks(input: {
  bills: readonly Readonly<{ id: string }>[];
  closureCase: Readonly<{
    contractId: string;
    customerId: string;
    id: string;
    orderId: string;
    vehicleId: string;
    vehicleReturnId: string | null;
  }>;
  damages: readonly Readonly<{ id: string }>[];
  deposits: readonly Readonly<{ id: string }>[];
  ledger: readonly Readonly<{ id: string }>[];
  mileageReadings: readonly Readonly<{ id: string }>[];
  paymentAllocations: readonly Readonly<{ id: string }>[];
  payments: readonly Readonly<{ id: string }>[];
}): readonly SubscriptionClosureAuthorityLock[] {
  return [
    { id: input.closureCase.id, mode: "UPDATE", table: "subscription_closure_case" },
    { id: input.closureCase.orderId, mode: "UPDATE", table: "subscription_order" },
    { id: input.closureCase.vehicleId, mode: "SHARE", table: "vehicle" },
    { id: input.closureCase.contractId, mode: "UPDATE", table: "contract" },
    ...(input.closureCase.vehicleReturnId
      ? [
          {
            id: input.closureCase.vehicleReturnId,
            mode: "SHARE" as const,
            table: "vehicle_return" as const
          }
        ]
      : []),
    ...input.damages.map(({ id }) => ({
      id,
      mode: "UPDATE" as const,
      table: "vehicle_return_damage" as const
    })),
    ...input.mileageReadings.map(({ id }) => ({
      id,
      mode: "UPDATE" as const,
      table: "vehicle_mileage_reading" as const
    })),
    ...input.ledger.map(({ id }) => ({
      id,
      mode: "UPDATE" as const,
      table: "vehicle_cost_ledger_entry" as const
    })),
    ...input.bills.map(({ id }) => ({
      id,
      mode: "UPDATE" as const,
      table: "receivable_bill" as const
    })),
    ...input.payments.map(({ id }) => ({
      id,
      mode: "UPDATE" as const,
      table: "payment_record" as const
    })),
    ...input.paymentAllocations.map(({ id }) => ({
      id,
      mode: "UPDATE" as const,
      table: "payment_write_off" as const
    })),
    ...input.deposits.map(({ id }) => ({
      id,
      mode: "UPDATE" as const,
      table: "deposit_ledger" as const
    })),
    { id: input.closureCase.customerId, mode: "SHARE", table: "customer" }
  ];
}

function settlementConflict(key: keyof typeof SUBSCRIPTION_CLOSURE_SETTLEMENT_ERROR_CODE) {
  return new ConflictException({
    code: SUBSCRIPTION_CLOSURE_SETTLEMENT_ERROR_CODE[key],
    message: "The authoritative settlement facts are missing or inconsistent."
  });
}
