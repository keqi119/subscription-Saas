import {
  SubscriptionChangeQuoteStatus,
  SubscriptionChangeStatus,
  SubscriptionChangeType,
  VehicleStatus
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionVehicleSwapService } from "../src/subscription-change/subscription-vehicle-swap.service";

describe("SubscriptionVehicleSwapService", () => {
  it("uses the vehicle-swap rollout flag independently from extension", async () => {
    const harness = swapHarness({ extensionEnabled: false, vehicleSwapEnabled: true });

    await expect(
      harness.service.createFormalQuote(
        "change-swap",
        { idempotencyKey: "quote-independent-flag", version: 0 },
        harness.actor,
        harness.context
      )
    ).resolves.toMatchObject({ revision: 1, status: SubscriptionChangeQuoteStatus.FORMAL });
  });

  it("exposes the generated supplement contract to the customer portal", async () => {
    const harness = swapHarness({ formalQuote: true, published: true });
    harness.state.change.contractId = "contract-swap";

    await expect(
      harness.service.getPortalChange("change-swap", harness.customer)
    ).resolves.toMatchObject({
      contractId: "contract-swap",
      customerConfirmationPublishedAt: harness.now.toISOString()
    });
  });

  it("creates successive formal quote revisions and supersedes the previous formal quote", async () => {
    const harness = swapHarness();

    const first = await harness.service.createFormalQuote(
      "change-swap",
      { idempotencyKey: "quote-1", version: 0 },
      harness.actor,
      harness.context
    );
    const second = await harness.service.createFormalQuote(
      "change-swap",
      { idempotencyKey: "quote-2", version: 1 },
      harness.actor,
      harness.context
    );

    expect(first).toMatchObject({ revision: 1, status: SubscriptionChangeQuoteStatus.FORMAL });
    expect(second).toMatchObject({ revision: 2, status: SubscriptionChangeQuoteStatus.FORMAL });
    expect(harness.state.quotes[0]).toMatchObject({
      revision: 1,
      status: SubscriptionChangeQuoteStatus.SUPERSEDED
    });
    expect(harness.state.change).toMatchObject({
      currentQuoteId: second.id,
      status: SubscriptionChangeStatus.QUOTED,
      version: 2
    });
  });

  it("commits the target soft reservation before publishing a quote", async () => {
    const harness = swapHarness({ formalQuote: true });

    const result = await harness.service.publishCustomerConfirmation(
      "change-swap",
      { idempotencyKey: "publish-1", version: 1 },
      harness.actor,
      harness.context
    );

    expect(harness.assetOperations.reserveVehicleForSubscriptionChange).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        changeOrderId: "change-swap",
        vehicleId: "vehicle-target"
      })
    );
    expect(harness.state.targetVehicle.status).toBe(VehicleStatus.REVIEW_RESERVED);
    expect(result).toMatchObject({
      customerConfirmationPublishedAt: harness.now,
      status: SubscriptionChangeStatus.QUOTED,
      version: 2
    });
  });

  it("does not publish when the authoritative target reservation loses a race", async () => {
    const harness = swapHarness({ formalQuote: true, reservationConflict: true });

    await expect(
      harness.service.publishCustomerConfirmation(
        "change-swap",
        { idempotencyKey: "publish-conflict", version: 1 },
        harness.actor,
        harness.context
      )
    ).rejects.toMatchObject({ code: "TARGET_VEHICLE_RESERVATION_CONFLICT" });
    expect(harness.state.change.customerConfirmationPublishedAt).toBeNull();
    expect(harness.state.targetVehicle.status).toBe(VehicleStatus.AVAILABLE);
  });

  it("confirms only the exact published quote revision and commercial hash", async () => {
    const harness = swapHarness({ formalQuote: true, published: true });
    const quote = harness.state.quotes[0]!;

    await expect(
      harness.service.confirmQuote(
        "change-swap",
        {
          commercialSnapshotHash: "different-hash",
          idempotencyKey: "confirm-stale-hash",
          quoteId: quote.id,
          revision: quote.revision,
          version: 2
        },
        harness.customer,
        harness.context
      )
    ).rejects.toMatchObject({ code: "VEHICLE_SWAP_QUOTE_STALE" });

    const result = await harness.service.confirmQuote(
      "change-swap",
      {
        commercialSnapshotHash: harness.commercialSnapshotHash,
        idempotencyKey: "confirm-swap-1",
        quoteId: quote.id,
        revision: quote.revision,
        version: 2
      },
      harness.customer,
      harness.context
    );

    expect(result).toMatchObject({
      confirmedQuoteId: quote.id,
      status: SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
      version: 3
    });
    expect(harness.state.quotes[0]!.status).toBe(SubscriptionChangeQuoteStatus.CUSTOMER_CONFIRMED);
  });

  it("replays the exact portal confirmation and rejects idempotency payload drift", async () => {
    const harness = swapHarness({ formalQuote: true, published: true });
    const quote = harness.state.quotes[0]!;
    const input = {
      commercialSnapshotHash: harness.commercialSnapshotHash,
      idempotencyKey: "portal-confirm-replay-1",
      quoteId: quote.id,
      revision: quote.revision,
      version: 2
    };

    const first = await harness.service.confirmQuote(
      "change-swap",
      input,
      harness.customer,
      harness.context
    );
    const replay = await harness.service.confirmQuote(
      "change-swap",
      input,
      harness.customer,
      harness.context
    );

    expect(replay).toEqual(first);
    expect(harness.state.change.version).toBe(3);
    await expect(
      harness.service.confirmQuote(
        "change-swap",
        { ...input, version: 3 },
        harness.customer,
        harness.context
      )
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" });
  });

  it.each(["reject", "cancel"] as const)(
    "%s releases only the target reservation owned by the change",
    async (operation) => {
      const harness = swapHarness({ formalQuote: true, published: true });
      const quote = harness.state.quotes[0]!;

      if (operation === "reject") {
        await harness.service.rejectQuote(
          "change-swap",
          {
            commercialSnapshotHash: harness.commercialSnapshotHash,
            idempotencyKey: "reject-swap-1",
            quoteId: quote.id,
            reason: "Customer changed plans",
            revision: quote.revision,
            version: 2
          },
          harness.customer,
          harness.context
        );
      } else {
        await harness.service.cancel(
          "change-swap",
          { idempotencyKey: "cancel-swap", reason: "Vehicle no longer needed", version: 2 },
          harness.actor,
          harness.context
        );
      }

      expect(
        harness.assetOperations.releaseVehicleReservationForSubscriptionChange
      ).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          changeOrderId: "change-swap",
          vehicleId: "vehicle-target"
        })
      );
      expect(harness.state.targetVehicle.status).toBe(VehicleStatus.AVAILABLE);
      expect(harness.state.change.status).toBe(SubscriptionChangeStatus.CANCELLED);
    }
  );

  it("expires a published quote, releases its reservation, and returns the change to draft", async () => {
    const harness = swapHarness({ expired: true, formalQuote: true, published: true });

    const result = await harness.service.expireQuote("change-swap");

    expect(result).toMatchObject({
      currentQuoteId: null,
      customerConfirmationPublishedAt: null,
      status: SubscriptionChangeStatus.DRAFT,
      version: 3
    });
    expect(harness.state.quotes[0]!.status).toBe(SubscriptionChangeQuoteStatus.EXPIRED);
    expect(harness.state.targetVehicle.status).toBe(VehicleStatus.AVAILABLE);
  });
});

interface HarnessOptions {
  expired?: boolean;
  extensionEnabled?: boolean;
  formalQuote?: boolean;
  published?: boolean;
  reservationConflict?: boolean;
  vehicleSwapEnabled?: boolean;
}

interface QuoteState extends Record<string, unknown> {
  id: string;
  quoteSnapshot: { commercialSnapshotHash: string };
  revision: number;
  status: SubscriptionChangeQuoteStatus;
  validUntil: Date;
}

interface ChangeState extends Record<string, unknown> {
  confirmedQuoteId: string | null;
  currentQuoteId: string | null;
  customerConfirmationPublishedAt: Date | null;
  status: SubscriptionChangeStatus;
  version: number;
}

function swapHarness(options: HarnessOptions = {}) {
  const now = new Date("2026-08-27T04:00:00.000Z");
  const commercialSnapshotHash = "a".repeat(64);
  const sourceVehicle = {
    currentSalePriceAmount: 18_000_000n,
    deletedAt: null,
    id: "vehicle-source",
    modelDefinitionId: "model-et5",
    purchasePriceAmount: 18_000_000n,
    status: VehicleStatus.LEASED
  };
  const targetVehicle = {
    currentSalePriceAmount: 20_000_000n,
    deletedAt: null,
    id: "vehicle-target",
    modelDefinitionId: "model-es6",
    purchasePriceAmount: 20_000_000n,
    status: options.published ? VehicleStatus.REVIEW_RESERVED : VehicleStatus.AVAILABLE
  };
  const sourceSegment = {
    endDate: new Date("2027-02-28T00:00:00.000Z"),
    energyLimitCount: 4,
    energyLimitKwh: null,
    id: "segment-source",
    mileageLimitKm: 1_500,
    monthlyFeeAmount: 88_000n,
    orderId: "order-1",
    overMileageFeeAmount: 100n,
    planSnapshot: { plan: "source" },
    productId: "product-source",
    productVersionId: "version-source",
    quoteSnapshot: { quote: "source" },
    startDate: new Date("2026-03-01T00:00:00.000Z"),
    subscriptionPlanId: "plan-source"
  };
  const quotes: QuoteState[] = [];
  if (options.formalQuote) {
    quotes.push({
      changeOrderId: "change-swap",
      createdBy: "operator-1",
      depositAmount: 300_000n,
      energyLimitCount: 4,
      energyLimitKwh: null,
      id: "quote-1",
      mileageLimitKm: 1_500,
      monthlyFeeAmount: 88_000n,
      overMileageFeeAmount: 100n,
      pricingMode: "ORIGINAL_PRICE",
      quoteNo: "SCQ-SWAP-1",
      quoteSnapshot: { commercialSnapshotHash },
      revision: 1,
      status: SubscriptionChangeQuoteStatus.FORMAL,
      validUntil: options.expired
        ? new Date(now.getTime() - 1)
        : new Date(now.getTime() + 3_600_000)
    });
  }
  const change: ChangeState = {
    cancelReason: null,
    changeNo: "SCO-SWAP-1",
    changeType: SubscriptionChangeType.VEHICLE_SWAP,
    completionDeadlineAt: new Date("2026-09-15T02:00:00.000Z"),
    confirmedQuoteId: null,
    currentQuoteId: options.formalQuote ? "quote-1" : null,
    customerConfirmationPublishedAt: options.published ? now : null,
    customerConfirmationPublishedBy: options.published ? "operator-1" : null,
    id: "change-swap",
    order: {
      businessType: "SUBSCRIPTION",
      customerId: "customer-1",
      finalDepositAmount: 300_000n,
      id: "order-1",
      orderStatus: "ACTIVE",
      vehicle: sourceVehicle,
      vehicleId: sourceVehicle.id
    },
    orderId: "order-1",
    sourceSegment,
    sourceSegmentId: sourceSegment.id,
    status: options.formalQuote ? SubscriptionChangeStatus.QUOTED : SubscriptionChangeStatus.DRAFT,
    vehicleSwapDetail: {
      commercialSnapshotHash,
      plannedSwapAt: new Date("2026-09-15T02:00:00.000Z"),
      sourceVehicle,
      sourceVehicleId: sourceVehicle.id,
      targetSubscriptionPlanId: "plan-source",
      targetVehicle,
      targetVehicleId: targetVehicle.id,
      targetVehiclePackageId: "package-source"
    },
    version: options.formalQuote ? (options.published ? 2 : 1) : 0
  };
  const commands: Array<Record<string, unknown>> = [];
  const state = { change, commands, quotes, sourceVehicle, targetVehicle };
  const refreshRelations = () => {
    state.change.currentQuote =
      state.quotes.find((quote) => quote.id === state.change.currentQuoteId) ?? null;
    state.change.confirmedQuote =
      state.quotes.find((quote) => quote.id === state.change.confirmedQuoteId) ?? null;
    state.change.quotes = state.quotes;
    return state.change;
  };
  const applyChangeData = (data: Record<string, unknown>) => {
    Object.assign(state.change, data);
    if (data.version && typeof data.version === "object" && "increment" in data.version) {
      state.change.version += Number(data.version.increment);
    }
    refreshRelations();
    return state.change;
  };
  refreshRelations();
  const prisma = {
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => {
      const before = structuredClone(state);
      try {
        return await operation(prisma);
      } catch (error) {
        Object.assign(state.change, before.change);
        state.commands.splice(0, state.commands.length, ...before.commands);
        state.quotes.splice(0, state.quotes.length, ...before.quotes);
        Object.assign(state.targetVehicle, before.targetVehicle);
        refreshRelations();
        throw error;
      }
    }),
    subscriptionChangeCommand: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const command = {
          ...data,
          completedAt: null,
          id: `command-${state.commands.length + 1}`,
          resourceId: null,
          resourceType: null,
          updatedAt: now
        };
        state.commands.push(command);
        return command;
      }),
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (typeof where.id === "string") {
          return state.commands.find((command) => command.id === where.id) ?? null;
        }
        const identity = where.actorId_operation_idempotencyKey as
          | { actorId: string; idempotencyKey: string; operation: string }
          | undefined;
        return identity
          ? (state.commands.find(
              (command) =>
                command.actorId === identity.actorId &&
                command.idempotencyKey === identity.idempotencyKey &&
                command.operation === identity.operation
            ) ?? null)
          : null;
      }),
      update: vi.fn(
        async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
          const command = state.commands.find((item) => item.id === where.id);
          if (!command) throw new Error("command missing");
          Object.assign(command, data, { updatedAt: now });
          return command;
        }
      )
    },
    subscriptionChangeOrder: {
      findFirst: vi.fn(async () => refreshRelations()),
      findUnique: vi.fn(async () => refreshRelations()),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => applyChangeData(data))
    },
    subscriptionChangeQuote: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const quote = {
          ...data,
          id: `quote-${state.quotes.length + 1}`
        } as unknown as QuoteState;
        state.quotes.push(quote);
        return quote;
      }),
      findFirst: vi.fn(async () => state.quotes.at(-1) ?? null),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          state.quotes.find((quote) => quote.id === where.id) ?? null
      ),
      update: vi.fn(
        async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
          const quote = state.quotes.find((item) => item.id === where.id);
          if (!quote) throw new Error("quote missing");
          Object.assign(quote, data);
          return quote;
        }
      )
    }
  };
  const assetOperations = {
    assertVehicleAvailable: vi.fn(async () => ({ available: true })),
    releaseVehicleReservationForSubscriptionChange: vi.fn(async () => {
      if (state.targetVehicle.status === VehicleStatus.REVIEW_RESERVED) {
        state.targetVehicle.status = VehicleStatus.AVAILABLE;
      }
    }),
    reserveVehicleForSubscriptionChange: vi.fn(async () => {
      if (options.reservationConflict || state.targetVehicle.status !== VehicleStatus.AVAILABLE) {
        throw Object.assign(new Error("reservation conflict"), {
          code: "TARGET_VEHICLE_RESERVATION_CONFLICT"
        });
      }
      state.targetVehicle.status = VehicleStatus.REVIEW_RESERVED;
    })
  };
  const pricing = {
    calculate: vi.fn(async () => ({
      classification: "PACKAGE_INCLUDED",
      commercialSnapshot: { classification: "PACKAGE_INCLUDED" },
      commercialSnapshotHash,
      depositAmount: 300_000n,
      depositDeltaAmount: 0n,
      energyLimitCount: 4,
      energyLimitCountDelta: 0,
      energyLimitKwh: null,
      energyLimitKwhDelta: null,
      mileageLimitDeltaKm: 0,
      mileageLimitKm: 1_500,
      monthlyFeeAmount: 88_000n,
      monthlyFeeDeltaAmount: 0n,
      overMileageFeeAmount: 100n,
      planSnapshot: { plan: "source" },
      priceRuleSnapshot: { basis: "SOURCE_SEGMENT_PACKAGE_INCLUDED" },
      pricingMode: "ORIGINAL_PRICE",
      productId: "product-source",
      productVersionId: "version-source",
      quoteSnapshot: { commercialSnapshotHash },
      targetSubscriptionPlanId: "plan-source",
      targetVehiclePackageId: "package-source"
    }))
  };
  const actor = {
    id: "operator-1",
    menus: [],
    name: "Operator",
    permissions: [
      PermissionCode.SUBSCRIPTION_CHANGE_QUOTE,
      PermissionCode.SUBSCRIPTION_CHANGE_SUBMIT,
      PermissionCode.SUBSCRIPTION_CHANGE_CANCEL
    ],
    roles: ["OP"],
    username: "operator"
  };
  const customer = { accountId: "account-1", customerId: "customer-1" };
  return {
    actor,
    assetOperations,
    commercialSnapshotHash,
    context: { ipAddress: "127.0.0.1", userAgent: "vitest" },
    customer,
    now,
    service: new SubscriptionVehicleSwapService(
      prisma as never,
      { write: vi.fn(async () => undefined) } as never,
      assetOperations as never,
      pricing as never,
      {
        enabled: options.extensionEnabled ?? true,
        now: () => now,
        quoteValidityHours: 72,
        vehicleSwapEnabled: options.vehicleSwapEnabled ?? true
      }
    ),
    state
  };
}
