import {
  BusinessType,
  ContractStatus,
  ESignTaskStatus,
  OrderStatus,
  SubscriptionChangePricingMode,
  SubscriptionChangeStatus,
  SubscriptionChangeType,
  VehicleStatus
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionChangeRepository } from "../src/subscription-change/subscription-change.repository";
import { SubscriptionChangeService } from "../src/subscription-change/subscription-change.service";

describe("SubscriptionChangeService", () => {
  it("routes unified EXTENSION creation through the proven extension service", async () => {
    const harness = genericHarness();

    const result = await harness.service.create(
      {
        changeType: SubscriptionChangeType.EXTENSION,
        detail: {
          extensionMonths: 6,
          pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION,
          subscriptionPlanId: "plan-current"
        },
        idempotencyKey: "create-extension-1",
        orderId: "order-1"
      },
      harness.actor,
      harness.context
    );

    expect(harness.extensionService.createExtension).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionMonths: 6,
        idempotencyKey: "create-extension-1",
        orderId: "order-1",
        pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION
      }),
      harness.actor,
      harness.context
    );
    expect(result).toMatchObject({
      allowedActions: expect.arrayContaining(["CREATE_QUOTE", "CANCEL"]),
      changeType: SubscriptionChangeType.EXTENSION
    });
  });

  it.each([
    [
      SubscriptionChangeType.VEHICLE_SWAP,
      {
        plannedSwapAt: "2026-09-15T02:00:00.000Z",
        targetSubscriptionPlanId: "plan-target",
        targetVehicleId: "vehicle-target"
      },
      "vehicleSwapDetail"
    ],
    [
      SubscriptionChangeType.EARLY_TERMINATION,
      { effectiveDate: "2026-09-30", reason: "Customer relocation" },
      "earlyTerminationDetail"
    ],
    [
      SubscriptionChangeType.MANAGED_OTHER,
      {
        beforeSnapshot: { preferredChannel: "SMS" },
        effectiveDate: "2026-09-30",
        evidence: [{ fileId: "file-1" }],
        operation: "UPDATE_CONTACT_PREFERENCE",
        operationPayload: { preferredChannel: "WECHAT" },
        reason: "Governed preference change"
      },
      "managedOtherDetail"
    ]
  ] as const)(
    "creates one typed %s detail behind the shared active-order lock",
    async (changeType, detail, detailField) => {
      const harness = genericHarness();

      const result = await harness.service.create(
        {
          changeType,
          detail,
          idempotencyKey: `create-${changeType}`,
          orderId: "order-1"
        } as never,
        harness.actor,
        harness.context
      );

      expect(harness.prisma.subscriptionChangeOrder.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            changeType,
            [detailField]: { create: expect.any(Object) },
            order: { connect: { id: "order-1" } },
            status: SubscriptionChangeStatus.DRAFT
          })
        })
      );
      expect(result).toMatchObject({ changeType, status: SubscriptionChangeStatus.DRAFT });
      expect(harness.lockedTables()).toEqual(
        expect.arrayContaining([
          "subscription_order",
          "subscription_contract_segment",
          "subscription_change_order"
        ])
      );
      expect(harness.lockedTables().slice(0, 3)).toEqual([
        "subscription_order",
        "subscription_contract_segment",
        "subscription_change_order"
      ]);
    }
  );

  it("fails an ACTIVE-order create before writing when another active change owns the slot", async () => {
    const harness = genericHarness({ activeChange: true });

    await expect(
      harness.service.create(
        managedOtherInput("active-slot-conflict"),
        harness.actor,
        harness.context
      )
    ).rejects.toMatchObject({ code: "ACTIVE_SUBSCRIPTION_CHANGE_EXISTS", status: 409 });
    expect(harness.prisma.subscriptionChangeOrder.create).not.toHaveBeenCalled();
  });

  it.each([
    [SubscriptionChangeType.EXTENSION, "extensionEnabled", "SUBSCRIPTION_EXTENSION_DISABLED"],
    [
      SubscriptionChangeType.VEHICLE_SWAP,
      "vehicleSwapEnabled",
      "SUBSCRIPTION_VEHICLE_SWAP_DISABLED"
    ],
    [
      SubscriptionChangeType.EARLY_TERMINATION,
      "earlyTerminationEnabled",
      "SUBSCRIPTION_EARLY_TERMINATION_DISABLED"
    ],
    [
      SubscriptionChangeType.MANAGED_OTHER,
      "managedOtherEnabled",
      "SUBSCRIPTION_MANAGED_OTHER_DISABLED"
    ]
  ] as const)(
    "fails closed when the %s rollout flag is disabled",
    async (changeType, flag, code) => {
      const harness = genericHarness({ config: { [flag]: false } });

      await expect(
        harness.service.create(
          { ...managedOtherInput(`disabled-${changeType}`), changeType } as never,
          harness.actor,
          harness.context
        )
      ).rejects.toMatchObject({ code, status: 503 });
      expect(harness.prisma.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["reason", { reason: " " }, "MANAGED_OTHER_REASON_REQUIRED"],
    ["effective date", { effectiveDate: "2026-02-30" }, "EFFECTIVE_DATE_INVALID"],
    ["evidence", { evidence: [] }, "MANAGED_OTHER_EVIDENCE_REQUIRED"],
    ["approved operation", { operation: " " }, "MANAGED_OTHER_OPERATION_REQUIRED"],
    ["before snapshot", { beforeSnapshot: {} }, "MANAGED_OTHER_BEFORE_SNAPSHOT_REQUIRED"],
    ["operation payload", { operationPayload: {} }, "MANAGED_OTHER_OPERATION_PAYLOAD_REQUIRED"]
  ] as const)(
    "requires managed-other %s before opening a transaction",
    async (_field, detail, code) => {
      const harness = genericHarness();
      const input = managedOtherInput(`managed-required-${code}`);

      await expect(
        harness.service.create(
          { ...input, detail: { ...input.detail, ...detail } } as never,
          harness.actor,
          harness.context
        )
      ).rejects.toMatchObject({ code });
      expect(harness.prisma.$transaction).not.toHaveBeenCalled();
    }
  );

  it("replays the exact completed create command and rejects an idempotency payload mismatch", async () => {
    const exact = genericHarness({ replay: "exact" });
    const mismatch = genericHarness({ replay: "mismatch" });

    await expect(
      exact.service.create(managedOtherInput("replay-key"), exact.actor, exact.context)
    ).resolves.toMatchObject({ id: "change-existing" });
    await expect(
      mismatch.service.create(managedOtherInput("replay-key"), mismatch.actor, mismatch.context)
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
    expect(exact.prisma.subscriptionChangeOrder.create).not.toHaveBeenCalled();
  });

  it("replays an exact concurrent create after the shared creation lock exposes the winner", async () => {
    const harness = genericHarness({ activeChange: true, concurrentReplay: true });

    await expect(
      harness.service.create(
        managedOtherInput("concurrent-replay-key"),
        harness.actor,
        harness.context
      )
    ).resolves.toMatchObject({ id: "change-existing" });
    expect(harness.prisma.subscriptionChangeCommand.create).toHaveBeenCalledOnce();
    expect(harness.prisma.subscriptionChangeOrder.create).not.toHaveBeenCalled();
  });

  it("returns server-derived allowedActions and enforces optimistic cancellation", async () => {
    const harness = genericHarness({ changeVersion: 3 });

    const view = await harness.service.get("change-existing", harness.actor);
    expect(view.allowedActions).toEqual(expect.arrayContaining(["APPROVE", "CANCEL"]));

    await expect(
      harness.service.cancel(
        "change-existing",
        { idempotencyKey: "cancel-wrong-version", reason: "duplicate request", version: 2 },
        harness.actor,
        harness.context
      )
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });

    const cancelled = await harness.service.cancel(
      "change-existing",
      { idempotencyKey: "cancel-correct-version", reason: "duplicate request", version: 3 },
      harness.actor,
      harness.context
    );
    expect(cancelled).toMatchObject({
      allowedActions: [],
      status: SubscriptionChangeStatus.CANCELLED,
      version: 4
    });
  });

  it("does not advertise quote mutation or republication after customer publication", async () => {
    const harness = genericHarness({
      changeStatus: SubscriptionChangeStatus.QUOTED,
      publishedAt: new Date("2026-08-27T02:00:00.000Z")
    });

    const view = await harness.service.get("change-existing", harness.actor);

    expect(view.allowedActions).not.toEqual(
      expect.arrayContaining(["APPROVE", "CREATE_QUOTE", "PUBLISH_CUSTOMER_CONFIRMATION"])
    );
  });

  it("returns flag availability and removes actions for a disabled change type", async () => {
    const harness = genericHarness({ config: { managedOtherEnabled: false } });

    await expect(harness.service.get("change-existing", harness.actor)).resolves.toMatchObject({
      allowedActions: [],
      featureAvailability: {
        enabled: false,
        flagName: "SUBSCRIPTION_MANAGED_OTHER_ENABLED"
      }
    });
    expect(harness.service.capabilities(harness.actor)).toMatchObject({
      changeTypes: {
        EARLY_TERMINATION: { enabled: true },
        EXTENSION: { enabled: true },
        MANAGED_OTHER: { enabled: false },
        VEHICLE_SWAP: { enabled: true }
      }
    });
    await expect(
      harness.service.cancel(
        "change-existing",
        {
          idempotencyKey: "cancel-disabled-managed-other",
          reason: "Must not bypass the exact rollout flag",
          version: 0
        },
        harness.actor,
        harness.context
      )
    ).rejects.toMatchObject({
      code: "SUBSCRIPTION_MANAGED_OTHER_DISABLED",
      status: 503
    });
    expect(harness.prisma.subscriptionChangeOrder.update).not.toHaveBeenCalled();
  });

  it("keeps a scheduled managed-other change cancellable before execution", async () => {
    const harness = genericHarness({
      changeStatus: SubscriptionChangeStatus.SCHEDULED,
      changeVersion: 1
    });

    const view = await harness.service.get("change-existing", harness.actor);
    expect(view.allowedActions).toContain("CANCEL");

    const cancelled = await harness.service.cancel(
      "change-existing",
      {
        idempotencyKey: "cancel-scheduled-managed-other",
        reason: "Approved operation withdrawn before its effective date",
        version: 1
      },
      harness.actor,
      harness.context
    );

    expect(cancelled).toMatchObject({
      allowedActions: [],
      status: SubscriptionChangeStatus.CANCELLED,
      version: 2
    });
  });

  it("cancels a generated managed-other supplement and its active e-sign task atomically", async () => {
    const harness = genericHarness({
      changeStatus: SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
      changeVersion: 4,
      managedSupplementStatus: ContractStatus.GENERATED
    });

    await expect(
      harness.service.cancel(
        "change-existing",
        {
          idempotencyKey: "cancel-generated-managed-other",
          reason: "Customer withdrew before signing completed",
          version: 4
        },
        harness.actor,
        harness.context
      )
    ).resolves.toMatchObject({
      status: SubscriptionChangeStatus.CANCELLED,
      version: 5
    });
    expect(harness.prisma.contractESignTask.updateMany).toHaveBeenCalledWith({
      data: {
        cancelledAt: new Date("2026-08-27T03:00:00.000Z"),
        taskStatus: ESignTaskStatus.CANCELLED,
        updatedBy: "operator-1"
      },
      where: {
        contractId: "contract-managed-supplement",
        taskStatus: {
          in: [
            ESignTaskStatus.CREATED,
            ESignTaskStatus.WAITING_CUSTOMER,
            ESignTaskStatus.SIGNING,
            ESignTaskStatus.FAILED
          ]
        }
      }
    });
    expect(harness.prisma.contract.updateMany).toHaveBeenCalledWith({
      data: { status: ContractStatus.CANCELLED, updatedBy: "operator-1" },
      where: {
        id: "contract-managed-supplement",
        status: ContractStatus.GENERATED
      }
    });
  });

  it("does not offer or execute ordinary cancellation after a managed-other supplement is archived", async () => {
    const harness = genericHarness({
      changeStatus: SubscriptionChangeStatus.SCHEDULED,
      changeVersion: 5,
      managedSupplementStatus: ContractStatus.ARCHIVED
    });

    const view = await harness.service.get("change-existing", harness.actor);
    expect(view.allowedActions).not.toContain("CANCEL");

    await expect(
      harness.service.cancel(
        "change-existing",
        {
          idempotencyKey: "cancel-archived-managed-other",
          reason: "Cannot revoke signed archived rights through ordinary cancellation",
          version: 5
        },
        harness.actor,
        harness.context
      )
    ).rejects.toMatchObject({
      code: "SUBSCRIPTION_CHANGE_NOT_CANCELLABLE",
      status: 409
    });
    expect(harness.prisma.contract.updateMany).not.toHaveBeenCalled();
  });

  it("offers one governed cancellation exit after an archived managed-other supplement enters manual takeover", async () => {
    const harness = genericHarness({
      changeStatus: SubscriptionChangeStatus.MANUAL_TAKEOVER,
      changeVersion: 6,
      managedSupplementStatus: ContractStatus.ARCHIVED
    });
    harness.actor.permissions.push(PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE);

    const view = await harness.service.get("change-existing", harness.actor);
    expect(view.allowedActions).toContain("CANCEL");
    expect(view.allowedActions).not.toContain("RETRY");

    await expect(
      harness.service.cancel(
        "change-existing",
        {
          idempotencyKey: "cancel-archived-managed-other-takeover",
          reason: "Governed abandonment after offline reconciliation",
          version: 6
        },
        harness.actor,
        harness.context
      )
    ).resolves.toMatchObject({
      cancelReason: "Governed abandonment after offline reconciliation",
      status: SubscriptionChangeStatus.CANCELLED,
      version: 7
    });
    expect(harness.prisma.contractESignTask.updateMany).not.toHaveBeenCalled();
    expect(harness.prisma.contract.updateMany).not.toHaveBeenCalled();
  });

  it("routes manual takeover for non-extension changes through the generic state owner", async () => {
    const harness = genericHarness({ changeVersion: 2 });

    const result = await harness.service.manualTakeover(
      "change-existing",
      {
        idempotencyKey: "manual-managed-other",
        reason: "Evidence requires offline review",
        version: 2
      },
      harness.actor,
      harness.context
    );

    expect(result).toMatchObject({
      manualTakeoverReason: "Evidence requires offline review",
      status: SubscriptionChangeStatus.MANUAL_TAKEOVER,
      version: 3
    });
    expect(harness.extensionService.manualTakeover).not.toHaveBeenCalled();
  });

  it("loads a non-extension audit timeline without using extension projection guards", async () => {
    const harness = genericHarness();

    const result = await harness.service.timeline("change-existing", harness.actor);

    expect(result).toEqual([
      expect.objectContaining({ action: "UPDATE", entityId: "change-existing" })
    ]);
    expect(harness.prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityId: { in: ["change-existing"] }
        })
      })
    );
  });

  it("keeps the Admin extension projection compatible when root facts are null", async () => {
    const harness = genericHarness({ typedExtension: true });

    const view = await harness.service.get("change-existing", harness.actor);

    expect(view).toMatchObject({
      changeType: SubscriptionChangeType.EXTENSION,
      detail: expect.objectContaining({ extensionMonths: 6 }),
      extensionMonths: 6,
      pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION,
      sourceSegment: expect.objectContaining({ id: "segment-base" }),
      targetEndDate: new Date("2027-03-02T00:00:00.000Z"),
      targetStartDate: new Date("2026-09-03T00:00:00.000Z")
    });
  });
});

interface HarnessOptions {
  activeChange?: boolean;
  changeStatus?: SubscriptionChangeStatus;
  changeVersion?: number;
  config?: Partial<{
    earlyTerminationEnabled: boolean;
    extensionEnabled: boolean;
    managedOtherEnabled: boolean;
    vehicleSwapEnabled: boolean;
  }>;
  concurrentReplay?: boolean;
  managedSupplementStatus?: ContractStatus;
  publishedAt?: Date;
  replay?: "exact" | "mismatch";
  typedExtension?: boolean;
}

function genericHarness(options: HarnessOptions = {}) {
  const now = new Date("2026-08-27T03:00:00.000Z");
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  const actor = {
    id: "operator-1",
    menus: [],
    name: "Operator",
    permissions: [
      PermissionCode.SUBSCRIPTION_CHANGE_VIEW,
      PermissionCode.SUBSCRIPTION_CHANGE_CREATE,
      PermissionCode.SUBSCRIPTION_CHANGE_QUOTE,
      "subscription_change:approve",
      PermissionCode.SUBSCRIPTION_CHANGE_CANCEL,
      PermissionCode.SUBSCRIPTION_CHANGE_MANUAL_TAKEOVER
    ],
    roles: ["OP"],
    username: "operator"
  };
  const change = changeFixture({
    ...(options.typedExtension
      ? {
          changeType: SubscriptionChangeType.EXTENSION,
          extensionDetail: {
            extensionMonths: 6,
            priceOverrideApprovedAt: null,
            priceOverrideApprovedBy: null,
            priceOverrideReason: null,
            pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION,
            sourceSegment: { id: "segment-base" },
            sourceSegmentId: "segment-base",
            targetEndDate: new Date("2027-03-02T00:00:00.000Z"),
            targetStartDate: new Date("2026-09-03T00:00:00.000Z")
          },
          extensionMonths: null,
          pricingMode: null,
          sourceSegment: null,
          sourceSegmentId: null,
          targetEndDate: null,
          targetStartDate: null
        }
      : {}),
    status: options.changeStatus ?? SubscriptionChangeStatus.DRAFT,
    customerConfirmationPublishedAt: options.publishedAt ?? null,
    version: options.changeVersion ?? 0
  });
  if (options.managedSupplementStatus) {
    Object.assign(change, {
      contract: {
        id: "contract-managed-supplement",
        status: options.managedSupplementStatus
      },
      contractId: "contract-managed-supplement",
      managedOtherDetail: {
        ...change.managedOtherDetail,
        supplementContractId: "contract-managed-supplement"
      }
    });
  }
  const querySql: string[] = [];
  let commandLookups = 0;
  const prisma = {
    $queryRaw: vi.fn(async (sql: { strings?: readonly string[] }) => {
      querySql.push(sql.strings?.join(" ") ?? String(sql));
      return [];
    }),
    $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => operation(prisma)),
    auditLog: {
      findMany: vi.fn(async () => [
        {
          action: "UPDATE",
          createdAt: now,
          entityId: "change-existing",
          entityType: "subscription_change_order",
          id: "audit-1"
        }
      ])
    },
    contract: {
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    contractESignTask: {
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    subscriptionChangeCommand: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (options.concurrentReplay) throw { code: "P2002" };
        return {
          ...data,
          id: "command-1"
        };
      }),
      findUnique: vi.fn(async () => {
        commandLookups += 1;
        const concurrentReplayVisible = options.concurrentReplay && commandLookups > 1;
        if (!options.replay && !concurrentReplayVisible) return null;
        return {
          actorId: actor.id,
          id: "command-existing",
          idempotencyKey: options.concurrentReplay ? "concurrent-replay-key" : "replay-key",
          operation: "CREATE_SUBSCRIPTION_CHANGE",
          requestHash:
            options.concurrentReplay || options.replay === "exact"
              ? testCommandHash(
                  managedOtherInput(
                    options.concurrentReplay ? "concurrent-replay-key" : "replay-key"
                  )
                )
              : "mismatched-hash",
          resourceId: "change-existing",
          resourceType: "CHANGE"
        };
      }),
      update: vi.fn(async () => ({}))
    },
    subscriptionChangeOrder: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const created = changeFixture({
          changeType: data.changeType as SubscriptionChangeType,
          id: `change-${String(data.changeType).toLowerCase()}`,
          managedOtherDetail: nestedDetail(data, "managedOtherDetail"),
          earlyTerminationDetail: nestedDetail(data, "earlyTerminationDetail"),
          vehicleSwapDetail: nestedDetail(data, "vehicleSwapDetail")
        });
        Object.assign(change, created);
        return created;
      }),
      findFirst: vi.fn(async () => (options.activeChange ? change : null)),
      findMany: vi.fn(async () => [change]),
      findUnique: vi.fn(async () => change),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(change, data, {
          version:
            typeof data.version === "object" && data.version && "increment" in data.version
              ? change.version + Number(data.version.increment)
              : change.version
        });
        return change;
      })
    },
    subscriptionOrder: {
      findUnique: vi.fn(async () => ({
        businessType: BusinessType.SUBSCRIPTION,
        deletedAt: null,
        id: "order-1",
        orderNo: "ORD-ACTIVE-1",
        orderStatus: OrderStatus.ACTIVE,
        vehicle: { id: "vehicle-source", status: VehicleStatus.LEASED },
        vehicleId: "vehicle-source"
      }))
    },
    subscriptionPlan: {
      findUnique: vi.fn(async () => ({ id: "plan-target", vehiclePackageId: "package-target" }))
    }
  };
  const extensionService = {
    createExtension: vi.fn(async () =>
      changeFixture({
        changeType: SubscriptionChangeType.EXTENSION,
        extensionDetail: {
          extensionMonths: 6,
          pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION,
          sourceSegment: { id: "segment-base" },
          targetEndDate: new Date("2027-03-02T00:00:00.000Z"),
          targetStartDate: new Date("2026-09-03T00:00:00.000Z")
        }
      })
    ),
    manualTakeover: vi.fn()
  };
  const repository = new SubscriptionChangeRepository(prisma as never);
  const service = new SubscriptionChangeService(
    repository,
    { write: vi.fn(async () => undefined) } as never,
    extensionService as never,
    {
      earlyTerminationEnabled: true,
      enabled: true,
      extensionEnabled: true,
      managedOtherEnabled: true,
      now: () => now,
      quoteValidityHours: 72,
      vehicleSwapEnabled: true,
      ...options.config
    }
  );
  return {
    actor,
    context,
    extensionService,
    lockedTables: () =>
      querySql.flatMap((sql) =>
        [
          "subscription_order",
          "subscription_contract_segment",
          "subscription_change_order",
          "subscription_plan",
          "vehicle_package",
          "vehicle"
        ].filter((table) => sql.includes(`"${table}"`))
      ),
    prisma,
    service
  };
}

function managedOtherInput(idempotencyKey: string) {
  return {
    changeType: SubscriptionChangeType.MANAGED_OTHER,
    detail: {
      beforeSnapshot: { preferredChannel: "SMS" },
      effectiveDate: "2026-09-30",
      evidence: [{ fileId: "file-1" }],
      operation: "UPDATE_CONTACT_PREFERENCE",
      operationPayload: { preferredChannel: "WECHAT" },
      reason: "Governed preference change"
    },
    idempotencyKey,
    orderId: "order-1"
  } as const;
}

function changeFixture(overrides: Record<string, unknown> = {}) {
  return {
    automationJobs: [],
    cancelReason: null,
    changeNo: "SCO-EXISTING",
    changeType: SubscriptionChangeType.MANAGED_OTHER,
    completionDeadlineAt: new Date("2026-09-30T16:00:00.000Z"),
    confirmedQuote: null,
    contract: null,
    createdAt: new Date("2026-08-27T03:00:00.000Z"),
    currentQuote: null,
    earlyTerminationDetail: null,
    extensionDetail: null,
    id: "change-existing",
    managedOtherDetail: {
      approvedOperationSnapshot: {
        approval: null,
        request: {
          operation: "UPDATE_CONTACT_PREFERENCE",
          operationPayload: { preferredChannel: "WECHAT" }
        }
      },
      beforeSnapshot: { preferredChannel: "SMS" },
      effectiveDate: new Date("2026-09-30T00:00:00.000Z"),
      evidenceSnapshot: [{ fileId: "file-1" }],
      reason: "Governed preference change"
    },
    order: { id: "order-1", orderNo: "ORD-ACTIVE-1" },
    orderId: "order-1",
    pricingMode: null,
    quotes: [],
    status: SubscriptionChangeStatus.DRAFT,
    targetSegment: null,
    targetEndDate: null,
    targetStartDate: null,
    sourceSegment: null,
    sourceSegmentId: null,
    updatedAt: new Date("2026-08-27T03:00:00.000Z"),
    vehicleSwapDetail: null,
    version: 0,
    ...overrides
  };
}

function nestedDetail(data: Record<string, unknown>, field: string) {
  const value = data[field];
  if (!value || typeof value !== "object" || !("create" in value)) return null;
  return value.create;
}

function testCommandHash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)])
    );
  }
  return value;
}
