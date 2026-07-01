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
import { describe, expect, it, vi } from "vitest";

import { VehicleTimelineBuilder } from "../src/fleet-ops/timeline/vehicle-timeline.builder";
import { VehicleTimelineCalculator } from "../src/fleet-ops/timeline/vehicle-timeline.calculator";
import { VehicleTimelineService } from "../src/fleet-ops/timeline/vehicle-timeline.service";
import { TimelineState, type VehicleTimelineRawInput } from "../src/fleet-ops/timeline/vehicle-timeline.types";

const from = new Date("2026-07-01T00:00:00.000Z");
const to = new Date("2026-07-05T00:00:00.000Z");

describe("VehicleTimelineCalculator", () => {
  it("builds full daily coverage and applies per-day priority with conflicts surfaced", () => {
    const timeline = buildTimeline({
      leases: [
        lease({
          order: order({ endDate: new Date("2026-07-03T00:00:00.000Z"), startDate: from })
        })
      ],
      orders: [
        order({
          actualDeliveryAt: new Date("2026-07-04T18:00:00.000Z"),
          createdAt: new Date("2026-07-04T00:00:00.000Z"),
          orderStatus: OrderStatus.PENDING_SIGN,
          updatedAt: new Date("2026-07-04T00:00:00.000Z")
        })
      ],
      serviceCases: [
        serviceCase({
          createdAt: new Date("2026-07-02T08:00:00.000Z"),
          resolvedAt: new Date("2026-07-02T18:00:00.000Z")
        })
      ]
    });

    expect(timeline.map((day) => day.date)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
      "2026-07-05"
    ]);
    expect(timeline.map((day) => day.state)).toEqual([
      TimelineState.LEASED,
      TimelineState.SERVICE_BLOCKED,
      TimelineState.LEASED,
      TimelineState.RESERVED,
      TimelineState.AVAILABLE
    ]);
    expect(timeline[1]!.sourceEvents).toEqual([
      "lease:lease-1",
      "service_case:service-case-1",
      "vehicle:vehicle-1"
    ]);
    expect(timeline[1]!.conflicts).toEqual([
      expect.objectContaining({ loserState: TimelineState.LEASED, winnerState: TimelineState.SERVICE_BLOCKED }),
      expect.objectContaining({ loserState: TimelineState.AVAILABLE, winnerState: TimelineState.SERVICE_BLOCKED })
    ]);
    expect(timeline[1]!.confidence).toBeLessThan(90);
  });

  it("uses open lease intervals through range end and penalizes missing end timestamps", () => {
    const timeline = buildTimeline({
      leases: [
        lease({
          order: order({ endDate: null, startDate: from })
        })
      ]
    });

    expect(timeline.every((day) => day.state === TimelineState.LEASED)).toBe(true);
    expect(timeline[4]!.sourceEvents).toEqual(["lease:lease-1", "vehicle:vehicle-1"]);
    expect(timeline[4]!.confidence).toBeLessThan(90);
    expect(timeline[4]!.warnings).toContain("Event lease:lease-1 is missing an end timestamp.");
  });

  it("turns severe condition reports into blocked timeline days", () => {
    const timeline = buildTimeline({
      conditionReports: [
        conditionReport({
          items: [
            conditionItem({
              affectsSafety: true,
              result: VehicleConditionItemResult.ABNORMAL,
              severity: VehicleConditionItemSeverity.SAFETY_CRITICAL
            })
          ],
          publishedAt: new Date("2026-07-03T09:00:00.000Z")
        })
      ]
    });

    expect(timeline[2]!).toMatchObject({
      confidence: expect.any(Number),
      date: "2026-07-03",
      state: TimelineState.SERVICE_BLOCKED
    });
    expect(timeline[2]!.sourceEvents).toEqual(["condition_report:condition-report-1", "vehicle:vehicle-1"]);
  });
});

describe("VehicleTimelineService", () => {
  it("loads listed source entities read-only and returns reproducible timeline", async () => {
    const prisma = createPrismaHarness();
    const service = new VehicleTimelineService(prisma as never);

    const first = await service.getVehicleTimeline("vehicle-1", from, to);
    const second = await service.getVehicleTimeline("vehicle-1", from, to);

    expect(first).toEqual(second);
    expect(first).toHaveLength(5);
    expect(prisma.vehicle.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.lease.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.subscriptionOrder.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.serviceCase.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.vehicleConditionReport.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.vehicle.create).not.toHaveBeenCalled();
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
    expect(prisma.vehicle.delete).not.toHaveBeenCalled();
  });
});

function buildTimeline(input: Partial<VehicleTimelineRawInput>) {
  const builder = new VehicleTimelineBuilder();
  const calculator = new VehicleTimelineCalculator();
  const rawInput: VehicleTimelineRawInput = {
    conditionReports: [],
    from,
    leases: [],
    orders: [],
    serviceCases: [],
    to,
    vehicle: vehicle(),
    vehicleId: "vehicle-1",
    ...input
  };

  return calculator.calculateTimeline(builder.buildEvents(rawInput), rawInput);
}

function vehicle() {
  return {
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    deletedAt: null,
    id: "vehicle-1",
    status: VehicleStatus.AVAILABLE,
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    vehicleNo: "VH-001"
  };
}

function lease(overrides: Partial<VehicleTimelineRawInput["leases"][number]> = {}) {
  return {
    activatedAt: new Date("2026-07-01T08:00:00.000Z"),
    createdAt: new Date("2026-07-01T08:00:00.000Z"),
    deletedAt: null,
    id: "lease-1",
    order: order({ orderStatus: OrderStatus.ACTIVE }),
    orderId: "order-1",
    status: LeaseStatus.ACTIVE,
    updatedAt: new Date("2026-07-01T08:00:00.000Z"),
    ...overrides
  };
}

function order(overrides: Partial<VehicleTimelineRawInput["orders"][number]> = {}) {
  return {
    actualDeliveryAt: null,
    actualReturnAt: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    deletedAt: null,
    endDate: new Date("2026-07-01T00:00:00.000Z"),
    id: "order-1",
    orderNo: "ORD-001",
    orderStatus: OrderStatus.PENDING_SIGN,
    startDate: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function serviceCase(overrides: Partial<VehicleTimelineRawInput["serviceCases"][number]> = {}) {
  return {
    cancelledAt: null,
    caseNo: "SC-001",
    caseStatus: ServiceCaseStatus.IN_PROGRESS,
    caseType: ServiceCaseType.RESCUE_REQUEST,
    closedAt: null,
    createdAt: new Date("2026-07-02T08:00:00.000Z"),
    deletedAt: null,
    id: "service-case-1",
    occurredAt: new Date("2026-07-02T08:00:00.000Z"),
    priority: ServiceCasePriority.HIGH,
    resolvedAt: null,
    updatedAt: new Date("2026-07-02T08:00:00.000Z"),
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function conditionReport(overrides: Partial<VehicleTimelineRawInput["conditionReports"][number]> = {}) {
  return {
    archivedAt: null,
    createdAt: new Date("2026-07-03T09:00:00.000Z"),
    customerVisible: true,
    deletedAt: null,
    hasFireDamage: false,
    hasFloodDamage: false,
    hasMajorAccident: false,
    hasStructuralDamage: false,
    id: "condition-report-1",
    inspectionDate: new Date("2026-07-03T00:00:00.000Z"),
    items: [],
    publishedAt: new Date("2026-07-03T09:00:00.000Z"),
    reportNo: "VCR-001",
    reportStatus: VehicleConditionReportStatus.PUBLISHED,
    safetyConclusion: null,
    updatedAt: new Date("2026-07-03T09:00:00.000Z"),
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function conditionItem(overrides: Partial<VehicleTimelineRawInput["conditionReports"][number]["items"][number]> = {}) {
  return {
    affectsSafety: false,
    deletedAt: null,
    id: "condition-item-1",
    repairRequired: false,
    result: VehicleConditionItemResult.NORMAL,
    severity: VehicleConditionItemSeverity.MINOR,
    ...overrides
  };
}

function createPrismaHarness() {
  return {
    lease: {
      findMany: vi.fn(async () => [lease()])
    },
    serviceCase: {
      findMany: vi.fn(async () => [serviceCase()])
    },
    subscriptionOrder: {
      findMany: vi.fn(async () => [order()])
    },
    vehicle: {
      create: vi.fn(),
      delete: vi.fn(),
      findUnique: vi.fn(async () => vehicle()),
      update: vi.fn()
    },
    vehicleConditionReport: {
      findMany: vi.fn(async () => [conditionReport()])
    }
  };
}
