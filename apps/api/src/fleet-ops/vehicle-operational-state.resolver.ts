import {
  MINIMUM_RESOLUTION_CONFIDENCE,
  isActiveLeaseStatus,
  isActiveOrderStatus,
  isBlockingConditionReport,
  isBlockingServiceCase,
  isInactiveVehicleStatus,
  isOrderLockedStatus,
  isRelevantConditionReport,
  isVehicleAvailableStatus,
  isVehicleLeasedStatus,
  isVehicleOrderLockedStatus,
  isVehiclePreparationStatus,
  isVehicleServiceBlockedStatus,
  priorityForState,
  reportFreshnessDate,
  serviceCaseFreshnessDate
} from "./vehicle-operational-state.rules";
import { calculateVehicleOperationalStateConfidence } from "./vehicle-operational-state.confidence";
import {
  VehicleComputedOperationalState,
  VehicleOperationalConfidenceBand,
  type VehicleOperationalStateConditionReportSnapshot,
  type VehicleOperationalStateConflict,
  type VehicleOperationalStateEvidence,
  type VehicleOperationalStateInput,
  type VehicleOperationalStateResult,
  type VehicleOperationalStateSignal
} from "./vehicle-operational-state.types";

export class VehicleOperationalStateResolver {
  resolve(input: VehicleOperationalStateInput): VehicleOperationalStateResult {
    const asOf = input.asOf ?? new Date();
    const signals = buildSignals(input);
    const candidates = sortSignals(signals);

    for (const candidate of candidates) {
      const confidence = calculateVehicleOperationalStateConfidence({ asOf, candidate, signals });
      if (confidence.score >= MINIMUM_RESOLUTION_CONFIDENCE) {
        const supportingSignals = sortSignals(
          signals.filter((signal) => signal.state === candidate.state && signal !== candidate)
        );
        const conflictingSignals = sortSignals(signals.filter((signal) => signal.state !== candidate.state));

        return {
          asOf,
          computedState: candidate.state,
          confidenceBand: confidence.band,
          confidenceScore: confidence.score,
          conflicts: conflictingSignals.map(toConflict),
          primaryEvidence: candidate.evidence,
          supportingEvidence: supportingSignals.map((signal) => signal.evidence),
          vehicleId: input.vehicle?.id ?? null,
          warnings: buildWarnings(input, candidate, conflictingSignals, confidence.penalties)
        };
      }
    }

    return unknownResult(input, asOf, signals);
  }
}

function buildSignals(input: VehicleOperationalStateInput) {
  return sortSignals([
    ...vehicleSignals(input),
    ...leaseSignals(input),
    ...orderSignals(input),
    ...serviceCaseSignals(input),
    ...conditionReportSignals(input)
  ]);
}

function vehicleSignals(input: VehicleOperationalStateInput): VehicleOperationalStateSignal[] {
  const vehicle = input.vehicle;
  if (!vehicle) {
    return [];
  }

  if (vehicle.deletedAt || isInactiveVehicleStatus(vehicle.status)) {
    return [
      signal({
        evidence: {
          fields: { deletedAt: vehicle.deletedAt, status: vehicle.status, vehicleNo: vehicle.vehicleNo },
          reason: vehicle.deletedAt ? "Vehicle is soft-deleted." : "Vehicle status is retired.",
          recordedAt: vehicle.updatedAt ?? vehicle.createdAt ?? null,
          source: "VEHICLE",
          sourceId: vehicle.id
        },
        freshnessDate: vehicle.updatedAt ?? vehicle.createdAt ?? null,
        source: "VEHICLE",
        sourceId: vehicle.id,
        state: VehicleComputedOperationalState.RETIRED_OR_INACTIVE
      })
    ];
  }

  if (isVehicleLeasedStatus(vehicle.status)) {
    return [
      signal({
        evidence: {
          fields: { status: vehicle.status, vehicleNo: vehicle.vehicleNo },
          reason: "Vehicle status indicates leased or rented usage.",
          recordedAt: vehicle.updatedAt ?? vehicle.createdAt ?? null,
          source: "VEHICLE",
          sourceId: vehicle.id
        },
        freshnessDate: vehicle.updatedAt ?? vehicle.createdAt ?? null,
        source: "VEHICLE",
        sourceId: vehicle.id,
        state: VehicleComputedOperationalState.LEASED_ACTIVE
      })
    ];
  }

  if (isVehicleServiceBlockedStatus(vehicle.status)) {
    return [
      signal({
        evidence: {
          fields: { status: vehicle.status, vehicleNo: vehicle.vehicleNo },
          reason: "Vehicle status indicates maintenance.",
          recordedAt: vehicle.updatedAt ?? vehicle.createdAt ?? null,
          source: "VEHICLE",
          sourceId: vehicle.id
        },
        freshnessDate: vehicle.updatedAt ?? vehicle.createdAt ?? null,
        source: "VEHICLE",
        sourceId: vehicle.id,
        state: VehicleComputedOperationalState.SERVICE_BLOCKED
      })
    ];
  }

  if (isVehicleOrderLockedStatus(vehicle.status)) {
    return [
      signal({
        evidence: {
          fields: { status: vehicle.status, vehicleNo: vehicle.vehicleNo },
          reason: "Vehicle status indicates reserved or review-reserved.",
          recordedAt: vehicle.updatedAt ?? vehicle.createdAt ?? null,
          source: "VEHICLE",
          sourceId: vehicle.id
        },
        freshnessDate: vehicle.updatedAt ?? vehicle.createdAt ?? null,
        source: "VEHICLE",
        sourceId: vehicle.id,
        state: VehicleComputedOperationalState.RESERVED_OR_ORDER_LOCKED
      })
    ];
  }

  if (isVehicleAvailableStatus(vehicle.status)) {
    return [
      signal({
        evidence: {
          fields: { status: vehicle.status, vehicleNo: vehicle.vehicleNo },
          reason: "Vehicle status is available.",
          recordedAt: vehicle.updatedAt ?? vehicle.createdAt ?? null,
          source: "VEHICLE",
          sourceId: vehicle.id
        },
        freshnessDate: vehicle.updatedAt ?? vehicle.createdAt ?? null,
        source: "VEHICLE",
        sourceId: vehicle.id,
        state: VehicleComputedOperationalState.AVAILABLE
      })
    ];
  }

  if (isVehiclePreparationStatus(vehicle.status)) {
    return [
      signal({
        evidence: {
          fields: { status: vehicle.status, vehicleNo: vehicle.vehicleNo },
          reason: "Vehicle status indicates preparation.",
          recordedAt: vehicle.updatedAt ?? vehicle.createdAt ?? null,
          source: "VEHICLE",
          sourceId: vehicle.id
        },
        freshnessDate: vehicle.updatedAt ?? vehicle.createdAt ?? null,
        source: "VEHICLE",
        sourceId: vehicle.id,
        state: VehicleComputedOperationalState.PREPARATION
      })
    ];
  }

  return [];
}

function leaseSignals(input: VehicleOperationalStateInput): VehicleOperationalStateSignal[] {
  return input.leases
    .filter((lease) => !lease.deletedAt && isActiveLeaseStatus(lease.status))
    .map((lease) =>
      signal({
        evidence: {
          fields: { activatedAt: lease.activatedAt, orderId: lease.orderId, status: lease.status },
          reason: "Lease status is active.",
          recordedAt: lease.activatedAt ?? lease.updatedAt ?? lease.createdAt ?? null,
          source: "LEASE",
          sourceId: lease.id
        },
        freshnessDate: lease.activatedAt ?? lease.updatedAt ?? lease.createdAt ?? null,
        source: "LEASE",
        sourceId: lease.id,
        state: VehicleComputedOperationalState.LEASED_ACTIVE
      })
    );
}

function orderSignals(input: VehicleOperationalStateInput): VehicleOperationalStateSignal[] {
  return input.orders
    .filter((order) => !order.deletedAt)
    .flatMap((order) => {
      if (isActiveOrderStatus(order.orderStatus)) {
        return [
          signal({
            evidence: {
              fields: { orderNo: order.orderNo, orderStatus: order.orderStatus, vehicleId: order.vehicleId },
              reason: "Order status is active.",
              recordedAt: order.actualDeliveryAt ?? order.updatedAt ?? order.createdAt ?? null,
              source: "ORDER",
              sourceId: order.id
            },
            freshnessDate: order.actualDeliveryAt ?? order.updatedAt ?? order.createdAt ?? null,
            source: "ORDER",
            sourceId: order.id,
            state: VehicleComputedOperationalState.LEASED_ACTIVE
          })
        ];
      }

      if (isOrderLockedStatus(order.orderStatus)) {
        return [
          signal({
            evidence: {
              fields: { orderNo: order.orderNo, orderStatus: order.orderStatus, vehicleId: order.vehicleId },
              reason: "Order status locks or reserves the vehicle.",
              recordedAt: order.updatedAt ?? order.createdAt ?? null,
              source: "ORDER",
              sourceId: order.id
            },
            freshnessDate: order.updatedAt ?? order.createdAt ?? null,
            source: "ORDER",
            sourceId: order.id,
            state: VehicleComputedOperationalState.RESERVED_OR_ORDER_LOCKED
          })
        ];
      }

      return [];
    });
}

function serviceCaseSignals(input: VehicleOperationalStateInput): VehicleOperationalStateSignal[] {
  return input.serviceCases
    .filter((serviceCase) => !serviceCase.deletedAt && isBlockingServiceCase(serviceCase))
    .map((serviceCase) =>
      signal({
        evidence: {
          fields: {
            caseNo: serviceCase.caseNo,
            caseStatus: serviceCase.caseStatus,
            caseType: serviceCase.caseType,
            priority: serviceCase.priority
          },
          reason: "Open service case blocks normal vehicle availability.",
          recordedAt: serviceCaseFreshnessDate(serviceCase),
          source: "SERVICE_CASE",
          sourceId: serviceCase.id
        },
        freshnessDate: serviceCaseFreshnessDate(serviceCase),
        source: "SERVICE_CASE",
        sourceId: serviceCase.id,
        state: VehicleComputedOperationalState.SERVICE_BLOCKED
      })
    );
}

function conditionReportSignals(input: VehicleOperationalStateInput): VehicleOperationalStateSignal[] {
  const latestReport = latestRelevantConditionReport(input.conditionReports);
  if (!latestReport || !isBlockingConditionReport(latestReport)) {
    return [];
  }

  return [
    signal({
      evidence: {
        fields: {
          hasFireDamage: latestReport.hasFireDamage,
          hasFloodDamage: latestReport.hasFloodDamage,
          hasMajorAccident: latestReport.hasMajorAccident,
          hasStructuralDamage: latestReport.hasStructuralDamage,
          reportNo: latestReport.reportNo,
          reportStatus: latestReport.reportStatus
        },
        reason: "Latest relevant condition report blocks normal vehicle availability.",
        recordedAt: reportFreshnessDate(latestReport),
        source: "CONDITION_REPORT",
        sourceId: latestReport.id
      },
      freshnessDate: reportFreshnessDate(latestReport),
      source: "CONDITION_REPORT",
      sourceId: latestReport.id,
      state: VehicleComputedOperationalState.CONDITION_BLOCKED
    })
  ];
}

function latestRelevantConditionReport(reports: VehicleOperationalStateConditionReportSnapshot[]) {
  return [...reports]
    .filter(isRelevantConditionReport)
    .sort((left, right) => reportSortTime(right) - reportSortTime(left))[0];
}

function reportSortTime(report: VehicleOperationalStateConditionReportSnapshot) {
  return reportFreshnessDate(report)?.getTime() ?? 0;
}

function signal(input: Omit<VehicleOperationalStateSignal, "direct" | "priority">): VehicleOperationalStateSignal {
  return {
    ...input,
    direct: true,
    priority: priorityForState(input.state)
  };
}

function sortSignals(signals: VehicleOperationalStateSignal[]) {
  return [...signals].sort((left, right) => {
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }

    const sourceCompare = left.source.localeCompare(right.source);
    if (sourceCompare !== 0) {
      return sourceCompare;
    }

    return (left.sourceId ?? "").localeCompare(right.sourceId ?? "");
  });
}

function toConflict(signal: VehicleOperationalStateSignal): VehicleOperationalStateConflict {
  return {
    priority: signal.priority,
    reason: signal.evidence.reason,
    source: signal.source,
    sourceId: signal.sourceId,
    state: signal.state
  };
}

function buildWarnings(
  input: VehicleOperationalStateInput,
  candidate: VehicleOperationalStateSignal,
  conflicts: VehicleOperationalStateSignal[],
  confidencePenalties: string[]
) {
  const warnings = [...confidencePenalties];
  const hasActiveUsageConflict = conflicts.some((signal) => signal.state === VehicleComputedOperationalState.LEASED_ACTIVE);
  const hasInactiveWinner = candidate.state === VehicleComputedOperationalState.RETIRED_OR_INACTIVE;

  if (hasInactiveWinner && hasActiveUsageConflict) {
    warnings.push("Vehicle inactive signal conflicts with active lease or order evidence.");
  }

  const activeLikeOrders = input.orders.filter((order) => !order.deletedAt && (isActiveOrderStatus(order.orderStatus) || isOrderLockedStatus(order.orderStatus)));
  if (activeLikeOrders.length > 1) {
    warnings.push("Multiple active-looking orders reference the same vehicle.");
  }

  return uniqueStrings(warnings);
}

function unknownResult(
  input: VehicleOperationalStateInput,
  asOf: Date,
  signals: VehicleOperationalStateSignal[]
): VehicleOperationalStateResult {
  const evidence: VehicleOperationalStateEvidence = {
    fields: { signalCount: signals.length },
    reason: signals.length === 0 ? "No usable source signal." : "No source signal reached the confidence threshold.",
    recordedAt: asOf,
    source: "SYSTEM"
  };

  return {
    asOf,
    computedState: VehicleComputedOperationalState.UNKNOWN,
    confidenceBand: VehicleOperationalConfidenceBand.UNKNOWN,
    confidenceScore: 0,
    conflicts: sortSignals(signals).map(toConflict),
    primaryEvidence: evidence,
    supportingEvidence: [],
    vehicleId: input.vehicle?.id ?? null,
    warnings: [evidence.reason]
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
