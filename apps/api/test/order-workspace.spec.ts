import { ForbiddenException } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";
import { describe, expect, it, vi } from "vitest";

import { OrderWorkspaceResolver, OrderWorkspaceService } from "../src/order/order-workspace.service";
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
    expect(summary.guidance.map((item) => item.actionCode)).toEqual([
      "contract.sign",
      "handover.assign",
      "entitlement.review",
      "service.resolve",
      null,
      null
    ]);
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

  it("assigns every fixed state its complete output priority and suppresses non-actionable actions", () => {
    const nonActionableStates = new Set(["COMPLETED", "NOT_STARTED", "UNAVAILABLE"]);
    const resolvedStates = WORKSPACE_STATE_PRIORITY.map((state) => {
      const summary = resolveWith(
        [
          guide({
            state,
            actionCode: nonActionableStates.has(state) ? "invalid.action" : "state.action"
          })
        ],
        adminAccess()
      );

      const item = summary.guidance[0]!;
      return {
        actionCode: item.actionCode,
        priority: item.priority,
        state: item.state
      };
    });

    expect(resolvedStates).toEqual(
      WORKSPACE_STATE_PRIORITY.map((state, index) => ({
        actionCode: nonActionableStates.has(state) ? null : "state.action",
        priority: WORKSPACE_STATE_PRIORITY.length - index,
        state
      }))
    );
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

  it("keeps ordinary Field non-progression processing for 15 minutes, then requires action", () => {
    const resolver = new OrderWorkspaceResolver();
    const workOrder = {
      assigned: true,
      handover: null,
      id: "handover-work-order-1",
      status: "CUSTOMER_CONFIRMED",
      updatedAt: "2026-07-28T09:45:00.000Z"
    } as const;

    expect(
      resolver.resolveHandover({
        asOf: "2026-07-28T09:59:59.999Z",
        workOrder
      })
    ).toEqual(
      expect.objectContaining({
        actionCode: null,
        reasonCode: "HANDOVER_SIGNING_START_PENDING",
        state: "PROCESSING"
      })
    );
    expect(
      resolver.resolveHandover({
        asOf: "2026-07-28T10:00:00.000Z",
        workOrder
      })
    ).toEqual(
      expect.objectContaining({
        actionCode: "handover.start_signing",
        reasonCode: "HANDOVER_SIGNING_START_OVERDUE",
        state: "ACTION_REQUIRED"
      })
    );
  });

  it("treats Stage 2 as complete when both required signers signed even if archival is pending", () => {
    const item = new OrderWorkspaceResolver().resolveHandover({
      asOf: AS_OF,
      workOrder: {
        assigned: true,
        handover: {
          archiveStatus: "PENDING",
          id: "handover-1",
          signers: [
            { required: true, signerStatus: "SIGNED" },
            { required: true, signerStatus: "SIGNED" }
          ],
          status: "SIGNED",
          taskStatus: "COMPLETED",
          updatedAt: "2026-07-28T09:00:00.000Z"
        },
        id: "handover-work-order-1",
        status: "PLATFORM_SEALED",
        updatedAt: "2026-07-28T09:00:00.000Z"
      }
    });

    expect(item).toEqual(
      expect.objectContaining({
        actionCode: null,
        reasonCode: "HANDOVER_STAGE2_SIGNED",
        state: "COMPLETED",
        targetRecordId: "handover-1"
      })
    );
  });

  it("surfaces a failed Stage 2 provider flow without provider payload text", () => {
    const item = new OrderWorkspaceResolver().resolveHandover({
      asOf: AS_OF,
      workOrder: {
        assigned: true,
        handover: {
          archiveStatus: "NOT_STARTED",
          id: "handover-1",
          signers: [{ required: true, signerStatus: "PENDING" }],
          status: "FAILED",
          taskStatus: "FAILED",
          updatedAt: "2026-07-28T09:00:00.000Z"
        },
        id: "handover-work-order-1",
        status: "FAILED",
        updatedAt: "2026-07-28T09:00:00.000Z"
      }
    });

    expect(item).toEqual(
      expect.objectContaining({
        actionCode: "handover.retry_signing",
        reasonCode: "HANDOVER_STAGE2_FAILED",
        state: "FAILED"
      })
    );
    expect(JSON.stringify(item)).not.toMatch(/provider|payload|objectKey|phone|idCard/i);
  });

  it("ranks a contract blocker ahead of a due finance action", () => {
    const resolver = new OrderWorkspaceResolver();
    const summary = resolveWith(
      [
        resolver.resolveContract({ contracts: [] }),
        resolver.resolveFinance({
          asOf: AS_OF,
          depositEntries: [],
          paymentOrders: [],
          receivableBills: [
            {
              billStatus: "OVERDUE",
              dueDate: "2026-07-27T00:00:00.000Z",
              id: "bill-1",
              updatedAt: "2026-07-27T00:00:00.000Z"
            }
          ]
        })
      ],
      adminAccess()
    );

    expect(summary.primaryAction).toEqual({
      actionCode: "contract.generate",
      targetRecordId: null,
      targetTab: "contract"
    });
  });

  it("resolves every category to completed when no domain action remains", () => {
    const resolver = new OrderWorkspaceResolver();
    const guidance = [
      resolver.resolveContract({
        contracts: [
          {
            id: "contract-1",
            status: "SIGNED",
            tasks: [],
            updatedAt: "2026-07-28T09:00:00.000Z"
          }
        ]
      }),
      resolver.resolveHandover({
        asOf: AS_OF,
        workOrder: {
          assigned: true,
          handover: {
            archiveStatus: "PENDING",
            id: "handover-1",
            signers: [
              { required: true, signerStatus: "SIGNED" },
              { required: true, signerStatus: "SIGNED" }
            ],
            status: "SIGNED",
            taskStatus: "COMPLETED",
            updatedAt: "2026-07-28T09:00:00.000Z"
          },
          id: "handover-work-order-1",
          status: "PLATFORM_SEALED",
          updatedAt: "2026-07-28T09:00:00.000Z"
        }
      }),
      resolver.resolveEntitlement({
        account: {
          grants: [{ status: "ACTIVE" }],
          id: "account-1",
          status: "ACTIVE",
          updatedAt: "2026-07-28T09:00:00.000Z"
        },
        orderStatus: "ACTIVE"
      }),
      resolver.resolveService({ cases: [] }),
      resolver.resolveFinance({
        asOf: AS_OF,
        depositEntries: [],
        paymentOrders: [],
        receivableBills: []
      }),
      resolver.resolveChange({ changes: [] })
    ];

    expect(resolveWith(guidance, adminAccess()).guidance.map(({ state }) => state)).toEqual([
      "COMPLETED",
      "COMPLETED",
      "COMPLETED",
      "COMPLETED",
      "COMPLETED",
      "COMPLETED"
    ]);
  });
});

describe("OrderWorkspaceService", () => {
  it("stops before contributor queries when the existing order access check rejects sales scope", async () => {
    const getOrder = vi.fn().mockRejectedValue(new ForbiddenException("Order is outside your scope."));
    const prisma = workspacePrisma();
    const service = new OrderWorkspaceService(
      prisma as never,
      { getOrder } as never,
      new OrderWorkspaceResolver()
    );

    await expect(service.getSummary("order-1", workspaceUser())).rejects.toBeInstanceOf(ForbiddenException);
    expect(getOrder).toHaveBeenCalledWith("order-1", workspaceUser());
    expect(prisma.subscriptionOrder.findUnique).not.toHaveBeenCalled();
    expect(prisma.contract.findMany).not.toHaveBeenCalled();
  });

  it("degrades one failed contributor while keeping all other visible categories available", async () => {
    const prisma = workspacePrisma();
    prisma.contract.findMany.mockRejectedValue(new Error("contract database unavailable"));
    const service = new OrderWorkspaceService(
      prisma as never,
      { getOrder: vi.fn().mockResolvedValue({ id: "order-1" }) } as never,
      new OrderWorkspaceResolver()
    );

    const summary = await service.getSummary("order-1", workspaceUser());

    expect(summary.guidance).toHaveLength(6);
    expect(summary.guidance.find(({ category }) => category === "contract")).toEqual(
      expect.objectContaining({
        actionCode: null,
        reasonCode: "CONTRACT_UNAVAILABLE",
        state: "UNAVAILABLE"
      })
    );
    expect(summary.guidance.filter(({ category }) => category !== "contract")).not.toContainEqual(
      expect.objectContaining({ state: "UNAVAILABLE" })
    );
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
      state: "READY",
      actionCode: "service.resolve",
      targetRecordId: "service-1"
    }),
    guide({
      category: "finance",
      state: "NOT_STARTED",
      actionCode: null,
      targetRecordId: "finance-1"
    }),
    guide({
      category: "change",
      state: "UNAVAILABLE",
      actionCode: null,
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

function workspaceUser() {
  return {
    id: "admin-1",
    menus: [],
    name: "Admin",
    permissions: Object.values(PermissionCode),
    roles: ["ADMIN"],
    username: "admin"
  };
}

function workspacePrisma() {
  return {
    contract: {
      findMany: vi.fn().mockResolvedValue([])
    },
    orderChange: {
      findMany: vi.fn().mockResolvedValue([])
    },
    orderEntitlementAccount: {
      findFirst: vi.fn().mockResolvedValue({
        accountStatus: "ACTIVE",
        grants: [],
        id: "account-1",
        updatedAt: new Date("2026-07-28T09:00:00.000Z")
      })
    },
    serviceCase: {
      findMany: vi.fn().mockResolvedValue([])
    },
    subscriptionOrder: {
      findUnique: vi
        .fn()
        .mockResolvedValueOnce({
          application: { salesUser: { name: "Owner 001" } },
          customer: { name: "Customer 001" },
          id: "order-1",
          orderNo: "ORD-20260728-001",
          orderStatus: "ACTIVE",
          vehicle: { modelDefinition: { displayName: "Vehicle 001" }, plateNo: null, vehicleNo: "V001" }
        })
        .mockResolvedValue({
          depositLedgers: [],
          paymentOrders: [],
          receivableBills: []
        })
    },
    vehicleHandoverWorkOrder: {
      findFirst: vi.fn().mockResolvedValue({
        assignedInternalUserId: "field-1",
        createdAt: new Date("2026-07-28T08:00:00.000Z"),
        externalOperatorName: null,
        handover: {
          archiveStatus: "PENDING",
          handoverESignTask: {
            signers: [
              { required: true, signerStatus: "SIGNED" },
              { required: true, signerStatus: "SIGNED" }
            ],
            taskStatus: "COMPLETED"
          },
          id: "handover-1",
          status: "SIGNED",
          updatedAt: new Date("2026-07-28T09:00:00.000Z")
        },
        id: "handover-work-order-1",
        status: "PLATFORM_SEALED",
        updatedAt: new Date("2026-07-28T09:00:00.000Z")
      })
    }
  };
}
