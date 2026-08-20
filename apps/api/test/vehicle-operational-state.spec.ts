import {
  LeaseStatus,
  OrderStatus,
  ServiceCasePriority,
  ServiceCaseStatus,
  ServiceCaseType,
  VehicleConditionItemResult,
  VehicleConditionItemSeverity,
  VehicleConditionReportStatus,
  VehicleOperationalRestrictionScope,
  VehicleOperationalRestrictionSeverity,
  VehicleOperationalRestrictionStatus,
  VehicleOperationalRestrictionType,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { VehicleOperationalStateRepository } from "../src/fleet-ops/vehicle-operational-state.repository";
import { VehicleOperationalStateResolver } from "../src/fleet-ops/vehicle-operational-state.resolver";
import {
  VehicleComputedOperationalState,
  type VehicleOperationalStateConditionReportItemSnapshot,
  type VehicleOperationalStateConditionReportSnapshot,
  type VehicleOperationalStateLeaseSnapshot,
  type VehicleOperationalStateOrderSnapshot,
  type VehicleOperationalStateRestrictionSnapshot,
  type VehicleOperationalStateServiceCaseSnapshot,
  type VehicleOperationalStateVehicleSnapshot
} from "../src/fleet-ops/vehicle-operational-state.types";

const asOf = new Date("2026-07-01T10:00:00.000Z");

describe("VehicleOperationalStateResolver", () => {
  it("uses retired vehicle state before conflicting active lease evidence", () => {
    const result = new VehicleOperationalStateResolver().resolve({
      asOf,
      conditionReports: [],
      leases: [lease({ status: LeaseStatus.ACTIVE })],
      orders: [order({ orderStatus: OrderStatus.ACTIVE })],
      operationalRestrictions: [],
      serviceCases: [],
      vehicle: vehicle({ status: VehicleStatus.RETIRED })
    });

    expect(result.computedState).toBe(VehicleComputedOperationalState.RETIRED_OR_INACTIVE);
    expect(result.primaryEvidence.source).toBe("VEHICLE");
    expect(result.conflicts.map((conflict) => conflict.state)).toContain(
      VehicleComputedOperationalState.LEASED_ACTIVE
    );
    expect(result.warnings).toContain(
      "Vehicle inactive signal conflicts with active lease or order evidence."
    );
  });

  it("uses active lease evidence before available vehicle and open service signals", () => {
    const result = new VehicleOperationalStateResolver().resolve({
      asOf,
      conditionReports: [],
      leases: [lease({ status: LeaseStatus.ACTIVE })],
      orders: [],
      operationalRestrictions: [],
      serviceCases: [serviceCase({ priority: ServiceCasePriority.URGENT })],
      vehicle: vehicle({ status: VehicleStatus.AVAILABLE })
    });

    expect(result.computedState).toBe(VehicleComputedOperationalState.LEASED_ACTIVE);
    expect(result.primaryEvidence.source).toBe("LEASE");
    expect(result.supportingEvidence.some((evidence) => evidence.source === "VEHICLE")).toBe(false);
    expect(result.conflicts.map((conflict) => conflict.state)).toContain(
      VehicleComputedOperationalState.SERVICE_BLOCKED
    );
  });

  it("blocks an available vehicle with an open high-priority service case", () => {
    const result = new VehicleOperationalStateResolver().resolve({
      asOf,
      conditionReports: [],
      leases: [],
      orders: [],
      operationalRestrictions: [],
      serviceCases: [serviceCase({ priority: ServiceCasePriority.HIGH })],
      vehicle: vehicle({ status: VehicleStatus.AVAILABLE })
    });

    expect(result.computedState).toBe(VehicleComputedOperationalState.SERVICE_BLOCKED);
    expect(result.primaryEvidence.source).toBe("SERVICE_CASE");
    expect(result.supportingEvidence).toEqual([]);
    expect(result.confidenceScore).toBeGreaterThanOrEqual(65);
  });

  it("blocks availability when the latest published condition report has a safety critical abnormal item", () => {
    const result = new VehicleOperationalStateResolver().resolve({
      asOf,
      conditionReports: [
        conditionReport({
          id: "older-report",
          items: [conditionItem({ result: VehicleConditionItemResult.NORMAL })],
          publishedAt: new Date("2026-06-01T10:00:00.000Z")
        }),
        conditionReport({
          id: "latest-report",
          items: [
            conditionItem({
              affectsSafety: true,
              result: VehicleConditionItemResult.ABNORMAL,
              severity: VehicleConditionItemSeverity.SAFETY_CRITICAL
            })
          ],
          publishedAt: new Date("2026-06-30T10:00:00.000Z")
        })
      ],
      leases: [],
      orders: [],
      operationalRestrictions: [],
      serviceCases: [],
      vehicle: vehicle({ status: VehicleStatus.AVAILABLE })
    });

    expect(result.computedState).toBe(VehicleComputedOperationalState.CONDITION_BLOCKED);
    expect(result.primaryEvidence.source).toBe("CONDITION_REPORT");
    expect(result.primaryEvidence.sourceId).toBe("latest-report");
  });

  it("uses order lock evidence before vehicle availability", () => {
    const result = new VehicleOperationalStateResolver().resolve({
      asOf,
      conditionReports: [],
      leases: [],
      orders: [order({ orderStatus: OrderStatus.PENDING_SIGN })],
      operationalRestrictions: [],
      serviceCases: [],
      vehicle: vehicle({ status: VehicleStatus.AVAILABLE })
    });

    expect(result.computedState).toBe(VehicleComputedOperationalState.RESERVED_OR_ORDER_LOCKED);
    expect(result.primaryEvidence.source).toBe("ORDER");
  });

  it("uses every active blocking operational restriction ahead of heuristic service and condition signals", () => {
    const restrictions = [
      restriction({
        id: "restriction-b",
        restrictionType: VehicleOperationalRestrictionType.LEGAL_HOLD
      }),
      restriction({
        id: "restriction-a",
        restrictionType: VehicleOperationalRestrictionType.MAINTENANCE_OR_ACCIDENT
      })
    ];
    const result = new VehicleOperationalStateResolver().resolve({
      asOf,
      conditionReports: [conditionReport({ hasMajorAccident: true })],
      leases: [],
      operationalRestrictions: restrictions,
      orders: [],
      serviceCases: [serviceCase()],
      vehicle: vehicle()
    });

    expect(result.computedState).toBe(VehicleComputedOperationalState.OPERATIONALLY_RESTRICTED);
    expect(result.primaryEvidence).toMatchObject({
      fields: {
        restrictionType: VehicleOperationalRestrictionType.MAINTENANCE_OR_ACCIDENT,
        scopes: [VehicleOperationalRestrictionScope.ALLOCATION]
      },
      source: "OPERATIONAL_RESTRICTION",
      sourceId: "restriction-a"
    });
    expect(result.supportingEvidence).toEqual([
      expect.objectContaining({ source: "OPERATIONAL_RESTRICTION", sourceId: "restriction-b" })
    ]);
  });

  it("does not turn an advisory restriction into an operational block", () => {
    const result = new VehicleOperationalStateResolver().resolve({
      asOf,
      conditionReports: [],
      leases: [],
      operationalRestrictions: [
        restriction({ severity: VehicleOperationalRestrictionSeverity.ADVISORY })
      ],
      orders: [],
      serviceCases: [],
      vehicle: vehicle()
    });

    expect(result.computedState).toBe(VehicleComputedOperationalState.AVAILABLE);
    expect(result.primaryEvidence.source).toBe("VEHICLE");
  });
});

describe("VehicleOperationalStateRepository", () => {
  it("loads only existing source entities through read methods", async () => {
    const prisma = createPrismaReadHarness();
    const repository = new VehicleOperationalStateRepository(prisma as never);

    const snapshot = await repository.loadVehicleOperationalStateSnapshot("vehicle-1", asOf);

    expect(snapshot.vehicle?.id).toBe("vehicle-1");
    expect(prisma.vehicle.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.lease.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.subscriptionOrder.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.serviceCase.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.vehicleOperationalRestriction.findMany).toHaveBeenCalledTimes(1);
    expect(snapshot.operationalRestrictions).toEqual([restriction()]);
    expect(prisma.vehicleConditionReport.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.vehicle.create).not.toHaveBeenCalled();
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
    expect(prisma.vehicle.delete).not.toHaveBeenCalled();
  });
});

function vehicle(
  overrides: Partial<VehicleOperationalStateVehicleSnapshot> = {}
): VehicleOperationalStateVehicleSnapshot {
  return { ...baseVehicle(), ...overrides };
}

function baseVehicle(): VehicleOperationalStateVehicleSnapshot {
  return {
    createdAt: new Date("2026-06-01T10:00:00.000Z"),
    deletedAt: null,
    id: "vehicle-1",
    status: VehicleStatus.AVAILABLE,
    updatedAt: new Date("2026-06-30T10:00:00.000Z"),
    vehicleNo: "VH-001"
  };
}

function lease(
  overrides: Partial<VehicleOperationalStateLeaseSnapshot> = {}
): VehicleOperationalStateLeaseSnapshot {
  return { ...baseLease(), ...overrides };
}

function baseLease(): VehicleOperationalStateLeaseSnapshot {
  return {
    activatedAt: new Date("2026-06-15T10:00:00.000Z"),
    createdAt: new Date("2026-06-15T10:00:00.000Z"),
    deletedAt: null,
    id: "lease-1",
    orderId: "order-1",
    status: LeaseStatus.ACTIVE,
    updatedAt: new Date("2026-06-15T10:00:00.000Z")
  };
}

function order(
  overrides: Partial<VehicleOperationalStateOrderSnapshot> = {}
): VehicleOperationalStateOrderSnapshot {
  return { ...baseOrder(), ...overrides };
}

function baseOrder(): VehicleOperationalStateOrderSnapshot {
  return {
    actualDeliveryAt: null,
    actualReturnAt: null,
    createdAt: new Date("2026-06-10T10:00:00.000Z"),
    deletedAt: null,
    endDate: null,
    id: "order-1",
    orderNo: "ORD-001",
    orderStatus: OrderStatus.PENDING_SIGN,
    startDate: null,
    updatedAt: new Date("2026-06-20T10:00:00.000Z"),
    vehicleId: "vehicle-1"
  };
}

function serviceCase(
  overrides: Partial<VehicleOperationalStateServiceCaseSnapshot> = {}
): VehicleOperationalStateServiceCaseSnapshot {
  return { ...baseServiceCase(), ...overrides };
}

function baseServiceCase(): VehicleOperationalStateServiceCaseSnapshot {
  return {
    cancelledAt: null,
    caseNo: "SC-001",
    caseStatus: ServiceCaseStatus.IN_PROGRESS,
    caseType: ServiceCaseType.RESCUE_REQUEST,
    closedAt: null,
    createdAt: new Date("2026-06-30T10:00:00.000Z"),
    deletedAt: null,
    id: "service-case-1",
    occurredAt: new Date("2026-06-30T09:00:00.000Z"),
    priority: ServiceCasePriority.HIGH,
    resolvedAt: null,
    updatedAt: new Date("2026-06-30T10:00:00.000Z"),
    vehicleId: "vehicle-1"
  };
}

function conditionReport(
  overrides: Partial<VehicleOperationalStateConditionReportSnapshot> = {}
): VehicleOperationalStateConditionReportSnapshot {
  return { ...baseConditionReport(), ...overrides };
}

function restriction(
  overrides: Partial<VehicleOperationalStateRestrictionSnapshot> = {}
): VehicleOperationalStateRestrictionSnapshot {
  return {
    id: "restriction-1",
    restrictionType: VehicleOperationalRestrictionType.LEGAL_HOLD,
    scopes: [VehicleOperationalRestrictionScope.ALLOCATION],
    severity: VehicleOperationalRestrictionSeverity.BLOCKING,
    startSourceId: "00000000-0000-4000-8000-000000000091",
    startSourceKey: "manual-review",
    startSourceType: "asset-operations",
    startedAt: new Date("2026-06-30T08:00:00.000Z"),
    status: VehicleOperationalRestrictionStatus.ACTIVE,
    vehicleId: "vehicle-1",
    workOrderId: null,
    ...overrides
  };
}

function baseConditionReport(): VehicleOperationalStateConditionReportSnapshot {
  return {
    archivedAt: null,
    createdAt: new Date("2026-06-20T10:00:00.000Z"),
    customerVisible: true,
    deletedAt: null,
    hasFireDamage: false,
    hasFloodDamage: false,
    hasMajorAccident: false,
    hasStructuralDamage: false,
    id: "condition-report-1",
    inspectionDate: new Date("2026-06-20T00:00:00.000Z"),
    items: [conditionItem()],
    publishedAt: new Date("2026-06-20T10:00:00.000Z"),
    reportNo: "VCR-001",
    reportStatus: VehicleConditionReportStatus.PUBLISHED,
    safetyConclusion: null,
    updatedAt: new Date("2026-06-20T10:00:00.000Z"),
    vehicleId: "vehicle-1"
  };
}

function conditionItem(
  overrides: Partial<VehicleOperationalStateConditionReportItemSnapshot> = {}
): VehicleOperationalStateConditionReportItemSnapshot {
  return { ...baseConditionItem(), ...overrides };
}

function baseConditionItem(): VehicleOperationalStateConditionReportItemSnapshot {
  return {
    affectsSafety: false,
    deletedAt: null,
    id: "condition-item-1",
    repairRequired: false,
    result: VehicleConditionItemResult.NORMAL,
    severity: VehicleConditionItemSeverity.MINOR
  };
}

function createPrismaReadHarness() {
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
    },
    vehicleOperationalRestriction: {
      findMany: vi.fn(async () => [restriction()])
    }
  };
}
