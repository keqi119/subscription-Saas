import { describe, expect, it } from "vitest";

describe("subscription segment consistency inspection", () => {
  it("accepts adjacent BASE and EXTENSION segments with one ACTIVE segment", async () => {
    const { inspectSubscriptionSegmentConsistency } = await loadInspector();
    const consistency = inspectSubscriptionSegmentConsistency([orderRecord()]);

    expect(consistency.overlaps).toHaveLength(0);
    expect(consistency.activeCountViolations).toHaveLength(0);
    expect(consistency.scheduledChangeViolations).toHaveLength(0);
  });

  it("reports overlap, multiple ACTIVE segments and an unarchived scheduled change", async () => {
    const { inspectSubscriptionSegmentConsistency } = await loadInspector();
    const record = orderRecord();
    record.segments[0] = { ...record.segments[0]!, status: "ACTIVE" };
    record.segments[1] = {
      ...record.segments[1]!,
      startDate: new Date("2026-09-02T00:00:00.000Z"),
      status: "ACTIVE"
    };
    record.scheduledChanges[0]!.contractStatus = "SIGNED";

    const consistency = inspectSubscriptionSegmentConsistency([record]);

    expect(consistency.overlaps).toEqual([
      { leftSegmentId: "segment-base", orderId: "order-1", rightSegmentId: "segment-extension" }
    ]);
    expect(consistency.activeCountViolations).toEqual([{ activeCount: 2, orderId: "order-1" }]);
    expect(consistency.scheduledChangeViolations).toEqual([
      { changeOrderId: "change-1", code: "SCHEDULED_CONTRACT_NOT_ARCHIVED", orderId: "order-1" }
    ]);
  });

  it("allows a PENDING_RETURN order to have no ACTIVE segment", async () => {
    const { inspectSubscriptionSegmentConsistency } = await loadInspector();
    const record = orderRecord();
    record.orderStatus = "PENDING_RETURN";
    record.segments = [record.segments[0]!];

    const consistency = inspectSubscriptionSegmentConsistency([record]);

    expect(consistency.activeCountViolations).toHaveLength(0);
  });
});

async function loadInspector() {
  // @ts-expect-error Operational ESM scripts intentionally do not publish TypeScript declarations.
  return import("../../../scripts/subscription-renewal-reconcile.mjs") as Promise<{
    inspectSubscriptionSegmentConsistency: (records: Array<Record<string, unknown>>) => {
      activeCountViolations: Array<Record<string, unknown>>;
      overlaps: Array<Record<string, unknown>>;
      scheduledChangeViolations: Array<Record<string, unknown>>;
    };
  }>;
}

function orderRecord() {
  return {
    id: "order-1",
    orderStatus: "ACTIVE",
    scheduledChanges: [
      {
        contractStatus: "ARCHIVED",
        id: "change-1",
        status: "SCHEDULED",
        targetSegmentId: "segment-extension"
      }
    ],
    segments: [
      {
        endDate: new Date("2026-09-02T00:00:00.000Z"),
        id: "segment-base",
        sequenceNo: 1,
        startDate: new Date("2026-03-03T00:00:00.000Z"),
        status: "COMPLETED"
      },
      {
        endDate: new Date("2027-03-02T00:00:00.000Z"),
        id: "segment-extension",
        sequenceNo: 2,
        startDate: new Date("2026-09-03T00:00:00.000Z"),
        status: "ACTIVE"
      }
    ]
  };
}
