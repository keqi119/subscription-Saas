import { ForbiddenException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  filterWorkspaceActionByPermission,
  OrderWorkspaceResolver,
  OrderWorkspaceService
} from "../src/order/order-workspace.service";
import { projectOrderWorkspaceDetail } from "../src/order/order-workspace-detail-projection";
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
  it("fails closed to explicit order fields for order-view-only detail access", async () => {
    const getOrder = vi.fn().mockResolvedValue(workspaceRawDetail());
    const service = new OrderWorkspaceService(
      workspacePrisma() as never,
      { getOrder } as never,
      new OrderWorkspaceResolver(),
      {} as never
    );
    const user = workspaceUser([PermissionCode.ORDER_VIEW]);

    const detail = await service.getDetail("order-1", user);

    expect(getOrder).toHaveBeenCalledWith("order-1", user);
    expect(detail).toEqual({
      id: "order-1",
      orderNo: "SO-001",
      orderStatus: "ACTIVE"
    });
  });

  it.each([
    {
      expected: {
        customer: {
          grade: "A",
          id: "customer-1",
          identity: { idCardNoPresent: true },
          mobile: "13800000000",
          name: "Customer Sentinel",
          profile: { residenceAddress: "Address Sentinel" }
        },
        customerId: "customer-id-sentinel"
      },
      permissions: [PermissionCode.CUSTOMER_VIEW]
    },
    {
      expected: {
        customerId: "customer-id-sentinel"
      },
      permissions: [PermissionCode.PAYMENT_CREATE]
    },
    {
      expected: {
        riskResult: {
          grade: "A",
          id: "risk-1",
          remark: "Risk Sentinel",
          result: "APPROVED",
          score: 88
        }
      },
      permissions: [PermissionCode.RISK_VIEW]
    },
    {
      expected: {
        application: {
          applicationNo: "APP-SENTINEL",
          id: "application-1",
          status: "APPROVED"
        }
      },
      permissions: [PermissionCode.APPLICATION_VIEW]
    },
    {
      expected: {
        quote: {
          id: "quote-1",
          quoteNo: "QUOTE-SENTINEL",
          status: "CONFIRMED"
        },
        quoteSnapshot: {
          monthlyFeeAmount: 320000,
          quoteNo: "QUOTE-SNAPSHOT-SENTINEL"
        }
      },
      permissions: [PermissionCode.QUOTE_VIEW]
    },
    {
      expected: {
        contract: {
          contractNo: "CONTRACT-SENTINEL",
          id: "contract-1",
          status: "SIGNED"
        },
        contractId: "contract-1",
        contracts: [
          {
            contractNo: "CONTRACT-SENTINEL",
            id: "contract-1",
            status: "SIGNED"
          }
        ]
      },
      permissions: [PermissionCode.CONTRACT_VIEW]
    },
    {
      expected: {
        changes: [
          {
            afterSnapshot: {
              action: "RETURN_TO_PLAN",
              periodMonths: 24
            },
            beforeSnapshot: {
              id: "order-before-sentinel",
              orderNo: "ORDER-BEFORE-SENTINEL",
              orderStatus: "PENDING_CONTRACT"
            },
            changeType: "RETURN_TO_PLAN",
            createdAt: "2026-07-29T00:00:00.000Z",
            id: "change-1",
            reason: "Change Sentinel",
            status: "PENDING"
          }
        ]
      },
      permissions: [PermissionCode.ORDER_CHANGE_VIEW]
    }
  ])(
    "adds only the explicitly permitted $permissions workspace domain",
    async ({ expected, permissions }) => {
      const service = workspaceDetailService();
      const detail = await service.getDetail(
        "order-1",
        workspaceUser([PermissionCode.ORDER_VIEW, ...permissions])
      );

      expect(detail).toEqual({
        id: "order-1",
        orderNo: "SO-001",
        orderStatus: "ACTIVE",
        ...expected
      });
    }
  );

  it("accepts only safe scalar leaves and serializes Date and Decimal values", () => {
    const projected = projectOrderWorkspaceDetail(
      {
        createdAt: new Date("2026-07-29T03:00:00.000Z"),
        customerId: { secret: "customer-id-object-secret" },
        depositAmount: new Prisma.Decimal("123.45"),
        id: { secret: "order-id-object-secret" },
        monthlyFeeAmount: [{ secret: "monthly-fee-array-secret" }],
        orderNo: ["order-no-array-secret"],
        orderStatus: "ACTIVE",
        periodMonths: null,
        quoteSnapshot: {
          createdAt: new Date("2026-07-29T04:00:00.000Z"),
          id: "quote-safe-id",
          monthlyFeeAmount: {
            secret: "quote-monthly-object-secret"
          },
          packageSnapshot: {
            mileagePackage: {
              id: "mileage-safe-id",
              packageNo: ["package-no-array-secret"],
              priceAmount: new Prisma.Decimal("67.89")
            },
            pricing: {
              monthlyFeeAmount: {
                secret: "pricing-monthly-object-secret"
              }
            }
          },
          quoteNo: { secret: "quote-no-object-secret" },
          status: "CONFIRMED",
          updatedAt: new Date(Number.NaN)
        }
      },
      new Set([
        PermissionCode.ORDER_VIEW,
        PermissionCode.PAYMENT_CREATE,
        PermissionCode.QUOTE_VIEW,
        PermissionCode.MILEAGE_PACKAGE_VIEW
      ])
    );

    expect(projected).toEqual({
      createdAt: "2026-07-29T03:00:00.000Z",
      depositAmount: "123.45",
      orderStatus: "ACTIVE",
      periodMonths: null,
      quoteSnapshot: {
        createdAt: "2026-07-29T04:00:00.000Z",
        id: "quote-safe-id",
        packageSnapshot: {
          mileagePackage: {
            id: "mileage-safe-id",
            priceAmount: "67.89"
          }
        },
        status: "CONFIRMED"
      }
    });
    expect(JSON.stringify(projected)).not.toContain("secret");
  });

  it("separates vehicle base, insurance policy, document, and claim permissions", async () => {
    const service = workspaceDetailService();

    const insuranceOnly = await service.getDetail(
      "order-1",
      workspaceUser([
        PermissionCode.ORDER_VIEW,
        PermissionCode.VEHICLE_INSURANCE_VIEW
      ])
    );
    expect(insuranceOnly).not.toHaveProperty("vehicle");

    const vehicleOnly = await service.getDetail(
      "order-1",
      workspaceUser([PermissionCode.ORDER_VIEW, PermissionCode.VEHICLE_VIEW])
    );
    expect(vehicleOnly).toHaveProperty(
      "modelDisplayName",
      "Root Vehicle Model Sentinel"
    );
    expect(vehicleOnly.vehicle).toEqual({
      id: "vehicle-1",
      status: "LEASED",
      vehicleNo: "VEHICLE-SENTINEL",
      vin: "VIN-SENTINEL"
    });

    const policyAccess = await service.getDetail(
      "order-1",
      workspaceUser([
        PermissionCode.ORDER_VIEW,
        PermissionCode.VEHICLE_VIEW,
        PermissionCode.VEHICLE_INSURANCE_VIEW
      ])
    );
    expect(policyAccess.vehicle).toEqual({
      id: "vehicle-1",
      insurancePolicies: [
        {
          id: "policy-1",
          policyNo: "POLICY-SENTINEL",
          policyStatus: "ACTIVE"
        }
      ],
      status: "LEASED",
      vehicleNo: "VEHICLE-SENTINEL",
      vin: "VIN-SENTINEL"
    });

    const documentAndClaimAccess = await service.getDetail(
      "order-1",
      workspaceUser([
        PermissionCode.ORDER_VIEW,
        PermissionCode.VEHICLE_VIEW,
        PermissionCode.VEHICLE_INSURANCE_VIEW,
        PermissionCode.VEHICLE_DOCUMENT_VIEW,
        PermissionCode.INSURANCE_CLAIM_VIEW
      ])
    );
    expect(documentAndClaimAccess.vehicle).toEqual({
      documents: [
        {
          documentStatus: "ACTIVE",
          documentType: "INSURANCE_POLICY",
          fileName: "policy.pdf",
          id: "document-1"
        }
      ],
      id: "vehicle-1",
      insuranceClaims: [
        {
          claimNo: "CLAIM-SENTINEL",
          claimStatus: "SUBMITTED",
          id: "claim-1"
        }
      ],
      insurancePolicies: [
        {
          id: "policy-1",
          policyNo: "POLICY-SENTINEL",
          policyStatus: "ACTIVE"
        }
      ],
      status: "LEASED",
      vehicleNo: "VEHICLE-SENTINEL",
      vin: "VIN-SENTINEL"
    });
  });

  it("never returns customerId through risk, insurance claim, or snapshot domain allowlists", async () => {
    const service = workspaceDetailService();
    const riskOnly = await service.getDetail(
      "order-1",
      workspaceUser([PermissionCode.ORDER_VIEW, PermissionCode.RISK_VIEW])
    );
    expect(riskOnly).not.toHaveProperty("customerId");
    expect(riskOnly.riskResult).not.toHaveProperty("customerId");

    const claimOnly = await service.getDetail(
      "order-1",
      workspaceUser([
        PermissionCode.ORDER_VIEW,
        PermissionCode.VEHICLE_VIEW,
        PermissionCode.VEHICLE_INSURANCE_VIEW,
        PermissionCode.INSURANCE_CLAIM_VIEW
      ])
    );
    expect(claimOnly).not.toHaveProperty("customerId");
    expect(claimOnly.vehicle?.insuranceClaims?.[0]).not.toHaveProperty(
      "customerId"
    );
  });

  it("keeps customerId out of every narrow-domain scalar allowlist", () => {
    const projectionSource = readFileSync(
      join(
        process.cwd(),
        "src",
        "order",
        "order-workspace-detail-projection.ts"
      ),
      "utf8"
    );
    for (const [start, end] of [
      ["const WORKSPACE_RISK_FIELDS", "const WORKSPACE_VEHICLE_FIELDS"],
      [
        "const WORKSPACE_INSURANCE_CLAIM_FIELDS",
        "const WORKSPACE_QUOTE_SNAPSHOT_FIELDS"
      ],
      [
        "const WORKSPACE_QUOTE_SNAPSHOT_FIELDS",
        "const WORKSPACE_QUOTE_PRICING_FIELDS"
      ],
      [
        "const WORKSPACE_CHANGE_AFTER_FIELDS",
        "const WORKSPACE_CHANGE_AFTER_PRODUCT_FIELDS"
      ]
    ] as const) {
      const allowlist = projectionSource.slice(
        projectionSource.indexOf(start),
        projectionSource.indexOf(end)
      );
      expect(allowlist).not.toContain('"customerId"');
    }
  });

  it("recursively projects a production quote snapshot by sibling-domain permissions", () => {
    const rawDetail = { quoteSnapshot: workspaceProductionQuoteSnapshot() };
    const quoteOnly = projectOrderWorkspaceDetail(
      rawDetail,
      new Set([PermissionCode.QUOTE_VIEW])
    );

    expect(quoteOnly.quoteSnapshot).toEqual({
      id: "quote-snapshot-1",
      monthlyFeeAmount: 320000,
      packageSnapshot: {
        pricing: {
          monthlyFeeAmount: 320000
        }
      },
      periodMonths: 12,
      quoteNo: "QUOTE-SNAPSHOT-001",
      status: "CONFIRMED"
    });

    const customerAccess = projectOrderWorkspaceDetail(
      rawDetail,
      new Set([PermissionCode.QUOTE_VIEW, PermissionCode.CUSTOMER_VIEW])
    );
    expect(customerAccess.quoteSnapshot).toEqual(
      expect.objectContaining({
        customer: {
          grade: "A",
          id: "customer-snapshot-1",
          mobile: "13800000000",
          name: "Snapshot Customer"
        },
        customerId: "customer-snapshot-1"
      })
    );

    const applicationAccess = projectOrderWorkspaceDetail(
      rawDetail,
      new Set([PermissionCode.QUOTE_VIEW, PermissionCode.APPLICATION_VIEW])
    );
    expect(applicationAccess.quoteSnapshot).toEqual(
      expect.objectContaining({
        application: {
          applicationNo: "APP-SNAPSHOT-001",
          id: "application-snapshot-1",
          status: "APPROVED"
        },
        applicationId: "application-snapshot-1"
      })
    );

    const riskAccess = projectOrderWorkspaceDetail(
      rawDetail,
      new Set([PermissionCode.QUOTE_VIEW, PermissionCode.RISK_VIEW])
    );
    expect(riskAccess.quoteSnapshot).toEqual(
      expect.objectContaining({
        defaultRate: 0.08,
        depositRuleSnapshot: {
          defaultRate: 0.08,
          depositAmount: 500000,
          grade: "A",
          id: "deposit-rule-1"
        },
        riskResult: {
          grade: "A",
          id: "risk-snapshot-1",
          result: "APPROVED",
          score: 88
        },
        riskResultId: "risk-snapshot-1",
        riskScore: 88
      })
    );

    const vehicleAccess = projectOrderWorkspaceDetail(
      rawDetail,
      new Set([PermissionCode.QUOTE_VIEW, PermissionCode.VEHICLE_VIEW])
    );
    expect(vehicleAccess.quoteSnapshot).toEqual(
      expect.objectContaining({
        assetLocation: "Shanghai",
        batteryCapacityKwh: 75,
        brand: "NIO",
        currentMileageKm: 12000,
        currentSalePriceAmount: 20000000,
        packageSnapshot: expect.objectContaining({
          pricing: expect.objectContaining({
            currentSalePriceAmount: 20000000
          })
        }),
        plateNo: "沪A00001",
        series: "ET5",
        vehicle: expect.objectContaining({
          id: "vehicle-snapshot-1",
          vin: "VIN-SNAPSHOT-001"
        }),
        vehicleId: "vehicle-snapshot-1",
        vehicleSnapshot: expect.objectContaining({
          id: "vehicle-snapshot-1",
          vin: "VIN-SNAPSHOT-001"
        }),
        vin: "VIN-SNAPSHOT-001"
      })
    );

    const allProjected = projectOrderWorkspaceDetail(
      rawDetail,
      new Set(Object.values(PermissionCode))
    );
    expect(JSON.stringify(allProjected)).not.toContain("future-secret");
    expect(JSON.stringify(allProjected)).not.toContain("provider-secret");
    expect(JSON.stringify(allProjected)).not.toContain("id-card-secret");
  });

  it.each([
    {
      allowed: [
        "mileage-package-new",
        "MILEAGE-PACKAGE-NEW",
        "mileage-price-new"
      ],
      permission: PermissionCode.MILEAGE_PACKAGE_VIEW
    },
    {
      allowed: ["energy-package-new", "ENERGY-PACKAGE-NEW", "energy-price-new"],
      permission: PermissionCode.ENERGY_PACKAGE_VIEW
    },
    {
      allowed: [
        "benefit-package-new",
        "BENEFIT-PACKAGE-NEW",
        "benefit-price-new"
      ],
      permission: PermissionCode.BENEFIT_PACKAGE_VIEW
    },
    {
      allowed: [
        "vehicle-package-new",
        "VEHICLE-PACKAGE-NEW",
        "vehicle-base-fee-new"
      ],
      permission: PermissionCode.VEHICLE_PACKAGE_VIEW
    },
    {
      allowed: ["plan-new", "PLAN-NEW"],
      permission: PermissionCode.SUBSCRIPTION_PLAN_VIEW
    },
    {
      allowed: ["product-new", "PRODUCT-NEW"],
      permission: PermissionCode.PRODUCT_VIEW
    },
    {
      allowed: ["product-version-new", "VERSION-NEW"],
      permission: PermissionCode.PRODUCT_VERSION_VIEW
    },
    {
      allowed: ["quote-after-new", "QUOTE-AFTER-NEW", "quote-monthly-new"],
      permission: PermissionCode.QUOTE_VIEW
    }
  ])(
    "projects only the $permission domain from a production change quote snapshot",
    ({ allowed, permission }) => {
      const rawDetail = {
        changes: [workspaceProductionOrderChange()],
        id: "order-1"
      };
      const projected = projectOrderWorkspaceDetail(
        rawDetail,
        new Set([PermissionCode.ORDER_CHANGE_VIEW, permission])
      );
      const serialized = JSON.stringify(projected.changes?.[0]?.afterSnapshot);
      const allDomainSentinels = [
        "mileage-package-new",
        "MILEAGE-PACKAGE-NEW",
        "mileage-price-new",
        "energy-package-new",
        "ENERGY-PACKAGE-NEW",
        "energy-price-new",
        "benefit-package-new",
        "BENEFIT-PACKAGE-NEW",
        "benefit-price-new",
        "vehicle-package-new",
        "VEHICLE-PACKAGE-NEW",
        "vehicle-base-fee-new",
        "plan-new",
        "PLAN-NEW",
        "product-new",
        "PRODUCT-NEW",
        "product-version-new",
        "VERSION-NEW",
        "quote-after-new",
        "QUOTE-AFTER-NEW",
        "quote-monthly-new"
      ];

      for (const sentinel of allowed) {
        expect(serialized).toContain(sentinel);
      }
      for (const sentinel of allDomainSentinels.filter(
        (sentinel) => !allowed.includes(sentinel)
      )) {
        expect(serialized).not.toContain(sentinel);
      }
    }
  );

  it("does not accept sibling package fields through a permitted package object", () => {
    const projected = projectOrderWorkspaceDetail(
      {
        changes: [
          {
            afterSnapshot: {
              packageSnapshot: {
                mileagePackage: {
                  benefitCount: "benefit-field-secret",
                  id: "mileage-package-safe",
                  monthlyEnergyKwh: "energy-field-secret",
                  monthlyMileageKm: 1500,
                  packageNo: "MILEAGE-SAFE",
                  productId: "product-field-secret",
                  vehicleModel: "vehicle-field-secret"
                }
              }
            },
            id: "change-1"
          }
        ]
      },
      new Set([
        PermissionCode.ORDER_CHANGE_VIEW,
        PermissionCode.MILEAGE_PACKAGE_VIEW
      ])
    );

    expect(projected.changes?.[0]?.afterSnapshot).toEqual({
      packageSnapshot: {
        mileagePackage: {
          id: "mileage-package-safe",
          monthlyMileageKm: 1500,
          packageNo: "MILEAGE-SAFE"
        }
      }
    });
    expect(JSON.stringify(projected)).not.toContain("field-secret");
  });

  it("projects order change snapshots without leaking sibling order domains", () => {
    const rawDetail = {
      changes: [workspaceProductionOrderChange()],
      id: "order-1",
      orderNo: "SO-001",
      orderStatus: "ACTIVE"
    };
    const changeOnly = projectOrderWorkspaceDetail(
      rawDetail,
      new Set([PermissionCode.ORDER_CHANGE_VIEW])
    ).changes?.[0];

    expect(changeOnly).toEqual({
      afterSnapshot: {
        action: "RETURN_TO_PLAN",
        changeStage: "PRE_CONTRACT_RETURN_TO_PLAN",
        changeType: "PLAN_CHANGE",
        orderSource: "SALES_ASSISTED",
        periodMonths: 24
      },
      beforeSnapshot: {
        id: "order-before-1",
        monthlyFeeAmount: 320000,
        orderNo: "ORDER-BEFORE-001",
        orderSource: "SALES_ASSISTED",
        orderStatus: "PENDING_CONTRACT",
        periodMonths: 12
      },
      changeType: "PLAN_CHANGE",
      id: "change-snapshot-1",
      status: "PENDING"
    });
    expect(JSON.stringify(changeOnly)).not.toContain("unknown-user-secret");
    expect(JSON.stringify(changeOnly)).not.toContain("customer-snapshot-1");
    expect(JSON.stringify(changeOnly)).not.toContain("application-snapshot-1");
    expect(JSON.stringify(changeOnly)).not.toContain("risk-snapshot-1");
    expect(JSON.stringify(changeOnly)).not.toContain("vehicle-snapshot-1");
    expect(JSON.stringify(changeOnly)).not.toContain("QUOTE-SNAPSHOT-001");

    const customerAccess = projectOrderWorkspaceDetail(
      rawDetail,
      new Set([
        PermissionCode.ORDER_CHANGE_VIEW,
        PermissionCode.CUSTOMER_VIEW
      ])
    ).changes?.[0];
    expect(customerAccess?.beforeSnapshot).toEqual(
      expect.objectContaining({
        customer: expect.objectContaining({
          id: "customer-snapshot-1"
        }),
        customerId: "customer-snapshot-1"
      })
    );

    const applicationAccess = projectOrderWorkspaceDetail(
      rawDetail,
      new Set([
        PermissionCode.ORDER_CHANGE_VIEW,
        PermissionCode.APPLICATION_VIEW
      ])
    ).changes?.[0];
    expect(applicationAccess?.beforeSnapshot).toEqual(
      expect.objectContaining({
        application: expect.objectContaining({
          id: "application-snapshot-1"
        })
      })
    );

    const riskAccess = projectOrderWorkspaceDetail(
      rawDetail,
      new Set([PermissionCode.ORDER_CHANGE_VIEW, PermissionCode.RISK_VIEW])
    ).changes?.[0];
    expect(riskAccess?.beforeSnapshot).toEqual(
      expect.objectContaining({
        riskResult: expect.objectContaining({ id: "risk-snapshot-1" })
      })
    );

    const quoteAccess = projectOrderWorkspaceDetail(
      rawDetail,
      new Set([PermissionCode.ORDER_CHANGE_VIEW, PermissionCode.QUOTE_VIEW])
    ).changes?.[0];
    expect(quoteAccess?.beforeSnapshot).toEqual(
      expect.objectContaining({
        quoteSnapshot: expect.objectContaining({
          quoteNo: "QUOTE-SNAPSHOT-001"
        })
      })
    );
    expect(quoteAccess?.afterSnapshot).toEqual(
      expect.objectContaining({
        monthlyFeeAmount: "quote-monthly-new",
        quoteSnapshot: expect.objectContaining({
          id: "quote-after-new",
          quoteNo: "QUOTE-AFTER-NEW"
        })
      })
    );
    expect(quoteAccess?.afterSnapshot).not.toHaveProperty(
      "subscriptionPlanId"
    );
    expect(quoteAccess?.afterSnapshot).not.toHaveProperty(
      "vehicleBaseFeeAmount"
    );

    const productAccess = projectOrderWorkspaceDetail(
      rawDetail,
      new Set([PermissionCode.ORDER_CHANGE_VIEW, PermissionCode.PRODUCT_VIEW])
    ).changes?.[0];
    expect(productAccess?.afterSnapshot).toEqual(
      expect.objectContaining({
        productId: "product-new",
        product: expect.objectContaining({ productNo: "PRODUCT-NEW" })
      })
    );
    expect(productAccess?.afterSnapshot).not.toHaveProperty(
      "subscriptionPlanId"
    );
    expect(productAccess?.afterSnapshot).not.toHaveProperty(
      "vehicleBaseFeeAmount"
    );

    const vehicleAccess = projectOrderWorkspaceDetail(
      rawDetail,
      new Set([PermissionCode.ORDER_CHANGE_VIEW, PermissionCode.VEHICLE_VIEW])
    ).changes?.[0];
    expect(vehicleAccess?.beforeSnapshot).toEqual(
      expect.objectContaining({
        vehicle: expect.objectContaining({ id: "vehicle-snapshot-1" })
      })
    );
    expect(vehicleAccess?.afterSnapshot).toEqual(
      expect.objectContaining({ vehicleId: "vehicle-new" })
    );
  });

  it("returns every explicitly permitted workspace domain for an Admin permission set", async () => {
    const detail = await workspaceDetailService().getDetail(
      "order-1",
      workspaceUser(Object.values(PermissionCode))
    );

    expect(detail).toEqual(
      expect.objectContaining({
        application: expect.objectContaining({ id: "application-1" }),
        changes: [expect.objectContaining({ id: "change-1" })],
        contract: expect.objectContaining({ id: "contract-1" }),
        contracts: [expect.objectContaining({ id: "contract-1" })],
        customer: expect.objectContaining({ id: "customer-1" }),
        quote: expect.objectContaining({ id: "quote-1" }),
        quoteSnapshot: {
          monthlyFeeAmount: 320000,
          quoteNo: "QUOTE-SNAPSHOT-SENTINEL"
        },
        riskResult: expect.objectContaining({ id: "risk-1" }),
        vehicle: expect.objectContaining({
          id: "vehicle-1",
          insuranceClaims: [expect.objectContaining({ id: "claim-1" })],
          insurancePolicies: [expect.objectContaining({ id: "policy-1" })]
        })
      })
    );
    expect(detail).not.toHaveProperty("futureSecret");
  });

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

  it("loads a scoped service case for an SA-owned order and stops before lookup for another sales order", async () => {
    const saUser = {
      ...workspaceUser([
        PermissionCode.ORDER_VIEW,
        PermissionCode.SERVICE_CASE_VIEW
      ]),
      id: "sales-user-1",
      roles: ["SA"]
    };
    const getOrder = vi.fn(async (orderId: string) => {
      if (orderId === "other-sales-order") {
        throw new ForbiddenException("Order is outside your scope.");
      }
      return { id: orderId };
    });
    const getAdminServiceCaseForOrder = vi.fn().mockResolvedValue({
      id: "service-case-1",
      order: { id: "owned-order" }
    });
    const service = new OrderWorkspaceService(
      workspacePrisma() as never,
      { getOrder } as never,
      new OrderWorkspaceResolver(),
      { getAdminServiceCaseForOrder } as never
    );

    await expect(
      service.getServiceCase("owned-order", "service-case-1", saUser)
    ).resolves.toEqual({
      id: "service-case-1",
      order: { id: "owned-order" }
    });
    await expect(
      service.getServiceCase("other-sales-order", "service-case-2", saUser)
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(getOrder).toHaveBeenNthCalledWith(1, "owned-order", saUser);
    expect(getOrder).toHaveBeenNthCalledWith(2, "other-sales-order", saUser);
    expect(getAdminServiceCaseForOrder).toHaveBeenCalledTimes(1);
    expect(getAdminServiceCaseForOrder).toHaveBeenCalledWith(
      "owned-order",
      "service-case-1"
    );
  });

  it("stops before contributor queries when the existing order access check rejects sales scope", async () => {
    const getOrder = vi.fn().mockRejectedValue(new ForbiddenException("Order is outside your scope."));
    const prisma = workspacePrisma();
    const service = new OrderWorkspaceService(
      prisma as never,
      { getOrder } as never,
      new OrderWorkspaceResolver(),
      {} as never
    );

    await expect(service.getSummary("order-1", workspaceUser())).rejects.toBeInstanceOf(ForbiddenException);
    expect(getOrder).toHaveBeenCalledWith("order-1", workspaceUser());
    expect(prisma.subscriptionOrder.findUnique).not.toHaveBeenCalled();
    expect(prisma.vehicleHandoverWorkOrder.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing legacy application", null, null],
    ["a missing legacy sales user", { salesUser: null }, null],
    ["an assigned sales user", { salesUser: { name: "Owner Sentinel" } }, "Owner Sentinel"]
  ])(
    "resolves a safe owner label for %s",
    async (_case, application, expectedOwnerLabel) => {
      const prisma = workspacePrisma();
      prisma.subscriptionOrder.findUnique.mockImplementation(
        async (args: { select?: { contractId?: boolean } }) =>
          args.select?.contractId
            ? authoritativeContractRecord()
            : { ...workspaceOrderRecord(), application }
      );
      const resolver = new OrderWorkspaceResolver();
      const resolve = vi.spyOn(resolver, "resolve");
      const service = new OrderWorkspaceService(
        prisma as never,
        { getOrder: vi.fn().mockResolvedValue({ id: "order-1" }) } as never,
        resolver,
        {} as never
      );

      const summary = await service.getSummary("order-1", workspaceUser());

      expect(summary.header.ownerLabel).toBe(expectedOwnerLabel);
      expect(resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          header: expect.objectContaining({ ownerLabel: expectedOwnerLabel })
        })
      );
    }
  );

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
      new OrderWorkspaceResolver(),
      {} as never
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

  it.each([
    {
      expectedTarget: "delivery-work-order",
      expectedTypes: ["DELIVERY_OUTBOUND"],
      permissions: [PermissionCode.DELIVERY_VIEW]
    },
    {
      expectedTarget: "return-work-order",
      expectedTypes: ["RETURN_INBOUND"],
      permissions: [PermissionCode.VEHICLE_RETURN_VIEW]
    },
    {
      expectedTarget: "delivery-work-order",
      expectedTypes: ["DELIVERY_OUTBOUND", "RETURN_INBOUND"],
      permissions: [
        PermissionCode.DELIVERY_VIEW,
        PermissionCode.VEHICLE_RETURN_VIEW
      ]
    }
  ])(
    "isolates handover summary query to $expectedTypes",
    async ({ expectedTarget, expectedTypes, permissions }) => {
    const prisma = workspacePrisma();
    const mixedWorkOrders = [
      workspaceHandoverWorkOrder({
        handoverType: "DELIVERY_OUTBOUND",
        id: "delivery-work-order",
        updatedAt: "2026-07-28T08:00:00.000Z"
      }),
      workspaceHandoverWorkOrder({
        handoverType: "RETURN_INBOUND",
        id: "return-work-order",
        updatedAt: "2026-07-28T09:00:00.000Z"
      })
    ];
    prisma.vehicleHandoverWorkOrder.findMany.mockImplementation(
      async (args: {
        where: { handoverType: { in: string[] } };
      }) =>
        mixedWorkOrders.filter((workOrder) =>
          args.where.handoverType.in.includes(workOrder.handoverType)
        )
    );

    const summary = await workspaceService(prisma).getSummary(
      "order-1",
      workspaceUser([
        PermissionCode.ORDER_VIEW,
        ...permissions
      ])
    );

    expect(prisma.vehicleHandoverWorkOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          handoverType: { in: expectedTypes },
          orderId: "order-1"
        }
      })
    );
    expect(summary.guidance.map(({ category }) => category)).toEqual([
      "handover"
    ]);
    expect(summary.tabBadges.map(({ tab }) => tab)).toEqual(["handover"]);
    expect(
      summary.guidance.find(({ category }) => category === "handover")
        ?.targetRecordId
    ).toBe(expectedTarget);
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

  it("targets the newest-created ACTIVE entitlement account returned by the tab", async () => {
    const prisma = workspacePrisma();
    prisma.orderEntitlementAccount.findFirst.mockImplementation(
      async (args: {
        where?: { accountStatus?: string };
      }) =>
        args.where?.accountStatus === "ACTIVE"
          ? {
              accountStatus: "ACTIVE",
              grants: [{ status: "ACTIVE" }],
              id: "active-account",
              updatedAt: new Date("2026-07-20T00:00:00.000Z")
            }
          : {
              accountStatus: "SUSPENDED",
              grants: [],
              id: "newer-suspended-account",
              updatedAt: new Date("2026-07-29T00:00:00.000Z")
            }
    );

    const summary = await workspaceService(prisma).getSummary(
      "order-1",
      workspaceUser([
        PermissionCode.ORDER_VIEW,
        PermissionCode.ENTITLEMENT_VIEW
      ])
    );

    expect(prisma.orderEntitlementAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: "desc" },
        where: {
          accountStatus: "ACTIVE",
          deletedAt: null,
          orderId: "order-1"
        }
      })
    );
    expect(
      summary.guidance.find(({ category }) => category === "entitlement")
    ).toEqual(
      expect.objectContaining({
        reasonCode: "ENTITLEMENT_CURRENT",
        state: "COMPLETED",
        targetRecordId: "active-account"
      })
    );
  });

  it("does not target a suspended account when no ACTIVE entitlement exists", async () => {
    const prisma = workspacePrisma();
    prisma.orderEntitlementAccount.findFirst.mockImplementation(
      async (args: {
        where?: { accountStatus?: string };
      }) =>
        args.where?.accountStatus === "ACTIVE"
          ? null
          : {
              accountStatus: "SUSPENDED",
              grants: [],
              id: "suspended-only-account",
              updatedAt: new Date("2026-07-29T00:00:00.000Z")
            }
    );

    const summary = await workspaceService(prisma).getSummary(
      "order-1",
      workspaceUser([
        PermissionCode.ORDER_VIEW,
        PermissionCode.ENTITLEMENT_VIEW
      ])
    );

    expect(
      summary.guidance.find(({ category }) => category === "entitlement")
    ).toEqual(
      expect.objectContaining({
        reasonCode: "ENTITLEMENT_ACTIVATION_REQUIRED",
        state: "ACTION_REQUIRED",
        targetRecordId: null
      })
    );
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

function workspaceDetailService() {
  return new OrderWorkspaceService(
    workspacePrisma() as never,
    { getOrder: vi.fn().mockResolvedValue(workspaceRawDetail()) } as never,
    new OrderWorkspaceResolver(),
    {} as never
  );
}

function workspaceRawDetail() {
  return {
    application: {
      applicationNo: "APP-SENTINEL",
      id: "application-1",
      salesUserId: "sales-user-secret",
      status: "APPROVED"
    },
    changes: [
      {
        afterSnapshot: {
          action: "RETURN_TO_PLAN",
          periodMonths: 24,
          unknownInput: "change-after-unknown-secret"
        },
        beforeSnapshot: {
          futureField: "change-before-unknown-secret",
          id: "order-before-sentinel",
          orderNo: "ORDER-BEFORE-SENTINEL",
          orderStatus: "PENDING_CONTRACT"
        },
        changeType: "RETURN_TO_PLAN",
        createdAt: "2026-07-29T00:00:00.000Z",
        deletedAt: null,
        id: "change-1",
        providerSecret: "change-provider-secret",
        reason: "Change Sentinel",
        status: "PENDING"
      }
    ],
    contract: {
      contractNo: "CONTRACT-SENTINEL",
      contractSnapshot: { secret: "contract-snapshot-secret" },
      id: "contract-1",
      status: "SIGNED"
    },
    contractId: "contract-1",
    contracts: [
      {
        contractNo: "CONTRACT-SENTINEL",
        contractSnapshot: { secret: "contract-snapshot-secret" },
        id: "contract-1",
        status: "SIGNED"
      }
    ],
    customer: {
      grade: "A",
      id: "customer-1",
      identity: {
        idCardNo: "RAW-ID-CARD-SECRET",
        idCardNoPresent: true
      },
      mobile: "13800000000",
      name: "Customer Sentinel",
      profile: { residenceAddress: "Address Sentinel" },
      providerSecret: "customer-provider-secret"
    },
    customerId: "customer-id-sentinel",
    futureSecret: "future-order-field-secret",
    id: "order-1",
    modelDisplayName: "Root Vehicle Model Sentinel",
    orderNo: "SO-001",
    orderStatus: "ACTIVE",
    productVersion: { providerSecret: "product-version-secret" },
    quote: {
      id: "quote-1",
      packageSnapshot: { secret: "nested-quote-snapshot-secret" },
      quoteNo: "QUOTE-SENTINEL",
      status: "CONFIRMED"
    },
    quoteSnapshot: {
      futureField: "quote-snapshot-unknown-secret",
      monthlyFeeAmount: 320000,
      quoteNo: "QUOTE-SNAPSHOT-SENTINEL"
    },
    riskResult: {
      customerId: "risk-customer-id-secret",
      grade: "A",
      id: "risk-1",
      providerSecret: "risk-provider-secret",
      remark: "Risk Sentinel",
      result: "APPROVED",
      score: 88
    },
    vehicle: {
      documents: [
        {
          bucket: "private-bucket-secret",
          documentStatus: "ACTIVE",
          documentType: "INSURANCE_POLICY",
          fileName: "policy.pdf",
          id: "document-1",
          objectKey: "private-object-secret"
        }
      ],
      id: "vehicle-1",
      insuranceClaims: [
        {
          claimNo: "CLAIM-SENTINEL",
          claimStatus: "SUBMITTED",
          customerId: "claim-customer-id-secret",
          id: "claim-1",
          snapshot: { secret: "claim-snapshot-secret" }
        }
      ],
      insurancePolicies: [
        {
          id: "policy-1",
          policyNo: "POLICY-SENTINEL",
          policyStatus: "ACTIVE",
          snapshot: { secret: "policy-snapshot-secret" }
        }
      ],
      providerSecret: "vehicle-provider-secret",
      status: "LEASED",
      vehicleNo: "VEHICLE-SENTINEL",
      vin: "VIN-SENTINEL"
    }
  };
}

function workspaceProductionQuoteSnapshot() {
  return {
    application: {
      applicationNo: "APP-SNAPSHOT-001",
      futureSecret: "application-future-secret",
      id: "application-snapshot-1",
      salesUserId: "application-provider-secret",
      status: "APPROVED"
    },
    applicationId: "application-snapshot-1",
    assetLocation: "Shanghai",
    batteryCapacityKwh: 75,
    brand: "NIO",
    currentMileageKm: 12000,
    currentSalePriceAmount: 20000000,
    customer: {
      grade: "A",
      id: "customer-snapshot-1",
      identity: { idCardNo: "id-card-secret" },
      mobile: "13800000000",
      name: "Snapshot Customer",
      providerPayload: "customer-provider-secret"
    },
    customerId: "customer-snapshot-1",
    defaultRate: 0.08,
    depositRuleSnapshot: {
      defaultRate: 0.08,
      depositAmount: 500000,
      grade: "A",
      id: "deposit-rule-1",
      providerPayload: "risk-provider-secret"
    },
    futureField: "quote-future-secret",
    id: "quote-snapshot-1",
    monthlyFeeAmount: 320000,
    packageSnapshot: {
      futureField: "package-future-secret",
      mileagePackage: {
        futureField: "mileage-future-secret",
        id: "mileage-package-1",
        monthlyMileageKm: 1500,
        overMileageFeeAmount: 100,
        packageName: "1500 km",
        packageNo: "MILEAGE-1500",
        priceAmount: 30000
      },
      pricing: {
        currentSalePriceAmount: 20000000,
        fixedRate: 0.03,
        futureField: "pricing-future-secret",
        monthlyFeeAmount: 320000,
        vehicleBaseFeeAmount: 250000
      },
      subscriptionPlan: {
        futureField: "plan-future-secret",
        id: "plan-1",
        planName: "Standard Plan",
        planNo: "PLAN-001"
      },
      vehicleBaseFeeAmount: 250000
    },
    periodMonths: 12,
    plateNo: "沪A00001",
    quoteNo: "QUOTE-SNAPSHOT-001",
    riskResult: {
      grade: "A",
      id: "risk-snapshot-1",
      providerPayload: "risk-provider-secret",
      result: "APPROVED",
      score: 88
    },
    riskResultId: "risk-snapshot-1",
    riskScore: 88,
    series: "ET5",
    status: "CONFIRMED",
    subscriptionPlanId: "plan-1",
    vehicle: {
      brand: "NIO",
      id: "vehicle-snapshot-1",
      providerPayload: "vehicle-provider-secret",
      vehicleNo: "VEH-SNAPSHOT-001",
      vin: "VIN-SNAPSHOT-001"
    },
    vehicleBaseFeeAmount: 250000,
    vehicleId: "vehicle-snapshot-1",
    vehicleSnapshot: {
      assetLocation: "Shanghai",
      batteryCapacityKwh: 75,
      brand: "NIO",
      currentMileageKm: 12000,
      currentSalePriceAmount: 20000000,
      futureField: "vehicle-future-secret",
      id: "vehicle-snapshot-1",
      plateNo: "沪A00001",
      series: "ET5",
      vehicleNo: "VEH-SNAPSHOT-001",
      vin: "VIN-SNAPSHOT-001"
    },
    vin: "VIN-SNAPSHOT-001"
  };
}

function workspaceProductionOrderChange() {
  return {
    afterSnapshot: {
      action: "RETURN_TO_PLAN",
      benefitPackageId: "benefit-package-new",
      benefitPackagePriceAmount: "benefit-price-new",
      changeStage: "PRE_CONTRACT_RETURN_TO_PLAN",
      changeType: "PLAN_CHANGE",
      customer: { id: "customer-after-secret" },
      energyPackageId: "energy-package-new",
      energyPackagePriceAmount: "energy-price-new",
      mileagePackageId: "mileage-package-new",
      mileagePackagePriceAmount: "mileage-price-new",
      monthlyFeeAmount: "quote-monthly-new",
      orderSource: "SALES_ASSISTED",
      packageSnapshot: {
        benefitPackage: {
          id: "benefit-package-new",
          packageNo: "BENEFIT-PACKAGE-NEW"
        },
        energyPackage: {
          id: "energy-package-new",
          packageNo: "ENERGY-PACKAGE-NEW"
        },
        mileagePackage: {
          id: "mileage-package-new",
          packageNo: "MILEAGE-PACKAGE-NEW"
        },
        pricing: {
          benefitPackagePriceAmount: "benefit-price-new",
          energyPackagePriceAmount: "energy-price-new",
          mileagePackagePriceAmount: "mileage-price-new",
          monthlyFeeAmount: "quote-monthly-new",
          vehicleBaseFeeAmount: "vehicle-base-fee-new"
        },
        subscriptionPlan: {
          id: "plan-new",
          planNo: "PLAN-NEW"
        },
        vehiclePackage: {
          id: "vehicle-package-new",
          packageNo: "VEHICLE-PACKAGE-NEW"
        }
      },
      periodMonths: 24,
      product: {
        id: "product-new",
        productNo: "PRODUCT-NEW"
      },
      productId: "product-new",
      productVersion: {
        id: "product-version-new",
        productId: "product-new",
        versionNo: "VERSION-NEW"
      },
      productVersionId: "product-version-new",
      quoteSnapshot: {
        id: "quote-after-new",
        monthlyFeeAmount: "quote-monthly-new",
        packageSnapshot: {
          benefitPackage: {
            id: "benefit-package-new",
            packageNo: "BENEFIT-PACKAGE-NEW"
          },
          energyPackage: {
            id: "energy-package-new",
            packageNo: "ENERGY-PACKAGE-NEW"
          },
          mileagePackage: {
            id: "mileage-package-new",
            packageNo: "MILEAGE-PACKAGE-NEW"
          },
          subscriptionPlan: {
            id: "plan-new",
            planNo: "PLAN-NEW"
          },
          vehiclePackage: {
            id: "vehicle-package-new",
            packageNo: "VEHICLE-PACKAGE-NEW"
          }
        },
        productId: "product-new",
        productVersionId: "product-version-new",
        quoteNo: "QUOTE-AFTER-NEW",
        subscriptionPlanId: "plan-new",
        vehiclePackageId: "vehicle-package-new"
      },
      riskResult: { id: "risk-after-secret" },
      subscriptionPlanId: "plan-new",
      unknownInput: "unknown-user-secret",
      vehicleBaseFeeAmount: "vehicle-base-fee-new",
      vehicleId: "vehicle-new"
    },
    beforeSnapshot: {
      application: {
        applicationNo: "APP-SNAPSHOT-001",
        id: "application-snapshot-1",
        salesUserId: "application-provider-secret",
        status: "APPROVED"
      },
      changes: [
        {
          afterSnapshot: { unknownInput: "recursive-change-secret" },
          beforeSnapshot: { unknownInput: "recursive-before-secret" },
          id: "recursive-change"
        }
      ],
      customer: {
        grade: "A",
        id: "customer-snapshot-1",
        identity: { idCardNo: "id-card-secret" },
        mobile: "13800000000",
        name: "Snapshot Customer"
      },
      customerId: "customer-snapshot-1",
      futureField: "order-before-future-secret",
      id: "order-before-1",
      monthlyFeeAmount: 320000,
      orderNo: "ORDER-BEFORE-001",
      orderSource: "SALES_ASSISTED",
      orderStatus: "PENDING_CONTRACT",
      periodMonths: 12,
      quoteSnapshot: workspaceProductionQuoteSnapshot(),
      riskResult: {
        grade: "A",
        id: "risk-snapshot-1",
        providerPayload: "risk-provider-secret",
        result: "APPROVED",
        score: 88
      },
      vehicle: {
        id: "vehicle-snapshot-1",
        providerPayload: "vehicle-provider-secret",
        vehicleNo: "VEH-SNAPSHOT-001",
        vin: "VIN-SNAPSHOT-001"
      }
    },
    changeType: "PLAN_CHANGE",
    futureField: "change-future-secret",
    id: "change-snapshot-1",
    status: "PENDING"
  };
}

function workspaceService(prisma: ReturnType<typeof workspacePrisma>) {
  return new OrderWorkspaceService(
    prisma as never,
    { getOrder: vi.fn().mockResolvedValue({ id: "order-1" }) } as never,
    new OrderWorkspaceResolver(),
    {} as never
  );
}

function workspaceHandoverWorkOrder(input: {
  handoverType: "DELIVERY_OUTBOUND" | "RETURN_INBOUND";
  id: string;
  updatedAt: string;
}) {
  return {
    assignedInternalUserId: null,
    customerConfirmedAt: null,
    handover: null,
    handoverType: input.handoverType,
    id: input.id,
    operatorType: "INTERNAL",
    status: "DRAFT",
    updatedAt: new Date(input.updatedAt)
  };
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
