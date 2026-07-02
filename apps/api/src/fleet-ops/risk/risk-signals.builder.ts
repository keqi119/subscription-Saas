import { PaymentStatus, VehicleConditionItemResult, VehicleConditionItemSeverity, VehicleConditionReportStatus } from "@prisma/client";

import type { FleetKpiVehicleResult } from "../economics/economics.types";
import {
  RiskSignalCode,
  RiskSignalSeverity,
  type FleetRiskInput,
  type RiskExposure,
  type RiskSignal,
  type RiskTimelineDay
} from "./risk.types";

export class RiskSignalsBuilder {
  buildVehicleSignals(vehicleId: string, input: FleetRiskInput, kpi: FleetKpiVehicleResult, exposure: RiskExposure): RiskSignal[] {
    const timeline = input.timelines[vehicleId] ?? [];
    const signals: RiskSignal[] = [];

    if (exposure.overdueAmount > 0) {
      signals.push(signal(vehicleId, RiskSignalCode.OVERDUE_SIGNAL, "Vehicle has overdue unpaid receivables.", exposure.score, RiskSignalSeverity.CRITICAL));
    }

    if (hasTimelineConflict(timeline)) {
      signals.push(signal(vehicleId, RiskSignalCode.TIMELINE_CONFLICT_SIGNAL, "Timeline contains overlapping or conflicting operational events.", 15, RiskSignalSeverity.HIGH));
    }

    if (timeline.some((day) => (day.warnings ?? []).length > 0)) {
      signals.push(signal(vehicleId, RiskSignalCode.TIMELINE_CONFLICT_SIGNAL, "Timeline warnings reduce PR-4 confidence.", 10, RiskSignalSeverity.MEDIUM));
    }

    if (kpi.economics.roi < 0) {
      signals.push(signal(vehicleId, RiskSignalCode.ROI_COLLAPSE_SIGNAL, "Vehicle ROI is negative for the evaluated period.", 45, RiskSignalSeverity.CRITICAL));
    }

    if (kpi.utilization.utilizationRate < 0.35) {
      signals.push(signal(vehicleId, RiskSignalCode.UTILIZATION_DROP_SIGNAL, "Revenue-weighted utilization is below control threshold.", 25, RiskSignalSeverity.HIGH));
    }

    if (hasCriticalConditionReport(vehicleId, input)) {
      signals.push(signal(vehicleId, RiskSignalCode.CONDITION_DEGRADATION_SIGNAL, "Condition report indicates safety-critical degradation.", 25, RiskSignalSeverity.CRITICAL));
    }

    if (hasPaymentInconsistency(vehicleId, input, exposure)) {
      signals.push(signal(vehicleId, RiskSignalCode.PAYMENT_INCONSISTENCY_SIGNAL, "Payment behavior is inconsistent with open receivables.", 20, RiskSignalSeverity.HIGH));
    }

    if ((kpi.warnings ?? []).length > 0 || exposure.warnings.length > 0) {
      signals.push(signal(vehicleId, RiskSignalCode.ECONOMIC_WARNING_SIGNAL, "Economic or exposure warning requires risk review.", 10, RiskSignalSeverity.MEDIUM));
    }

    return signals;
  }
}

export function hasTimelineConflict(timeline: RiskTimelineDay[]) {
  return timeline.some((day) => (day.conflicts?.length ?? 0) > 0 || day.confidence < 60);
}

export function hasCriticalConditionReport(vehicleId: string, input: FleetRiskInput) {
  return input.conditionReports
    .filter((report) => report.vehicleId === vehicleId && report.reportStatus === VehicleConditionReportStatus.PUBLISHED)
    .some((report) =>
      report.items.some(
        (item) =>
          item.severity === VehicleConditionItemSeverity.SAFETY_CRITICAL ||
          (item.affectsSafety === true && item.result === VehicleConditionItemResult.ABNORMAL) ||
          (item.repairRequired === true && item.severity === VehicleConditionItemSeverity.MAJOR)
      )
    );
}

export function hasPaymentInconsistency(vehicleId: string, input: FleetRiskInput, exposure: RiskExposure) {
  const payments = input.paymentRecords.filter((payment) => payment.vehicleId === vehicleId);
  const confirmedPaymentCount = payments.filter((payment) => payment.paymentStatus === PaymentStatus.CONFIRMED).length;

  return exposure.partialPaymentCount > 0 || (exposure.overdueAmount > 0 && confirmedPaymentCount > 1);
}

function signal(
  vehicleId: string,
  code: RiskSignalCode,
  reason: string,
  weight: number,
  severity: RiskSignalSeverity
): RiskSignal {
  return {
    code,
    reason,
    severity,
    vehicleId,
    weight
  };
}
