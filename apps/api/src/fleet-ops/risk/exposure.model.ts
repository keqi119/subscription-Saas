import { BillStatus } from "@prisma/client";

import type { FleetRiskInput, RiskExposure } from "./risk.types";

export class ExposureModel {
  calculate(vehicleId: string, input: FleetRiskInput, recognizedRevenue: number): RiskExposure {
    const bills = input.receivableBills.filter((bill) => bill.vehicleId === vehicleId);
    const unpaidBills = bills.filter((bill) => isUnpaidBill(bill.billStatus) && bill.remainingAmount > 0);
    const overdueBills = unpaidBills.filter((bill) => bill.dueDate < input.asOf);
    const overdueAmount = sum(overdueBills, (bill) => bill.remainingAmount);
    const unpaidAmount = sum(unpaidBills, (bill) => bill.remainingAmount);
    const partialPaymentCount = unpaidBills.filter((bill) => bill.billStatus === BillStatus.PARTIALLY_PAID || bill.paidAmount > 0).length;
    const maxOverdueDays = overdueBills.reduce((max, bill) => Math.max(max, daysBetween(bill.dueDate, input.asOf)), 0);
    const score = calculateExposureScore({
      maxOverdueDays,
      overdueAmount,
      partialPaymentCount,
      recognizedRevenue,
      unpaidAmount
    });

    return {
      maxOverdueDays,
      overdueAmount: roundMoney(overdueAmount),
      partialPaymentCount,
      score,
      unpaidAmount: roundMoney(unpaidAmount)
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

function daysBetween(from: Date, to: Date) {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;

  return Math.max(0, Math.floor((startOfUtcDay(to).getTime() - startOfUtcDay(from).getTime()) / millisecondsPerDay));
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
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
