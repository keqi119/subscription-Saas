import { BillStatus } from "@prisma/client";

import type { FleetRiskInput, RiskExposure } from "./risk.types";
import { OverdueDetectorModel } from "./overdue-detector.model";

export class ExposureModel {
  private readonly overdueDetector = new OverdueDetectorModel();

  calculate(vehicleId: string, input: FleetRiskInput, recognizedRevenue: number): RiskExposure {
    const bills = input.receivableBills.filter((bill) => bill.vehicleId === vehicleId);
    const unpaidBills = bills.filter((bill) => isUnpaidBill(bill.billStatus) && bill.remainingAmount > 0);
    const overdueDetection = this.overdueDetector.detect({ asOf: input.asOf, bills, vehicleId });
    const overdueBillIds = new Set(overdueDetection.overdueFacts.map((fact) => fact.billId));
    const overdueBills = bills.filter((bill) => overdueBillIds.has(bill.id));
    const overdueAmount = sum(overdueDetection.overdueFacts, (bill) => bill.remainingAmount);
    const unpaidAmount = sum(unpaidBills, (bill) => bill.remainingAmount);
    const partialPaymentCount = unpaidBills.filter((bill) => bill.billStatus === BillStatus.PARTIALLY_PAID || bill.paidAmount > 0).length;
    const partialPaymentEvidence = unpaidBills
      .filter((bill) => bill.billStatus === BillStatus.PARTIALLY_PAID || bill.paidAmount > 0)
      .map((bill) => ({
        amount: bill.paidAmount,
        observedAt: input.asOf,
        reason: "bill has partial payment evidence but remaining amount is still open",
        source: "receivable_bill" as const,
        sourceId: bill.id
      }));
    const writeOffEvidence = overdueBills.flatMap((bill) => bill.writeOffs ?? []);
    const maxOverdueDays = overdueDetection.overdueFacts.reduce((max, bill) => Math.max(max, bill.overdueDays), 0);
    const score = calculateExposureScore({
      maxOverdueDays,
      overdueAmount,
      partialPaymentCount,
      recognizedRevenue,
      unpaidAmount
    });

    return {
      evidence: [...overdueDetection.evidence, ...partialPaymentEvidence],
      maxOverdueDays,
      overdueAmount: roundMoney(overdueAmount),
      overdueBillCount: overdueDetection.overdueFacts.length,
      overdueBillRefs: overdueDetection.overdueFacts,
      overdueRemainingAmount: roundMoney(overdueAmount),
      partialPaymentCount,
      partialPaymentEvidence,
      score,
      unpaidAmount: roundMoney(unpaidAmount),
      warnings: [
        ...overdueDetection.warnings,
        ...(writeOffEvidence.length === 0 && overdueDetection.overdueFacts.length > 0
          ? [
              {
                code: "WRITE_OFF_LINKAGE_UNAVAILABLE",
                message: "No write-off allocation evidence was available for open overdue bills; exposure uses current remaining amount only."
              }
            ]
          : [])
      ],
      writeOffEvidence
    };
  }
}

function calculateExposureScore(input: {
  maxOverdueDays: number;
  overdueAmount: number;
  partialPaymentCount: number;
  recognizedRevenue: number;
  unpaidAmount: number;
}) {
  let score = 0;
  const revenueBase = Math.max(input.recognizedRevenue, 1);
  const overdueRevenueRatio = input.overdueAmount / revenueBase;

  if (overdueRevenueRatio >= 3) {
    score += 40;
  } else if (overdueRevenueRatio >= 1) {
    score += 30;
  } else if (overdueRevenueRatio > 0) {
    score += 20;
  }

  if (input.maxOverdueDays >= 30) {
    score += 30;
  } else if (input.maxOverdueDays >= 15) {
    score += 25;
  } else if (input.maxOverdueDays >= 7) {
    score += 15;
  } else if (input.maxOverdueDays > 0) {
    score += 8;
  }

  if (input.unpaidAmount > input.recognizedRevenue && input.unpaidAmount > 0) {
    score += 10;
  }

  if (input.partialPaymentCount > 0) {
    score += 10;
  }

  if (input.overdueAmount > 0 && input.partialPaymentCount > 0) {
    score += 10;
  }

  return clampScore(score);
}

function isUnpaidBill(status: BillStatus) {
  return status !== BillStatus.PAID && status !== BillStatus.CANCELLED;
}

function sum<T>(items: T[], projector: (item: T) => number) {
  return items.reduce((total, item) => total + projector(item), 0);
}

function clampScore(score: number) {
  return Math.min(100, Math.max(0, Math.round(score)));
}

function roundMoney(value: number) {
  return Number(value.toFixed(6));
}
