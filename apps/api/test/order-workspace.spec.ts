import { ForbiddenException } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";
import { describe, expect, it, vi } from "vitest";

import {
  filterWorkspaceActionByPermission,
  OrderWorkspaceResolver,
  OrderWorkspaceService
} from "../src/order/order-workspace.service";
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
      customerConfirmedAt: "2026-07-28T09:45:00.000Z",
      handover: null,
      id: "handover-work-order-1",
      status: "CUSTOMER_CONFIRMED",
      updatedAt: "2026-07-28T09:58:00.000Z"
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

  it("does not reset the signing-start timer when unrelated work-order updates occur", () => {
    const item = new OrderWorkspaceResolver().resolveHandover({
      asOf: "2026-07-28T10:00:00.000Z",
      workOrder: {
        assigned: true,
        customerConfirmedAt: "2026-07-28T09:45:00.000Z",
        handover: null,
        id: "handover-work-order-1",
        status: "CUSTOMER_CONFIRMED",
        updatedAt: "2026-07-28T09:59:30.000Z"
      }
    } as never);

    expect(item).toEqual(
      expect.objectContaining({
        actionCode: "handover.start_signing",
        reasonCode: "HANDOVER_SIGNING_START_OVERDUE",
        updatedAt: "2026-07-28T09:45:00.000Z"
      })
    );
  });

  it("treats an authoritative signed contract as complete despite an older failed retry", () => {
    const item = new OrderWorkspaceResolver().resolveContract({
      contracts: [
        {
          id: "stage1-contract",
          status: "SIGNED",
          tasks: [
            { taskStatus: "COMPLETED", updatedAt: "2026-07-28T09:00:00.000Z" },
            { taskStatus: "FAILED", updatedAt: "2026-07-28T08:00:00.000Z" }
          ],
          updatedAt: "2026-07-28T09:00:00.000Z"
        }
      ]
    });

    expect(item).toEqual(
      expect.objectContaining({
        actionCode: null,
        reasonCode: "CONTRACT_SIGNED",
        state: "COMPLETED",
        targetRecordId: "stage1-contract"
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

  it("selects a handover representative across delivery and return work orders", () => {
    const item = new OrderWorkspaceResolver().resolveHandover({
      asOf: AS_OF,
      workOrders: [
        {
          assigned: true,
          customerConfirmedAt: null,
          handover: {
            archiveStatus: "ARCHIVED",
            id: "handover-complete",
            signers: [
              { required: true, signerStatus: "SIGNED" },
              { required: true, signerStatus: "SIGNED" }
            ],
            status: "ARCHIVED",
            taskStatus: "COMPLETED",
            updatedAt: "2026-07-28T07:00:00.000Z"
          },
          id: "return-work-order",
          status: "PLATFORM_SEALED",
          updatedAt: "2026-07-28T07:00:00.000Z"
        },
        {
          assigned: false,
          customerConfirmedAt: null,
          handover: null,
          id: "delivery-work-order",
          status: "DRAFT",
          updatedAt: "2026-07-28T08:00:00.000Z"
        }
      ]
    } as never);

    expect(item).toEqual(
      expect.objectContaining({
        actionCode: "handover.assign",
        additionalCount: 1,
        state: "ACTION_REQUIRED",
        targetRecordId: "delivery-work-order"
      })
    );
  });

  it("selects the highest-priority service case before counting the remaining cases", () => {
    const item = new OrderWorkspaceResolver().resolveService({
      cases: [
        {
          assigned: true,
          id: "waiting-case",
          status: "WAITING_CUSTOMER",
          updatedAt: "2026-07-28T07:00:00.000Z"
        },
        {
          assigned: false,
          id: "action-case",
          status: "SUBMITTED",
          updatedAt: "2026-07-28T09:00:00.000Z"
        }
      ]
    });

    expect(item).toEqual(
      expect.objectContaining({
        actionCode: "service.resolve",
        additionalCount: 1,
        state: "ACTION_REQUIRED",
        targetRecordId: "action-case"
      })
    );
  });

  it("selects finance candidates by shared state priority instead of source order", () => {
    const item = new OrderWorkspaceResolver().resolveFinance({
      asOf: AS_OF,
      collectionCases: [],
      depositEntries: [],
      paymentOrders: [
        {
          id: "failed-payment",
          status: "FAILED",
          updatedAt: "2026-07-28T07:00:00.000Z"
        }
      ],
      receivableBills: [
        {
          billStatus: "OVERDUE",
          dueDate: "2026-07-27T00:00:00.000Z",
          id: "due-bill",
          updatedAt: "2026-07-28T09:00:00.000Z"
        }
      ]
    } as never);

    expect(item).toEqual(
      expect.objectContaining({
        actionCode: "finance.collect",
        additionalCount: 1,
        state: "ACTION_REQUIRED",
        targetRecordId: "due-bill",
        updatedAt: "2026-07-27T00:00:00.000Z"
      })
    );
  });

  it("uses oldest required timestamp and record ID for mixed pending and approved changes", () => {
    const resolver = new OrderWorkspaceResolver();
    const oldest = resolver.resolveChange({
      changes: [
        { id: "pending-new", status: "PENDING", updatedAt: "2026-07-28T09:00:00.000Z" },
        { id: "approved-old", status: "APPROVED", updatedAt: "2026-07-28T08:00:00.000Z" }
      ]
    });
    const tie = resolver.resolveChange({
      changes: [
        { id: "change-z", status: "PENDING", updatedAt: "2026-07-28T08:00:00.000Z" },
        { id: "change-a", status: "APPROVED", updatedAt: "2026-07-28T08:00:00.000Z" }
      ]
    });

    expect(oldest).toEqual(
      expect.objectContaining({
        actionCode: "change.execute",
        additionalCount: 1,
        targetRecordId: "approved-old"
      })
    );
    expect(tie.targetRecordId).toBe("change-a");
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
  it.each([
    ["contract.generate", PermissionCode.CONTRACT_GENERATE, PermissionCode.CONTRACT_SIGN],
    ["contract.sign", PermissionCode.CONTRACT_SIGN, PermissionCode.CONTRACT_GENERATE],
    ["contract.retry_signing", PermissionCode.CONTRACT_SIGN, PermissionCode.CONTRACT_ARCHIVE],
    ["handover.assign", PermissionCode.DELIVERY_PREPARE, PermissionCode.DELIVERY_CONFIRM],
    ["handover.start_signing", PermissionCode.DELIVERY_CONFIRM, PermissionCode.DELIVERY_PREPARE],
    ["handover.retry_signing", PermissionCode.DELIVERY_CONFIRM, PermissionCode.DELIVERY_PREPARE],
    ["handover.follow_up_signing", PermissionCode.DELIVERY_CONFIRM, PermissionCode.DELIVERY_PREPARE],
    ["entitlement.activate", PermissionCode.ENTITLEMENT_GENERATE, PermissionCode.ENTITLEMENT_ADJUST],
    ["entitlement.reconcile", PermissionCode.ENTITLEMENT_ADJUST, PermissionCode.ENTITLEMENT_GENERATE],
    ["service.resolve", PermissionCode.SERVICE_CASE_MANAGE, PermissionCode.SERVICE_CASE_VIEW],
    ["finance.collect", PermissionCode.PAYMENT_CREATE, PermissionCode.BILLING_GENERATE],
    ["finance.refund_deposit", PermissionCode.DEPOSIT_LEDGER_REFUND, PermissionCode.DEPOSIT_LEDGER_DEDUCT],
    ["finance.deduct_deposit", PermissionCode.DEPOSIT_LEDGER_DEDUCT, PermissionCode.DEPOSIT_LEDGER_REFUND],
    ["change.approve", PermissionCode.ORDER_CHANGE_APPROVE, PermissionCode.ORDER_CHANGE_CREATE],
    ["change.execute", PermissionCode.ORDER_CHANGE_EXECUTE, PermissionCode.ORDER_CHANGE_APPROVE],
    ["change.retry", PermissionCode.ORDER_CHANGE_EXECUTE, PermissionCode.ORDER_CHANGE_APPROVE]
  ])("filters %s with its exact endpoint permission", (actionCode, allowed, sibling) => {
    const item = guide({ actionCode });

    expect(filterWorkspaceActionByPermission(item, workspaceUser([allowed])).actionCode).toBe(actionCode);
    expect(filterWorkspaceActionByPermission(item, workspaceUser([sibling])).actionCode).toBeNull();
  });

  it("fails closed for an unmapped action code", () => {
    const item = guide({ actionCode: "finance.unknown" });

    expect(filterWorkspaceActionByPermission(item, workspaceUser(Object.values(PermissionCode))).actionCode).toBeNull();
  });

  it("fails closed for finance reconciliation because no Admin retry endpoint exists", () => {
    const item = guide({ actionCode: "finance.reconcile" });

    expect(filterWorkspaceActionByPermission(item, workspaceUser(Object.values(PermissionCode))).actionCode).toBeNull();
  });

  it("fails closed for collection follow-up because no matching Admin endpoint exists", () => {
    const item = guide({ actionCode: "finance.collection_follow_up" });

    expect(filterWorkspaceActionByPermission(item, workspaceUser(Object.values(PermissionCode))).actionCode).toBeNull();
  });

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
    expect(prisma.vehicleHandoverWorkOrder.findMany).not.toHaveBeenCalled();
  });

  it("degrades one failed contributor while keeping all other visible categories available", async () => {
    const prisma = workspacePrisma();
    prisma.subscriptionOrder.findUnique.mockImplementation(async (args: { select?: { contractId?: boolean } }) => {
      if (args.select?.contractId) {
        throw new Error("contract database unavailable");
      }
      return workspaceOrderRecord();
    });
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

  it("loads only the authoritative Stage 1 contract relation with a bounded current task", async () => {
    const prisma = workspacePrisma();
    const service = workspaceService(prisma);

    const summary = await service.getSummary("order-1", workspaceUser());

    expect(prisma.contract.findMany).not.toHaveBeenCalled();
    expect(prisma.subscriptionOrder.findUnique).toHaveBeenCalledWith({
      select: {
        contract: {
          select: {
            esignTasks: {
              orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
              select: { taskStatus: true, updatedAt: true },
              take: 1,
              where: { deletedAt: null, signingStage: "STAGE1_SUBSCRIPTION_CONTRACT" }
            },
            id: true,
            status: true,
            updatedAt: true
          }
        },
        contractId: true
      },
      where: { id: "order-1" }
    });
    expect(summary.guidance.find(({ category }) => category === "contract")).toEqual(
      expect.objectContaining({
        reasonCode: "CONTRACT_SIGNED",
        state: "COMPLETED",
        targetRecordId: "stage1-contract"
      })
    );
  });

  it.each([
    {
      actionCode: null,
      permissions: [PermissionCode.ORDER_VIEW, PermissionCode.CONTRACT_VIEW, PermissionCode.CONTRACT_GENERATE]
    },
    {
      actionCode: "contract.sign",
      permissions: [PermissionCode.ORDER_VIEW, PermissionCode.CONTRACT_VIEW, PermissionCode.CONTRACT_SIGN]
    }
  ])("filters contract.sign by its exact endpoint permission", async ({ actionCode, permissions }) => {
    const prisma = workspacePrisma();
    prisma.subscriptionOrder.findUnique.mockImplementation(
      async (args: { select?: { application?: unknown; contractId?: boolean } }) => {
        if (args.select?.contractId) {
          return authoritativeContractRecord({ status: "GENERATED", tasks: [] });
        }
        return workspaceOrderRecord();
      }
    );

    const summary = await workspaceService(prisma).getSummary("order-1", workspaceUser(permissions));

    expect(summary.guidance.find(({ category }) => category === "contract")?.actionCode).toBe(actionCode);
  });

  it("queries only finance subdomains granted by their own view permission", async () => {
    const prisma = workspacePrisma();
    prisma.receivableBill.findMany.mockResolvedValue([
      {
        billStatus: "OVERDUE",
        dueDate: new Date("2026-07-27T00:00:00.000Z"),
        id: "bill-1",
        updatedAt: new Date("2026-07-28T08:00:00.000Z")
      }
    ]);

    const summary = await workspaceService(prisma).getSummary(
      "order-1",
      workspaceUser([PermissionCode.ORDER_VIEW, PermissionCode.BILLING_VIEW])
    );

    expect(prisma.receivableBill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { billStatus: true, dueDate: true, id: true, updatedAt: true },
        take: 50
      })
    );
    expect(prisma.paymentOrder.findMany).not.toHaveBeenCalled();
    expect(prisma.depositLedger.findMany).not.toHaveBeenCalled();
    expect(prisma.collectionCase.findMany).not.toHaveBeenCalled();
    expect(summary.guidance.find(({ category }) => category === "finance")?.actionCode).toBeNull();
  });

  it.each([
    [PermissionCode.BILLING_VIEW, "receivableBill"],
    [PermissionCode.PAYMENT_VIEW, "paymentOrder"],
    [PermissionCode.DEPOSIT_LEDGER_VIEW, "depositLedger"],
    [PermissionCode.COLLECTION_VIEW, "collectionCase"],
    [PermissionCode.REPORT_FINANCE, null]
  ] as const)("scopes finance reads for %s to %s", async (permission, expectedDelegate) => {
    const prisma = workspacePrisma();

    await workspaceService(prisma).getSummary(
      "order-1",
      workspaceUser([PermissionCode.ORDER_VIEW, permission])
    );

    for (const delegate of ["receivableBill", "paymentOrder", "depositLedger", "collectionCase"] as const) {
      expect(prisma[delegate].findMany).toHaveBeenCalledTimes(delegate === expectedDelegate ? 1 : 0);
    }
  });

  it("loads handover summary for vehicle-return-only access", async () => {
    const prisma = workspacePrisma();

    const summary = await workspaceService(prisma).getSummary(
      "order-1",
      workspaceUser([
        PermissionCode.ORDER_VIEW,
        PermissionCode.VEHICLE_RETURN_VIEW
      ])
    );

    expect(prisma.vehicleHandoverWorkOrder.findMany).toHaveBeenCalledTimes(1);
    expect(summary.guidance.map(({ category }) => category)).toEqual([
      "handover"
    ]);
    expect(summary.tabBadges.map(({ tab }) => tab)).toEqual(["handover"]);
  });

  it.each([
    [PermissionCode.CONTRACT_VIEW, "contract"],
    [PermissionCode.ORDER_CHANGE_VIEW, "change"],
    [PermissionCode.PAYMENT_VIEW, "finance"]
  ] as const)(
    "keeps %s workspace access aligned with the matching UI tab",
    async (permission, expectedCategory) => {
      const summary = await workspaceService(workspacePrisma()).getSummary(
        "order-1",
        workspaceUser([PermissionCode.ORDER_VIEW, permission])
      );

      expect(summary.guidance.map(({ category }) => category)).toEqual([
        expectedCategory
      ]);
      expect(summary.tabBadges.map(({ tab }) => tab)).toEqual([
        expectedCategory
      ]);
    }
  );

  it("shows a finance action only with the matching action endpoint permission", async () => {
    const prisma = workspacePrisma();
    prisma.receivableBill.findMany.mockResolvedValue([
      {
        billStatus: "OVERDUE",
        dueDate: new Date("2026-07-27T00:00:00.000Z"),
        id: "bill-1",
        updatedAt: new Date("2026-07-28T08:00:00.000Z")
      }
    ]);

    const summary = await workspaceService(prisma).getSummary(
      "order-1",
      workspaceUser([PermissionCode.ORDER_VIEW, PermissionCode.BILLING_VIEW, PermissionCode.PAYMENT_CREATE])
    );

    expect(summary.guidance.find(({ category }) => category === "finance")?.actionCode).toBe("finance.collect");
  });

  it("keeps an active collection case visible without an action or primary recommendation", async () => {
    const prisma = workspacePrisma();
    prisma.collectionCase.findMany.mockResolvedValue([
      {
        caseStatus: "ACTIVE",
        id: "collection-1",
        nextFollowUpAt: new Date("2026-07-28T08:00:00.000Z"),
        updatedAt: new Date("2026-07-28T08:00:00.000Z")
      }
    ]);

    const summary = await workspaceService(prisma).getSummary(
      "order-1",
      workspaceUser([
        PermissionCode.ORDER_VIEW,
        PermissionCode.COLLECTION_VIEW,
        PermissionCode.COLLECTION_ACTION_CREATE
      ])
    );

    expect(summary.guidance.find(({ category }) => category === "finance")).toEqual(
      expect.objectContaining({
        actionCode: null,
        reasonCode: "FINANCE_COLLECTION_ACTION_REQUIRED",
        state: "ACTION_REQUIRED",
        targetRecordId: "collection-1"
      })
    );
    expect(summary.primaryAction).toBeNull();
  });

  it("still recommends a finance candidate backed by a real protected endpoint", async () => {
    const prisma = workspacePrisma();
    prisma.collectionCase.findMany.mockResolvedValue([
      {
        caseStatus: "ACTIVE",
        id: "collection-1",
        nextFollowUpAt: new Date("2026-07-26T00:00:00.000Z"),
        updatedAt: new Date("2026-07-26T00:00:00.000Z")
      }
    ]);
    prisma.receivableBill.findMany.mockResolvedValue([
      {
        billStatus: "OVERDUE",
        dueDate: new Date("2026-07-27T00:00:00.000Z"),
        id: "bill-1",
        updatedAt: new Date("2026-07-28T08:00:00.000Z")
      }
    ]);

    const summary = await workspaceService(prisma).getSummary(
      "order-1",
      workspaceUser([
        PermissionCode.ORDER_VIEW,
        PermissionCode.BILLING_VIEW,
        PermissionCode.COLLECTION_VIEW,
        PermissionCode.COLLECTION_ACTION_CREATE,
        PermissionCode.PAYMENT_CREATE
      ])
    );

    expect(summary.guidance.find(({ category }) => category === "finance")).toEqual(
      expect.objectContaining({
        actionCode: null,
        reasonCode: "FINANCE_COLLECTION_ACTION_REQUIRED",
        state: "ACTION_REQUIRED",
        targetRecordId: "collection-1"
      })
    );
    expect(summary.tabBadges).toContainEqual({
      attentionCount: 2,
      count: 2,
      tab: "finance"
    });
    expect(summary.primaryAction).toEqual({
      actionCode: "finance.collect",
      targetRecordId: "bill-1",
      targetTab: "finance"
    });
  });

  it("boundedly loads all delivery and return work orders and signer rows", async () => {
    const prisma = workspacePrisma();

    await workspaceService(prisma).getSummary("order-1", workspaceUser());

    expect(prisma.vehicleHandoverWorkOrder.findFirst).not.toHaveBeenCalled();
    expect(prisma.vehicleHandoverWorkOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: 50,
        where: {
          handoverType: { in: ["DELIVERY_OUTBOUND", "RETURN_INBOUND"] },
          orderId: "order-1"
        }
      })
    );
    const query = prisma.vehicleHandoverWorkOrder.findMany.mock.calls[0]?.[0];
    expect(query.select.handover.select.handoverESignTask.select.signers.take).toBe(10);
    expect(query.select.customerConfirmedAt).toBe(true);
  });

  it("bounds service and change candidates while limiting change status to persisted actionable values", async () => {
    const prisma = workspacePrisma();

    await workspaceService(prisma).getSummary("order-1", workspaceUser());

    expect(prisma.serviceCase.findMany).toHaveBeenCalledWith({
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      select: { assignedTo: true, caseStatus: true, id: true, updatedAt: true },
      take: 25,
      where: {
        caseStatus: { in: ["SUBMITTED", "ACCEPTED", "IN_PROGRESS", "WAITING_CUSTOMER"] },
        deletedAt: null,
        orderId: "order-1"
      }
    });
    expect(prisma.orderChange.findMany).toHaveBeenCalledWith({
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      select: { id: true, status: true, updatedAt: true },
      take: 25,
      where: {
        deletedAt: null,
        orderId: "order-1",
        status: { in: ["PENDING", "APPROVED"] }
      }
    });
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

function workspaceUser(permissions: PermissionCode[] = Object.values(PermissionCode)) {
  return {
    id: "admin-1",
    menus: [],
    name: "Admin",
    permissions,
    roles: ["ADMIN"],
    username: "admin"
  };
}

function workspaceService(prisma: ReturnType<typeof workspacePrisma>) {
  return new OrderWorkspaceService(
    prisma as never,
    { getOrder: vi.fn().mockResolvedValue({ id: "order-1" }) } as never,
    new OrderWorkspaceResolver()
  );
}

function workspacePrisma() {
  return {
    collectionCase: {
      findMany: vi.fn().mockResolvedValue([])
    },
    contract: {
      findMany: vi.fn().mockResolvedValue([])
    },
    depositLedger: {
      findMany: vi.fn().mockResolvedValue([])
    },
    paymentOrder: {
      findMany: vi.fn().mockResolvedValue([])
    },
    receivableBill: {
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
      findUnique: vi.fn().mockImplementation(async (args: { select?: { contractId?: boolean } }) => {
        return args.select?.contractId ? authoritativeContractRecord() : workspaceOrderRecord();
      })
    },
    vehicleHandoverWorkOrder: {
      findMany: vi.fn().mockResolvedValue([
        {
          assignedInternalUserId: "field-1",
          customerConfirmedAt: new Date("2026-07-28T08:45:00.000Z"),
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
          operatorType: "INTERNAL",
          status: "PLATFORM_SEALED",
          updatedAt: new Date("2026-07-28T09:00:00.000Z")
        }
      ]),
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

function workspaceOrderRecord() {
  return {
    application: { salesUser: { name: "Owner 001" } },
    customer: { name: "Customer 001" },
    id: "order-1",
    orderNo: "ORD-20260728-001",
    orderStatus: "ACTIVE",
    vehicle: { modelDefinition: { displayName: "Vehicle 001" }, plateNo: null, vehicleNo: "V001" }
  };
}

function authoritativeContractRecord(input?: {
  status?: string;
  tasks?: Array<{ taskStatus: string; updatedAt: Date }>;
}) {
  return {
    contract: {
      esignTasks: input?.tasks ?? [],
      id: "stage1-contract",
      status: input?.status ?? "SIGNED",
      updatedAt: new Date("2026-07-28T09:00:00.000Z")
    },
    contractId: "stage1-contract"
  };
}
