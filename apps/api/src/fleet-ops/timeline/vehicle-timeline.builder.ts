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
  TIMELINE_CURRENT_STATUS_PROJECTED_WARNING,
  TimelineEventSource,
  TimelineState,
  type TimelineEvent,
  type VehicleTimelineConditionReportInput,
  type VehicleTimelineRawInput,
  type VehicleTimelineServiceCaseInput
} from "./vehicle-timeline.types";

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

export class VehicleTimelineBuilder {
  buildEvents(input: VehicleTimelineRawInput): TimelineEvent[] {
    const events = [
      ...this.buildVehicleFallbackEvents(input),
      ...this.buildLeaseEvents(input),
      ...this.buildOrderEvents(input),
      ...this.buildServiceCaseEvents(input),
      ...this.buildConditionReportEvents(input)
    ];

    return events.sort(compareTimelineEvents);
  }

  private buildVehicleFallbackEvents(input: VehicleTimelineRawInput): TimelineEvent[] {
    if (!input.vehicle) {
      return [
        event({
          baseConfidence: 20,
          endDate: toDateKey(input.to),
          eventId: `vehicle:${input.vehicleId}:missing`,
          isFallback: true,
          missingEndTimestamp: true,
          missingStartTimestamp: true,
          source: TimelineEventSource.VEHICLE,
          sourceId: input.vehicleId,
          startDate: toDateKey(input.from),
          state: TimelineState.UNKNOWN,
          timestamp: null,
          warnings: ["Vehicle metadata is missing."]
        })
      ];
    }

    const state = vehicleStatusToFallbackState(input.vehicle.status);
    const fallbackStart = input.vehicle.deletedAt && input.vehicle.updatedAt ? input.vehicle.updatedAt : input.from;

    return [
      event({
        baseConfidence: state === TimelineState.UNKNOWN ? 35 : 50,
        endDate: toDateKey(input.to),
        eventId: `vehicle:${input.vehicle.id}`,
        isFallback: true,
        missingEndTimestamp: false,
        missingStartTimestamp: false,
        source: TimelineEventSource.VEHICLE,
        sourceId: input.vehicle.id,
        startDate: toDateKey(fallbackStart),
        state,
        timestamp: input.vehicle.updatedAt ?? input.vehicle.createdAt ?? null,
        warnings: [
          TIMELINE_CURRENT_STATUS_PROJECTED_WARNING,
          ...(input.vehicle.deletedAt ? ["Vehicle is inactive or deleted in this period."] : [])
        ]
      })
    ];
  }

  private buildLeaseEvents(input: VehicleTimelineRawInput): TimelineEvent[] {
    return input.leases
      .filter((lease) => !lease.deletedAt && lease.status === LeaseStatus.ACTIVE)
      .map((lease) => {
        const start = lease.order?.startDate ?? lease.activatedAt ?? lease.createdAt ?? input.from;
        const end = lease.order?.endDate ?? lease.order?.actualReturnAt ?? input.to;
        const missingStartTimestamp = !lease.order?.startDate && !lease.activatedAt && !lease.createdAt;
        const missingEndTimestamp = !lease.order?.endDate && !lease.order?.actualReturnAt;

        return event({
          baseConfidence: 95,
          endDate: toDateKey(end),
          eventId: `lease:${lease.id}`,
          isFallback: false,
          missingEndTimestamp,
          missingStartTimestamp,
          source: TimelineEventSource.LEASE,
          sourceId: lease.id,
          startDate: toDateKey(start),
          state: TimelineState.LEASED,
          timestamp: lease.activatedAt ?? lease.updatedAt ?? lease.createdAt ?? null,
          warnings: [
            ...(missingStartTimestamp ? [`Event lease:${lease.id} is missing a start timestamp.`] : []),
            ...(missingEndTimestamp ? [`Event lease:${lease.id} is missing an end timestamp.`] : [])
          ]
        });
      });
  }

  private buildOrderEvents(input: VehicleTimelineRawInput): TimelineEvent[] {
    return input.orders
      .filter((order) => !order.deletedAt)
      .filter((order) => order.vehicleId === input.vehicleId)
      .filter((order) => isOrderLocked(order.orderStatus))
      .map((order) => {
        const start = order.createdAt ?? order.updatedAt ?? input.from;
        const end = order.actualDeliveryAt ?? input.to;
        const missingStartTimestamp = !order.createdAt && !order.updatedAt;
        const missingEndTimestamp = !order.actualDeliveryAt;

        return event({
          baseConfidence: 75,
          endDate: toDateKey(end),
          eventId: `order:${order.id}`,
          isFallback: false,
          missingEndTimestamp,
          missingStartTimestamp,
          source: TimelineEventSource.ORDER,
          sourceId: order.id,
          startDate: toDateKey(start),
          state: TimelineState.RESERVED,
          timestamp: order.updatedAt ?? order.createdAt ?? null,
          warnings: [
            ...(missingStartTimestamp ? [`Event order:${order.id} is missing a start timestamp.`] : []),
            ...(missingEndTimestamp ? [`Event order:${order.id} is missing an end timestamp.`] : [])
          ]
        });
      });
  }

  private buildServiceCaseEvents(input: VehicleTimelineRawInput): TimelineEvent[] {
    return input.serviceCases
      .filter((serviceCase) => !serviceCase.deletedAt)
      .filter(isServiceCaseTimelineBlocking)
      .map((serviceCase) => {
        const start = serviceCase.occurredAt ?? serviceCase.createdAt ?? serviceCase.updatedAt ?? input.from;
        const end = serviceCase.resolvedAt ?? serviceCase.closedAt ?? serviceCase.cancelledAt ?? input.to;
        const missingStartTimestamp = !serviceCase.occurredAt && !serviceCase.createdAt && !serviceCase.updatedAt;
        const missingEndTimestamp = !serviceCase.resolvedAt && !serviceCase.closedAt && !serviceCase.cancelledAt;

        return event({
          baseConfidence: serviceCase.priority === ServiceCasePriority.URGENT ? 90 : 80,
          endDate: toDateKey(end),
          eventId: `service_case:${serviceCase.id}`,
          isFallback: false,
          missingEndTimestamp,
          missingStartTimestamp,
          source: TimelineEventSource.SERVICE_CASE,
          sourceId: serviceCase.id,
          startDate: toDateKey(start),
          state: TimelineState.SERVICE_BLOCKED,
          timestamp: serviceCase.updatedAt ?? serviceCase.occurredAt ?? serviceCase.createdAt ?? null,
          warnings: [
            ...(missingStartTimestamp ? [`Event service_case:${serviceCase.id} is missing a start timestamp.`] : []),
            ...(missingEndTimestamp && !isOpenServiceCase(serviceCase.caseStatus)
              ? [`Event service_case:${serviceCase.id} is missing an end timestamp.`]
              : [])
          ]
        });
      });
  }

  private buildConditionReportEvents(input: VehicleTimelineRawInput): TimelineEvent[] {
    return input.conditionReports
      .filter((report) => !report.deletedAt && report.reportStatus === VehicleConditionReportStatus.PUBLISHED)
      .flatMap((report) => {
        const state = conditionReportTimelineState(report);
        if (!state) {
          return [];
        }

        const timestamp = report.publishedAt ?? report.inspectionDate ?? report.updatedAt ?? report.createdAt ?? null;
        const missingStartTimestamp = !timestamp;

        return [
          event({
            baseConfidence: state === TimelineState.SERVICE_BLOCKED ? 70 : 65,
            endDate: toDateKey(timestamp ?? input.from),
            eventId: `condition_report:${report.id}`,
            isFallback: false,
            missingEndTimestamp: false,
            missingStartTimestamp,
            source: TimelineEventSource.CONDITION_REPORT,
            sourceId: report.id,
            startDate: toDateKey(timestamp ?? input.from),
            state,
            timestamp,
            warnings: missingStartTimestamp ? [`Event condition_report:${report.id} is missing a start timestamp.`] : []
          })
        ];
      });
  }
}

export function toDateKey(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

export function dateKeyToUtcDate(dateKey: string) {
  return new Date(`${dateKey}T00:00:00.000Z`);
}

export function compareDateKeys(left: string, right: string) {
  return left.localeCompare(right);
}

export function compareTimelineEvents(left: TimelineEvent, right: TimelineEvent) {
  const startCompare = compareDateKeys(left.startDate, right.startDate);
  if (startCompare !== 0) {
    return startCompare;
  }

  return left.eventId.localeCompare(right.eventId);
}

function event(input: TimelineEvent): TimelineEvent {
  return input;
}

function vehicleStatusToFallbackState(status: VehicleStatus) {
  if (status === VehicleStatus.AVAILABLE) {
    return TimelineState.AVAILABLE;
  }

  if (status === VehicleStatus.LEASED || status === VehicleStatus.RENTED) {
    return TimelineState.LEASED;
  }

  if (status === VehicleStatus.REVIEW_RESERVED || status === VehicleStatus.RESERVED) {
    return TimelineState.RESERVED;
  }

  if (status === VehicleStatus.MAINTENANCE) {
    return TimelineState.MAINTENANCE;
  }

  return TimelineState.UNKNOWN;
}

function isOrderLocked(status: OrderStatus) {
  return ORDER_LOCKED_STATUSES.includes(status);
}

function isOpenServiceCase(status: ServiceCaseStatus) {
  return OPEN_SERVICE_CASE_STATUSES.includes(status);
}

function isServiceCaseTimelineBlocking(serviceCase: VehicleTimelineServiceCaseInput) {
  if (!isOpenServiceCase(serviceCase.caseStatus) && !serviceCase.resolvedAt && !serviceCase.closedAt && !serviceCase.cancelledAt) {
    return false;
  }

  if (serviceCase.priority === ServiceCasePriority.HIGH || serviceCase.priority === ServiceCasePriority.URGENT) {
    return true;
  }

  return serviceCase.caseType === ServiceCaseType.ACCIDENT_REPORT || serviceCase.caseType === ServiceCaseType.RESCUE_REQUEST;
}

function conditionReportTimelineState(report: VehicleTimelineConditionReportInput) {
  const hasCriticalFlag = report.hasFireDamage || report.hasFloodDamage || report.hasMajorAccident || report.hasStructuralDamage;
  const items = report.items.filter((item) => !item.deletedAt);
  const hasCriticalItem = items.some(
    (item) =>
      item.affectsSafety ||
      item.severity === VehicleConditionItemSeverity.SAFETY_CRITICAL ||
      (item.severity === VehicleConditionItemSeverity.MAJOR && item.result === VehicleConditionItemResult.ABNORMAL)
  );

  if (hasCriticalFlag || hasCriticalItem) {
    return TimelineState.SERVICE_BLOCKED;
  }

  const hasMaintenanceItem = items.some(
    (item) =>
      item.repairRequired ||
      item.result === VehicleConditionItemResult.ATTENTION ||
      item.severity === VehicleConditionItemSeverity.MODERATE ||
      item.severity === VehicleConditionItemSeverity.MAJOR
  );

  return hasMaintenanceItem ? TimelineState.MAINTENANCE : null;
}
