import { BillType, DepositTransactionStatus, DepositTransactionType, PaymentStatus } from "@prisma/client";

import type {
  EconomicCashflowInput,
  EconomicPaymentRecord,
  EconomicPaymentWriteOffAllocation,
  EconomicReceivableBill,
  FleetKpiCashflow,
  FleetKpiEvidence,
  FleetKpiWarning
} from "./economics.types";

const OPERATING_REVENUE_BILL_TYPES = new Set<BillType>([
  BillType.FIRST_MONTHLY_FEE,
  BillType.MONTHLY_RENT,
  BillType.DAMAGE_FEE,
  BillType.OTHER
]);

export class CashflowModel {
  calculate(input: EconomicCashflowInput): FleetKpiCashflow {
    const evidence: FleetKpiEvidence[] = [];
    const warnings = new Set<FleetKpiWarning>();
    const allocatedPaymentIds = new Set(input.writeOffAllocations.map((writeOff) => writeOff.paymentId));
    const cashflow: FleetKpiCashflow = {
      actual: {
        deposit: 0,
        operating: 0,
        unassigned: 0
      },
      evidence,
      planned: {
        deposit: 0,
        operating: 0
      },
      warnings: [],
      writeOff: {
        appliedDeposit: 0,
        appliedOperating: 0,
        unlinked: 0
      }
    };

    for (const bill of input.receivableBills) {
      applyPlannedBill(input, bill, cashflow, evidence, warnings);
    }

    for (const payment of input.paymentRecords) {
      applyActualPayment(input, payment, allocatedPaymentIds, cashflow, evidence, warnings);
    }

    for (const writeOff of input.writeOffAllocations) {
      applyWriteOff(input, writeOff, cashflow, evidence, warnings);
    }

    for (const ledger of input.depositLedgers) {
      if (
        ledger.vehicleId === input.vehicleId &&
        ledger.transactionStatus === DepositTransactionStatus.CONFIRMED &&
        ledger.transactionType === DepositTransactionType.COLLECT &&
        ledger.occurredAt &&
        isInRange(ledger.occurredAt, input.from, input.to)
      ) {
        cashflow.actual.deposit += positiveAmount(ledger.amount);
        warnings.add("DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE");
        evidence.push({
          amount: positiveAmount(ledger.amount),
          reason: "confirmed deposit ledger is tracked separately from operating revenue",
          source: "deposit_ledger",
          sourceId: ledger.id
        });
      }
    }

    return {
      ...cashflow,
      actual: {
        deposit: roundMoney(cashflow.actual.deposit),
        operating: roundMoney(cashflow.actual.operating),
        unassigned: roundMoney(cashflow.actual.unassigned ?? 0)
      },
      planned: {
        deposit: roundMoney(cashflow.planned.deposit),
        operating: roundMoney(cashflow.planned.operating)
      },
      warnings: [...warnings].sort(),
      writeOff: {
        appliedDeposit: roundMoney(cashflow.writeOff.appliedDeposit),
        appliedOperating: roundMoney(cashflow.writeOff.appliedOperating),
        unlinked: roundMoney(cashflow.writeOff.unlinked)
      }
    };
  }
}

function applyPlannedBill(
  input: EconomicCashflowInput,
  bill: EconomicReceivableBill,
  cashflow: FleetKpiCashflow,
  evidence: FleetKpiEvidence[],
  warnings: Set<FleetKpiWarning>
) {
  if (bill.vehicleId !== input.vehicleId) {
    return;
  }

  if (!bill.dueDate) {
    warnings.add("MISSING_RECEIVABLE_DUE_DATE");
    evidence.push({
      amount: positiveAmount(bill.amount),
      reason: "receivable bill is missing due date and cannot be scheduled as planned cashflow",
      source: "receivable_bill",
      sourceId: bill.id
    });
    return;
  }

  if (!isInRange(bill.dueDate, input.from, input.to)) {
    return;
  }

  const amount = positiveAmount(bill.amount);
  if (bill.billType === BillType.DEPOSIT) {
    cashflow.planned.deposit += amount;
    warnings.add("DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE");
  } else if (OPERATING_REVENUE_BILL_TYPES.has(bill.billType)) {
    cashflow.planned.operating += amount;
  }

  evidence.push({
    amount,
    reason: bill.billType === BillType.DEPOSIT ? "planned deposit cashflow is separate from operating revenue" : "receivable due date contributes planned operating cashflow only",
    source: "receivable_bill",
    sourceId: bill.id
  });
}

function applyActualPayment(
  input: EconomicCashflowInput,
  payment: EconomicPaymentRecord,
  allocatedPaymentIds: Set<string>,
  cashflow: FleetKpiCashflow,
  evidence: FleetKpiEvidence[],
  warnings: Set<FleetKpiWarning>
) {
  if (payment.paymentStatus !== PaymentStatus.CONFIRMED) {
    warnings.add("NON_CONFIRMED_PAYMENT_EXCLUDED");
    return;
  }

  if (!payment.receivedAt) {
    warnings.add("MISSING_PAYMENT_RECEIVED_AT");
    return;
  }

  if (!isInRange(payment.receivedAt, input.from, input.to)) {
    return;
  }

  if (payment.vehicleId !== input.vehicleId) {
    if (payment.vehicleId === null) {
      cashflow.actual.unassigned = (cashflow.actual.unassigned ?? 0) + positiveAmount(payment.amount);
      warnings.add("UNASSIGNED_PAYMENT_EXCLUDED");
      evidence.push({
        amount: positiveAmount(payment.amount),
        reason: "confirmed payment has no vehicle attribution and is excluded from vehicle operating revenue",
        source: "payment_record",
        sourceId: payment.id
      });
    }
    return;
  }

  if (allocatedPaymentIds.has(payment.id)) {
    evidence.push({
      amount: positiveAmount(payment.amount),
      reason: "parent payment has write-off allocations; allocation rows drive actual operating cashflow to avoid double counting",
      source: "payment_record",
      sourceId: payment.id
    });
    return;
  }

  const amount = positiveAmount(payment.amount);
  if (payment.billType === BillType.DEPOSIT) {
    cashflow.actual.deposit += amount;
    warnings.add("DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE");
  } else if (payment.billType && OPERATING_REVENUE_BILL_TYPES.has(payment.billType)) {
    cashflow.actual.operating += amount;
  }

  evidence.push({
    amount,
    reason: payment.billType === BillType.DEPOSIT ? "confirmed deposit payment is tracked separately from operating revenue" : "confirmed payment received date contributes actual operating cashflow",
    source: "payment_record",
    sourceId: payment.id
  });
}

function applyWriteOff(
  input: EconomicCashflowInput,
  writeOff: EconomicPaymentWriteOffAllocation,
  cashflow: FleetKpiCashflow,
  evidence: FleetKpiEvidence[],
  warnings: Set<FleetKpiWarning>
) {
  if (writeOff.vehicleId !== input.vehicleId) {
    return;
  }

  if (!writeOff.writeOffAt || !isInRange(writeOff.writeOffAt, input.from, input.to)) {
    return;
  }

  const amount = positiveAmount(writeOff.amount);
  if (!writeOff.billId || !writeOff.billType) {
    cashflow.writeOff.unlinked += amount;
    warnings.add("WRITE_OFF_WITHOUT_CLEAR_BILL_LINKAGE");
  } else if (writeOff.billType === BillType.DEPOSIT) {
    cashflow.actual.deposit += amount;
    cashflow.writeOff.appliedDeposit += amount;
    warnings.add("DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE");
  } else if (OPERATING_REVENUE_BILL_TYPES.has(writeOff.billType)) {
    cashflow.actual.operating += amount;
    cashflow.writeOff.appliedOperating += amount;
  }

  evidence.push({
    amount,
    reason: "payment write-off allocation contributes actual cashflow without counting the parent payment twice",
    source: "payment_write_off",
    sourceId: writeOff.id
  });
}

function isInRange(value: Date, from: Date, to: Date) {
  return value >= from && value <= to;
}

function positiveAmount(amount: number) {
  return Math.max(amount, 0);
}

function roundMoney(value: number) {
  return Number(value.toFixed(6));
}
