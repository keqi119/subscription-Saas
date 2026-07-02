import { BillStatus } from "@prisma/client";

import type { RiskEvidence, RiskOverdueBillRef, RiskReceivableBill, RiskWarning } from "./risk.types";

export interface OverdueDetectorInput {
  asOf: Date;
  bills: RiskReceivableBill[];
  vehicleId: string;
}

export interface OverdueDetectorResult {
  evidence: RiskEvidence[];
  overdueFacts: RiskOverdueBillRef[];
  warnings: RiskWarning[];
}

export class OverdueDetectorModel {
  detect(input: OverdueDetectorInput): OverdueDetectorResult {
    const evidence: RiskEvidence[] = [];
    const overdueFacts: RiskOverdueBillRef[] = [];
    const warnings: RiskWarning[] = [];

    for (const bill of input.bills.filter((candidate) => candidate.vehicleId === input.vehicleId)) {
      if (bill.billStatus === BillStatus.CANCELLED) {
        continue;
      }

      if (bill.billStatus === BillStatus.PAID || bill.remainingAmount <= 0 || bill.dueDate >= input.asOf) {
        continue;
      }

      const overdueDays = daysBetween(bill.dueDate, input.asOf);

      if (overdueDays <= 0) {
        continue;
      }

      const fact: RiskOverdueBillRef = {
        billId: bill.id,
        dueDate: bill.dueDate,
        overdueDays,
        paidAmount: bill.paidAmount,
        remainingAmount: bill.remainingAmount,
        sourceStatus: bill.billStatus
      };

      overdueFacts.push(fact);
      evidence.push({
        amount: bill.remainingAmount,
        observedAt: input.asOf,
        reason: "bill due date is before as-of date and remaining amount is still open",
        source: "receivable_bill",
        sourceId: bill.id
      });

      if (bill.billStatus !== BillStatus.OVERDUE) {
        warnings.push({
          code: "FACTUAL_OVERDUE_STATUS_NOT_REFRESHED",
          message: "Bill is factually overdue even though billStatus has not been refreshed to OVERDUE.",
          sourceId: bill.id
        });
      }
    }

    return {
      evidence,
      overdueFacts: overdueFacts.sort((left, right) => left.dueDate.getTime() - right.dueDate.getTime() || left.billId.localeCompare(right.billId)),
      warnings
    };
  }
}

export function daysBetween(from: Date, to: Date) {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;

  return Math.max(0, Math.floor((startOfUtcDay(to).getTime() - startOfUtcDay(from).getTime()) / millisecondsPerDay));
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
