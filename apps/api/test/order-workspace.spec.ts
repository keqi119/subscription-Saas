import { describe, expect, it } from "vitest";

import { OrderWorkspaceResolver } from "../src/order/order-workspace.resolver";
import type {
  OrderWorkspaceGuideCategory,
  OrderWorkspaceGuideItem,
  OrderWorkspaceSummary
} from "../src/order/order-workspace.types";

const WORKSPACE_STATE_PRIORITY = [
  "BLOCKED",
  "ACTION_REQUIRED",
  "FAILED",
  "PROCESSING",
  "WAITING_EXTERNAL",
  "READY",
  "COMPLETED",
  "NOT_STARTED",
  "UNAVAILABLE"
] as const;

const AS_OF = "2026-07-28T10:00:00.000Z";

describe("OrderWorkspaceResolver", () => {
  it("returns six guidance entries for a fully authorized Admin in tab order", () => {
    const summary = resolveWith(allGuidance(), adminAccess());

    expect(summary.guidance).toHaveLength(6);
    expect(summary.guidance.map((item) => item.category)).toEqual([
      "contract",
      "handover",
      "entitlement",
      "service",
      "finance",
      "change"
    ]);
    expect(summary.guidance.every((item) => item.actionCode)).toBe(true);
  });

  it("returns only permitted badges and guidance, without an action for view-only access", () => {
    const summary = resolveWith(allGuidance(), {
      contract: { view: true, action: false },
      handover: { view: false, action: false },
      entitlement: { view: false, action: false },
      service: { view: true, action: true },
      finance: { view: false, action: false },
      change: { view: false, action: false }
    });

    expect(summary.tabBadges.map((badge) => badge.tab)).toEqual(["contract", "service"]);
    expect(summary.guidance.map((item) => item.category)).toEqual(["contract", "service"]);
    expect(summary.guidance[0]).toEqual(
      expect.objectContaining({
        actionCode: null,
        category: "contract",
        state: "ACTION_REQUIRED",
        targetRecordId: "contract-1"
      })
    );
    expect(summary.guidance[1]).toEqual(
      expect.objectContaining({
        actionCode: "service.resolve",
        category: "service"
      })
    );
  });

  it("selects the first actionable item by fixed state priority", () => {
    const summary = resolveWith(
      [
        guide({
          category: "contract",
          state: WORKSPACE_STATE_PRIORITY[1],
          actionCode: "contract.sign",
          targetRecordId: "contract-1",
          updatedAt: "2026-07-20T00:00:00.000Z"
        }),
        guide({
          category: "handover",
          state: WORKSPACE_STATE_PRIORITY[0],
          actionCode: "handover.assign",
          targetRecordId: "handover-1",
          updatedAt: "2026-07-28T00:00:00.000Z"
        })
      ],
      adminAccess()
    );

    expect(summary.primaryAction).toEqual({
      actionCode: "handover.assign",
      targetTab: "handover",
      targetRecordId: "handover-1"
    });
  });

  it("selects the oldest required-action timestamp within the same state", () => {
    const summary = resolveWith(
      [
        guide({
          category: "service",
          state: "ACTION_REQUIRED",
          actionCode: "service.resolve",
          targetRecordId: "service-new",
          updatedAt: "2026-07-28T09:00:00.000Z"
        }),
        guide({
          category: "finance",
          state: "ACTION_REQUIRED",
          actionCode: "finance.collect",
          targetRecordId: "finance-old",
          updatedAt: "2026-07-27T09:00:00.000Z"
        })
      ],
      adminAccess()
    );

    expect(summary.primaryAction?.targetRecordId).toBe("finance-old");
  });

  it("uses record ID as the final primary-action tie breaker", () => {
    const timestamp = "2026-07-27T09:00:00.000Z";
    const summary = resolveWith(
      [
        guide({
          category: "service",
          state: "ACTION_REQUIRED",
          actionCode: "service.resolve",
          targetRecordId: "service-z",
          updatedAt: timestamp
        }),
        guide({
          category: "finance",
          state: "ACTION_REQUIRED",
          actionCode: "finance.collect",
          targetRecordId: "finance-a",
          updatedAt: timestamp
        })
      ],
      adminAccess()
    );

    expect(summary.primaryAction?.targetRecordId).toBe("finance-a");
  });

  it("returns no primary action when all visible entries are completed, not started, or unavailable", () => {
    const summary = resolveWith(
      [
        guide({ category: "contract", state: "COMPLETED", actionCode: null }),
        guide({ category: "handover", state: "NOT_STARTED", actionCode: null }),
        guide({ category: "service", state: "UNAVAILABLE", actionCode: null })
      ],
      adminAccess()
    );

    expect(summary.primaryAction).toBeNull();
  });

  it("keeps all returned targets compatible with tab and focus query parameters", () => {
    const summary = resolveWith(allGuidance(), adminAccess());
    const targets = [
      ...summary.guidance.map((item) => ({
        targetTab: item.targetTab,
        targetRecordId: item.targetRecordId
      })),
      summary.primaryAction
    ].filter(
      (target): target is { targetTab: OrderWorkspaceGuideCategory; targetRecordId: string } => {
        return target !== null && target.targetRecordId !== null;
      }
    );

    expect(targets).toHaveLength(7);
    for (const target of targets) {
      const query = new URLSearchParams({ tab: target.targetTab, focus: target.targetRecordId });
      expect(query.toString()).toBe(`tab=${target.targetTab}&focus=${target.targetRecordId}`);
    }
  });

  it("returns asOf, safe header context, tab badges, and an empty bounded activity array", () => {
    const summary = resolveWith(allGuidance(), adminAccess());

    expect(summary.asOf).toBe(AS_OF);
    expect(summary.header).toEqual({
      orderId: "order-1",
      orderNo: "ORD-20260728-001",
      orderStatus: "ACTIVE",
      customerLabel: "Customer 001",
      currentVehicleLabel: "Vehicle 001",
      ownerLabel: "Owner 001"
    });
    expect(summary.tabBadges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tab: "contract", count: 1, attentionCount: 1 }),
        expect.objectContaining({ tab: "handover", count: 1, attentionCount: 0 })
      ])
    );
    expect(summary.recentActivity).toEqual([]);
  });
});

type Access = Record<OrderWorkspaceGuideCategory, { view: boolean; action: boolean }>;

type GuideSeed = Omit<OrderWorkspaceGuideItem, "actionCode"> & {
  actionCode: string | null;
};

function resolveWith(guidance: GuideSeed[], access: Access): OrderWorkspaceSummary {
  return new OrderWorkspaceResolver().resolve({
    access,
    asOf: AS_OF,
    guidance,
    header: {
      orderId: "order-1",
      orderNo: "ORD-20260728-001",
      orderStatus: "ACTIVE",
      customerLabel: "Customer 001",
      currentVehicleLabel: "Vehicle 001",
      ownerLabel: "Owner 001"
    },
    recentActivity: []
  });
}

function adminAccess(): Access {
  return {
    contract: { view: true, action: true },
    handover: { view: true, action: true },
    entitlement: { view: true, action: true },
    service: { view: true, action: true },
    finance: { view: true, action: true },
    change: { view: true, action: true }
  };
}

function allGuidance(): GuideSeed[] {
  return [
    guide({
      category: "contract",
      state: "ACTION_REQUIRED",
      actionCode: "contract.sign",
      targetRecordId: "contract-1"
    }),
    guide({
      category: "handover",
      state: "READY",
      actionCode: "handover.assign",
      targetRecordId: "handover-1"
    }),
    guide({
      category: "entitlement",
      state: "PROCESSING",
      actionCode: "entitlement.review",
      targetRecordId: "entitlement-1"
    }),
    guide({
      category: "service",
      state: "COMPLETED",
      actionCode: "service.resolve",
      targetRecordId: "service-1"
    }),
    guide({
      category: "finance",
      state: "NOT_STARTED",
      actionCode: "finance.collect",
      targetRecordId: "finance-1"
    }),
    guide({
      category: "change",
      state: "UNAVAILABLE",
      actionCode: "change.review",
      targetRecordId: "change-1"
    })
  ];
}

function guide(overrides: Partial<GuideSeed>): GuideSeed {
  const category = overrides.category ?? "contract";
  return {
    actionCode: "workspace.action",
    additionalCount: 0,
    blocking: false,
    category,
    priority: 0,
    reasonCode: "TEST_REASON",
    state: "READY",
    targetRecordId: `${category}-1`,
    targetTab: category,
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides
  };
}
