import { BillType, PaymentStatus } from "@prisma/client";

import type { EconomicPaymentRecord, EconomicWriteOffAdjustment, RevenueAttributionResult } from "./economics.types";

export class RevenueAttributionModel {
  attributeVehicleRevenue(
    vehicleId: string,
    paymentRecords: EconomicPaymentRecord[],
    writeOffAdjustments: EconomicWriteOffAdjustment[],
    from: Date,
    to: Date
  ): RevenueAttributionResult {
    let ignoredRevenue = 0;
    let leaseRevenue = 0;
    let penaltyRevenue = 0;
    let recognizedPaymentCount = 0;
    let unassignedRevenue = 0;

    for (const payment of paymentRecords) {
      if (!isRealizedInPeriod(payment, from, to)) {
        ignoredRevenue += positiveAmount(payment.amount);
        continue;
      }

      if (payment.vehicleId !== vehicleId) {
        if (payment.vehicleId === null) {
          unassignedRevenue += positiveAmount(payment.amount);
        }
        continue;
      }

      if (isDeposit(payment.billType)) {
        ignoredRevenue += positiveAmount(payment.amount);
        continue;
      }

      if (isLeaseRevenue(payment.billType)) {
        leaseRevenue += positiveAmount(payment.amount);
        recognizedPaymentCount += 1;
        continue;
      }

      if (isPenaltyRevenue(payment.billType)) {
        penaltyRevenue += positiveAmount(payment.amount);
        recognizedPaymentCount += 1;
        continue;
      }

      ignoredRevenue += positiveAmount(payment.amount);
    }

    const writeOffImpact = writeOffAdjustments
      .filter((adjustment) => adjustment.vehicleId === vehicleId)
      .reduce((total, adjustment) => total - positiveAmount(adjustment.amount), 0);

    return {
      ignoredRevenue: roundMoney(ignoredRevenue),
      leaseRevenue: roundMoney(leaseRevenue),
      penaltyRevenue: roundMoney(penaltyRevenue),
      recognizedPaymentCount,
      unassignedRevenue: roundMoney(unassignedRevenue),
      writeOffImpact: roundMoney(writeOffImpact)
    };
  }
}

function isRealizedInPeriod(payment: EconomicPaymentRecord, from: Date, to: Date) {
  return payment.paymentStatus === PaymentStatus.CONFIRMED && payment.receivedAt >= from && payment.receivedAt <= to;
}

function isDeposit(billType: BillType | null) {
  return billType === BillType.DEPOSIT;
}

function isLeaseRevenue(billType: BillType | null) {
  return billType === BillType.FIRST_MONTHLY_FEE || billType === BillType.MONTHLY_RENT;
}

function isPenaltyRevenue(billType: BillType | null) {
  return billType === BillType.DAMAGE_FEE || billType === BillType.OTHER;
}

function positiveAmount(amount: number) {
  return Math.max(amount, 0);
}

function roundMoney(value: number) {
  return Number(value.toFixed(6));
}
