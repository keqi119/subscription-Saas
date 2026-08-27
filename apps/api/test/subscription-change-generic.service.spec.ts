import {
  BusinessType,
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
        effectiveDate: "2026-09-30",
        evidence: [{ fileId: "file-1" }],
        operation: "UPDATE_CONTACT_PREFERENCE",
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
});

interface HarnessOptions {
  activeChange?: boolean;
  changeVersion?: number;
  replay?: "exact" | "mismatch";
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
      PermissionCode.SUBSCRIPTION_CHANGE_CANCEL
    ],
    roles: ["OP"],
    username: "operator"
  };
  const change = changeFixture({ version: options.changeVersion ?? 0 });
  const querySql: string[] = [];
  const prisma = {
    $queryRaw: vi.fn(async (sql: { strings?: readonly string[] }) => {
      querySql.push(sql.strings?.join(" ") ?? String(sql));
      return [];
    }),
    $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => operation(prisma)),
    subscriptionChangeCommand: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        id: "command-1"
      })),
      findUnique: vi.fn(async () => {
        if (!options.replay) return null;
        return {
          actorId: actor.id,
          id: "command-existing",
          idempotencyKey: "replay-key",
          operation: "CREATE_SUBSCRIPTION_CHANGE",
          requestHash:
            options.replay === "exact"
              ? testCommandHash(managedOtherInput("replay-key"))
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
    )
  };
  const repository = new SubscriptionChangeRepository(prisma as never);
  const service = new SubscriptionChangeService(
    repository,
    { write: vi.fn(async () => undefined) } as never,
    extensionService as never,
    { enabled: true, now: () => now, quoteValidityHours: 72 }
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
      effectiveDate: "2026-09-30",
      evidence: [{ fileId: "file-1" }],
      operation: "UPDATE_CONTACT_PREFERENCE",
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
      approvedOperationSnapshot: { operation: "UPDATE_CONTACT_PREFERENCE" },
      beforeSnapshot: {},
      effectiveDate: new Date("2026-09-30T00:00:00.000Z"),
      evidenceSnapshot: [{ fileId: "file-1" }],
      reason: "Governed preference change"
    },
    order: { id: "order-1", orderNo: "ORD-ACTIVE-1" },
    orderId: "order-1",
    quotes: [],
    status: SubscriptionChangeStatus.DRAFT,
    targetSegment: null,
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
