import { describe, expect, it } from "vitest";

import { buildFleetOpsSnapshot } from "../src/fleet-ops/facade/fleet-ops.snapshot.builder";
import { CollectionPriorityLevel, ControlDecision, RiskSignalCode } from "../src/fleet-ops/risk/risk.types";
import {
  TIMELINE_CURRENT_STATUS_PROJECTED_WARNING,
  type TimelineDay,
  TimelineState
} from "../src/fleet-ops/timeline/vehicle-timeline.types";
import {
  VehicleComputedOperationalState,
  VehicleOperationalConfidenceBand
} from "../src/fleet-ops/vehicle-operational-state.types";

const from = new Date("2026-07-01T00:00:00.000Z");
const to = new Date("2026-07-03T00:00:00.000Z");
const generatedAt = new Date("2026-07-03T12:00:00.000Z");

describe("buildFleetOpsSnapshot", () => {
  it("builds the required convergence snapshot structure without mutating PR outputs", () => {
    const input = snapshotInput();
    const before = JSON.stringify(input);
    const snapshot = buildFleetOpsSnapshot(input);

    expect(JSON.stringify(input)).toBe(before);
    expect(snapshot).toEqual(
      expect.objectContaining({
        economics: expect.objectContaining({
          cashflow: expect.objectContaining({ actual: 1200, deposit: null, planned: null }),
          cost: 250,
          revenue: 1200,
          roe: 0.12,
          roi: 0.1
        }),
        execution: expect.objectContaining({
          allowedActions: expect.any(Array),
          blockedActions: expect.any(Array),
          guardDecision: ControlDecision.ALLOW
        }),
        risk: expect.objectContaining({
          agingBucket: null,
          collectionLevel: CollectionPriorityLevel.D1,
          exposureDetail: null,
          level: CollectionPriorityLevel.D1,
          score: 15,
          signals: [RiskSignalCode.UTILIZATION_DROP_SIGNAL]
        }),
        state: expect.objectContaining({
          computedState: VehicleComputedOperationalState.AVAILABLE,
          evidence: expect.any(Array)
        }),
        system: expect.objectContaining({
          consistencyScore: expect.any(Number),
          dataFreshness: expect.objectContaining({ status: "FRESH" }),
          overallConfidence: expect.objectContaining({ score: expect.any(Number) })
        }),
        timeline: expect.objectContaining({
          events: expect.any(Array),
          summary: expect.objectContaining({
            fallbackWarningDays: 1,
            rangeDays: 3
          }),
          warnings: expect.arrayContaining([TIMELINE_CURRENT_STATUS_PROJECTED_WARNING])
        }),
        vehicleId: "vehicle-1"
      })
    );
    expect(snapshot.economics).toEqual(
      expect.objectContaining({
        attribution: expect.objectContaining({ leaseRevenue: 1200 }),
        denominatorEvidence: [],
        evidence: [],
        warnings: []
      })
    );
    expect(snapshot.execution.allowedActions.map((action) => action.actionType).sort()).toContain("VEHICLE_ALLOCATION");
    expect(snapshot.execution.blockedActions.map((action) => action.actionType).sort()).toContain("RESTRICT_VEHICLE");
  });

  it("is deterministic for identical PR outputs", () => {
    const input = snapshotInput();

    expect(buildFleetOpsSnapshot(input)).toEqual(buildFleetOpsSnapshot(input));
  });

  it("marks state versus timeline conflicts without resolving them", () => {
    const snapshot = buildFleetOpsSnapshot({
      ...snapshotInput(),
      timeline: [
        timelineDay({
          date: "2026-07-01",
          sourceEvents: ["lease:lease-1", "vehicle:vehicle-1"],
          state: TimelineState.LEASED
        })
      ]
    });

    expect(snapshot.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "STATE_AVAILABLE_WITH_LEASE_TIMELINE",
          reason: "PR-1 state is AVAILABLE while PR-2 timeline contains leased days.",
          severity: "HIGH"
        })
      ])
    );
    expect(snapshot.state.computedState).toBe(VehicleComputedOperationalState.AVAILABLE);
    expect(snapshot.timeline.events[0]!.state).toBe(TimelineState.LEASED);
  });
});

function snapshotInput() {
  return {
    economics: {
      attribution: { leaseRevenue: 1200, penaltyRevenue: 0, writeOffImpact: 0 },
      confidence: { band: "HIGH" as const, score: 90 },
      downtime: {
        breakdown: { IDLE: 0, MAINTENANCE: 0, RESERVED: 0, SERVICE: 0 },
        downtimeCost: 0,
        totalDowntimeDays: 0
      },
      economics: { cost: 250, netIncome: 950, revenue: 1200, roe: 0.12, roi: 0.1 },
      utilization: { leasedDays: 2, operatingDays: 3, utilizationRate: 0.666667 },
      vehicleId: "vehicle-1"
    },
    from,
    generatedAt,
    risk: {
      collectionLevel: CollectionPriorityLevel.D1,
      confidence: 80,
      controlDecision: ControlDecision.ALLOW,
      exposureScore: 10,
      reasons: ["Risk signals within normal control tolerance."],
      riskScore: 15,
      signals: [RiskSignalCode.UTILIZATION_DROP_SIGNAL],
      vehicleId: "vehicle-1"
    },
    state: {
      asOf: to,
      computedState: VehicleComputedOperationalState.AVAILABLE,
      confidenceBand: VehicleOperationalConfidenceBand.HIGH,
      confidenceScore: 92,
      conflicts: [],
      primaryEvidence: {
        fields: { status: "AVAILABLE" },
        reason: "Vehicle status is available.",
        recordedAt: new Date("2026-07-03T09:00:00.000Z"),
        source: "VEHICLE" as const,
        sourceId: "vehicle-1"
      },
      supportingEvidence: [],
      vehicleId: "vehicle-1",
      warnings: []
    },
    timeline: [
      timelineDay({
        date: "2026-07-01",
        sourceEvents: ["vehicle:vehicle-1"],
        warnings: [TIMELINE_CURRENT_STATUS_PROJECTED_WARNING]
      }),
      timelineDay({ date: "2026-07-02", sourceEvents: ["order:order-1"], state: TimelineState.RESERVED }),
      timelineDay({ date: "2026-07-03", sourceEvents: ["vehicle:vehicle-1"] })
    ],
    to,
    vehicleId: "vehicle-1"
  };
}

function timelineDay(overrides: Partial<TimelineDay> = {}): TimelineDay {
  return {
    ...timelineDayShape(),
    ...overrides
  };
}

function timelineDayShape(): TimelineDay {
  return {
    confidence: 80,
    conflicts: [],
    date: "2026-07-01",
    sourceEvents: ["vehicle:vehicle-1"],
    state: TimelineState.AVAILABLE,
    warnings: []
  };
}
