import { BillType, PaymentStatus } from "@prisma/client";

import type { EconomicPaymentRecord, EconomicWriteOffAdjustment, FleetKpiEvidence, FleetKpiWarning, RevenueAttributionResult } from "./economics.types";

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
    let depositExcludedRevenue = 0;
    const evidence: FleetKpiEvidence[] = [];
    const warnings = new Set<FleetKpiWarning>();

    for (const payment of paymentRecords) {
      if (!isRealizedInPeriod(payment, from, to)) {
        ignoredRevenue += positiveAmount(payment.amount);
        if (payment.paymentStatus !== PaymentStatus.CONFIRMED) {
          warnings.add("NON_CONFIRMED_PAYMENT_EXCLUDED");
        } else if (!payment.receivedAt) {
          warnings.add("MISSING_PAYMENT_RECEIVED_AT");
        }
        continue;
      }

      if (payment.vehicleId !== vehicleId) {
        if (payment.vehicleId === null) {
          unassignedRevenue += positiveAmount(payment.amount);
          warnings.add("UNASSIGNED_PAYMENT_EXCLUDED");
          evidence.push({
            amount: positiveAmount(payment.amount),
            reason: "confirmed payment has no vehicle attribution and is excluded from vehicle operating revenue",
            source: "payment_record",
            sourceId: payment.id
          });
        }
        continue;
      }

      if (isDeposit(payment.billType)) {
        const amount = positiveAmount(payment.amount);
        depositExcludedRevenue += amount;
        ignoredRevenue += amount;
        warnings.add("DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE");
        evidence.push({
          amount,
          reason: "deposit payment is excluded from operating revenue",
          source: "payment_record",
          sourceId: payment.id
        });
        continue;
      }

      if (isLeaseRevenue(payment.billType)) {
        const amount = positiveAmount(payment.amount);
        leaseRevenue += amount;
        recognizedPaymentCount += 1;
        evidence.push({
          amount,
          reason: "confirmed rent payment is recognized as realized operating revenue",
          source: "payment_record",
          sourceId: payment.id
        });
        continue;
      }

      if (isPenaltyRevenue(payment.billType)) {
        const amount = positiveAmount(payment.amount);
        penaltyRevenue += amount;
        recognizedPaymentCount += 1;
        evidence.push({
          amount,
          reason: "confirmed damage or other payment is recognized as realized operating revenue",
          source: "payment_record",
          sourceId: payment.id
        });
        continue;
      }

      ignoredRevenue += positiveAmount(payment.amount);
    }

    const writeOffImpact = writeOffAdjustments
      .filter((adjustment) => adjustment.vehicleId === vehicleId)
      .reduce((total, adjustment) => total - positiveAmount(adjustment.amount), 0);

    return {
      depositExcludedRevenue: roundMoney(depositExcludedRevenue),
      evidence,
      ignoredRevenue: roundMoney(ignoredRevenue),
      leaseRevenue: roundMoney(leaseRevenue),
      penaltyRevenue: roundMoney(penaltyRevenue),
      recognizedPaymentCount,
      unassignedRevenue: roundMoney(unassignedRevenue),
      warnings: [...warnings].sort(),
      writeOffImpact: roundMoney(writeOffImpact)
    };
  }
}

function isRealizedInPeriod(payment: EconomicPaymentRecord, from: Date, to: Date) {
  return payment.paymentStatus === PaymentStatus.CONFIRMED && Boolean(payment.receivedAt) && payment.receivedAt! >= from && payment.receivedAt! <= to;
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
