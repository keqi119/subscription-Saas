import {
  LeaseStatus,
  OrderStatus,
  ServiceCasePriority,
  ServiceCaseStatus,
  ServiceCaseType,
  VehicleConditionItemResult,
  VehicleConditionItemSeverity,
  VehicleConditionReportStatus,
  VehicleStatus
} from "@prisma/client";

import {
  VehicleComputedOperationalState,
  type VehicleOperationalStateConditionReportSnapshot,
  type VehicleOperationalStateServiceCaseSnapshot,
  type VehicleOperationalStateSource
} from "./vehicle-operational-state.types";

export const MINIMUM_RESOLUTION_CONFIDENCE = 40;

const ORDER_LOCKED_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PENDING_REVIEW,
  OrderStatus.PENDING_CUSTOMER_CONFIRMATION,
  OrderStatus.PENDING_CONTRACT,
  OrderStatus.PENDING_SIGN,
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PENDING_VEHICLE,
  OrderStatus.PENDING_DELIVERY
];

const OPEN_SERVICE_CASE_STATUSES: readonly ServiceCaseStatus[] = [
  ServiceCaseStatus.SUBMITTED,
  ServiceCaseStatus.ACCEPTED,
  ServiceCaseStatus.IN_PROGRESS,
  ServiceCaseStatus.WAITING_CUSTOMER
];

const BLOCKING_SERVICE_CASE_PRIORITIES: readonly ServiceCasePriority[] = [
  ServiceCasePriority.HIGH,
  ServiceCasePriority.URGENT
];

export const VEHICLE_OPERATIONAL_STATE_PRIORITY: Record<VehicleComputedOperationalState, number> = {
  [VehicleComputedOperationalState.RETIRED_OR_INACTIVE]: 100,
  [VehicleComputedOperationalState.OPERATIONALLY_RESTRICTED]: 95,
  [VehicleComputedOperationalState.LEASED_ACTIVE]: 90,
  [VehicleComputedOperationalState.SERVICE_BLOCKED]: 80,
  [VehicleComputedOperationalState.CONDITION_BLOCKED]: 70,
  [VehicleComputedOperationalState.RESERVED_OR_ORDER_LOCKED]: 60,
  [VehicleComputedOperationalState.AVAILABLE]: 50,
  [VehicleComputedOperationalState.PREPARATION]: 40,
  [VehicleComputedOperationalState.UNKNOWN]: 0
};

export const VEHICLE_OPERATIONAL_SOURCE_BASE_SCORE: Record<VehicleOperationalStateSource, number> = {
  CONDITION_REPORT: 20,
  LEASE: 30,
  OPERATIONAL_RESTRICTION: 45,
  ORDER: 25,
  SERVICE_CASE: 20,
  SYSTEM: 0,
  VEHICLE: 45
};

export function priorityForState(state: VehicleComputedOperationalState) {
  return VEHICLE_OPERATIONAL_STATE_PRIORITY[state];
}

export function isInactiveVehicleStatus(status: VehicleStatus) {
  return status === VehicleStatus.RETIRED;
}

export function isVehiclePreparationStatus(status: VehicleStatus) {
  return status === VehicleStatus.DRAFT || status === VehicleStatus.IN_PREPARATION;
}

export function isVehicleAvailableStatus(status: VehicleStatus) {
  return status === VehicleStatus.AVAILABLE;
}

export function isVehicleOrderLockedStatus(status: VehicleStatus) {
  return status === VehicleStatus.REVIEW_RESERVED || status === VehicleStatus.RESERVED;
}

export function isVehicleLeasedStatus(status: VehicleStatus) {
  return status === VehicleStatus.LEASED || status === VehicleStatus.RENTED;
}

export function isVehicleServiceBlockedStatus(status: VehicleStatus) {
  return status === VehicleStatus.MAINTENANCE;
}

export function isActiveLeaseStatus(status: LeaseStatus) {
  return status === LeaseStatus.ACTIVE;
}

export function isActiveOrderStatus(status: OrderStatus) {
  return status === OrderStatus.ACTIVE;
}

export function isOrderLockedStatus(status: OrderStatus) {
  return ORDER_LOCKED_STATUSES.includes(status);
}

export function isOpenServiceCase(serviceCase: VehicleOperationalStateServiceCaseSnapshot) {
  return OPEN_SERVICE_CASE_STATUSES.includes(serviceCase.caseStatus);
}

export function isBlockingServiceCase(serviceCase: VehicleOperationalStateServiceCaseSnapshot) {
  if (!isOpenServiceCase(serviceCase)) {
    return false;
  }

  if (BLOCKING_SERVICE_CASE_PRIORITIES.includes(serviceCase.priority)) {
    return true;
  }

  return serviceCase.caseType === ServiceCaseType.ACCIDENT_REPORT || serviceCase.caseType === ServiceCaseType.RESCUE_REQUEST;
}

export function isRelevantConditionReport(report: VehicleOperationalStateConditionReportSnapshot) {
  return !report.deletedAt && report.reportStatus === VehicleConditionReportStatus.PUBLISHED;
}

export function isBlockingConditionReport(report: VehicleOperationalStateConditionReportSnapshot) {
  if (!isRelevantConditionReport(report)) {
    return false;
  }

  if (report.hasMajorAccident || report.hasFloodDamage || report.hasFireDamage || report.hasStructuralDamage) {
    return true;
  }

  return (report.items ?? []).some((item) => {
    if (item.deletedAt) {
      return false;
    }

    const severeItem =
      item.severity === VehicleConditionItemSeverity.SAFETY_CRITICAL ||
      (item.severity === VehicleConditionItemSeverity.MAJOR && item.result === VehicleConditionItemResult.ABNORMAL);

    return severeItem || Boolean(item.affectsSafety) || Boolean(item.repairRequired);
  });
}

export function reportFreshnessDate(report: VehicleOperationalStateConditionReportSnapshot) {
  return report.publishedAt ?? report.inspectionDate ?? report.updatedAt ?? report.createdAt ?? null;
}

export function serviceCaseFreshnessDate(serviceCase: VehicleOperationalStateServiceCaseSnapshot) {
  return serviceCase.updatedAt ?? serviceCase.occurredAt ?? serviceCase.createdAt ?? null;
}
