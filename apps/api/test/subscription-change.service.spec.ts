import {
  AuditAction,
  BusinessType,
  OrderStatus,
  SubscriptionChangePricingMode,
  SubscriptionChangeQuoteStatus,
  SubscriptionChangeStatus,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { loadSubscriptionChangeConfig } from "../src/subscription-change/subscription-change.config";
import { SubscriptionExtensionService } from "../src/subscription-change/subscription-extension.service";

describe("SubscriptionExtensionService", () => {
  it.each([undefined, "1", "TRUE", "True", "false"])(
    "keeps the feature disabled for non-exact flag value %s",
    (value) => {
      expect(loadSubscriptionChangeConfig({ SUBSCRIPTION_EXTENSION_ENABLED: value }).enabled).toBe(false);
    }
  );

  it("enables the feature only for the exact lowercase string true", () => {
    expect(loadSubscriptionChangeConfig({ SUBSCRIPTION_EXTENSION_ENABLED: "true" }).enabled).toBe(true);
  });

  it("fails closed when the feature flag is not the exact string true", async () => {
    const harness = changeHarness({ enabled: false });

    await expect(
      harness.service.createExtension(createInput(), harness.submitter, harness.context)
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_EXTENSION_DISABLED" });
  });

  it("rejects creation when the order already has an active V2 change", async () => {
    const harness = changeHarness({ activeChange: true });

    await expect(
      harness.service.createExtension(createInput(), harness.submitter, harness.context)
    ).rejects.toMatchObject({ code: "ACTIVE_SUBSCRIPTION_CHANGE_EXISTS", status: 409 });
  });

  it.each([
    [{ businessType: BusinessType.RENT_TO_OWN }, "SUBSCRIPTION_ORDER_NOT_ACTIVE"],
    [{ orderStatus: OrderStatus.PENDING_RETURN }, "SUBSCRIPTION_ORDER_NOT_ACTIVE"],
    [{ vehicleStatus: VehicleStatus.AVAILABLE }, "LEASED_VEHICLE_REQUIRED"]
  ] as const)("rejects an ineligible extension source %#", async (overrides, code) => {
    const harness = changeHarness(overrides);

    await expect(
      harness.service.createExtension(createInput(), harness.submitter, harness.context)
    ).rejects.toMatchObject({ code, status: 409 });
  });

  it("uses clamped calendar months and the Shanghai start-of-day deadline", async () => {
    const harness = changeHarness({
      now: new Date("2025-12-01T00:00:00.000Z"),
      sourceEndDate: new Date("2026-01-30T00:00:00.000Z")
    });

    await harness.service.createExtension(
      { ...createInput(), extensionMonths: 1 },
      harness.submitter,
      harness.context
    );

    expect(harness.prisma.subscriptionChangeOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          completionDeadlineAt: new Date("2026-01-30T16:00:00.000Z"),
          targetEndDate: new Date("2026-02-27T00:00:00.000Z"),
          targetStartDate: new Date("2026-01-31T00:00:00.000Z")
        })
      })
    );
  });

  it("rejects creation after the source segment completion deadline", async () => {
    const harness = changeHarness({
      now: new Date("2026-09-02T16:00:00.000Z"),
      sourceEndDate: new Date("2026-09-02T00:00:00.000Z")
    });

    await expect(
      harness.service.createExtension(createInput(), harness.submitter, harness.context)
    ).rejects.toMatchObject({ code: "EXTENSION_DEADLINE_PASSED", status: 409 });
  });

  it("requires a different user to approve original-price and discount exceptions", async () => {
    const harness = changeHarness({
      existingQuote: true,
      pricingMode: SubscriptionChangePricingMode.ORIGINAL_PRICE
    });

    await expect(
      harness.service.approvePriceOverride(
        "change-1",
        { idempotencyKey: "approve-1", reason: "retain agreed price", version: 0 },
        harness.submitter,
        harness.context
      )
    ).rejects.toMatchObject({ code: "PRICE_OVERRIDE_SELF_APPROVAL_FORBIDDEN" });
  });

  it("creates append-only quote revisions and supersedes the prior formal quote", async () => {
    const harness = changeHarness({ existingQuote: true });

    const quote = await harness.service.createFormalQuote(
      "change-1",
      {
        idempotencyKey: "quote-2",
        subscriptionPlanId: "plan-current",
        version: 0
      },
      harness.submitter,
      harness.context
    );

    expect(quote).toMatchObject({ revision: 2, status: SubscriptionChangeQuoteStatus.FORMAL });
    expect(harness.state.quote.status).toBe(SubscriptionChangeQuoteStatus.SUPERSEDED);
    expect(harness.prisma.subscriptionChangeOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customerConfirmationPublishedAt: null,
          priceOverrideApprovedAt: null,
          priceOverrideApprovedBy: null
        })
      })
    );
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CREATE,
        after: expect.objectContaining({ revision: 2 }),
        entityType: "subscription_change_quote",
        operatorId: harness.submitter.id
      }),
      expect.anything()
    );
  });

  it("never replaces a confirmed quote", async () => {
    const harness = changeHarness({ confirmedQuoteId: "quote-confirmed" });

    await expect(
      harness.service.createFormalQuote(
        "change-1",
        { idempotencyKey: "quote-after-confirm", version: 0 },
        harness.submitter,
        harness.context
      )
    ).rejects.toMatchObject({ code: "CONFIRMED_QUOTE_IMMUTABLE", status: 409 });
  });

  it("requires an approved exception before publishing an ORIGINAL_PRICE quote", async () => {
    const harness = changeHarness({
      pricingMode: SubscriptionChangePricingMode.ORIGINAL_PRICE,
      status: SubscriptionChangeStatus.QUOTED
    });

    await expect(
      harness.service.submitCustomerConfirmation(
        "change-1",
        { idempotencyKey: "publish-1", version: 0 },
        harness.submitter,
        harness.context
      )
    ).rejects.toMatchObject({ code: "PRICE_OVERRIDE_APPROVAL_REQUIRED", status: 409 });
  });

  it("records when the current formal quote is published for customer confirmation", async () => {
    const harness = changeHarness({
      existingQuote: true,
      status: SubscriptionChangeStatus.QUOTED
    });

    await harness.service.submitCustomerConfirmation(
      "change-1",
      { idempotencyKey: "publish-current", version: 0 },
      harness.submitter,
      harness.context
    );

    expect(harness.state.change.customerConfirmationPublishedAt).toBeInstanceOf(Date);
    expect(harness.state.change.customerConfirmationPublishedBy).toBe(harness.submitter.id);
  });

  it("returns the same formal quote when the same idempotency key is retried", async () => {
    const harness = changeHarness({ existingQuote: true, replayCommand: true });

    const quote = await harness.service.createFormalQuote(
      "change-1",
      { idempotencyKey: "quote-replay", version: 0 },
      harness.submitter,
      harness.context
    );

    expect(quote).toMatchObject({ id: "quote-replayed", revision: 2 });
    expect(harness.prisma.subscriptionChangeQuote.create).not.toHaveBeenCalled();
  });
});

interface HarnessOptions {
  activeChange?: boolean;
  businessType?: BusinessType;
  confirmedQuoteId?: string | null;
  enabled?: boolean;
  existingQuote?: boolean;
  now?: Date;
  pricingMode?: SubscriptionChangePricingMode;
  replayCommand?: boolean;
  sourceEndDate?: Date;
  status?: SubscriptionChangeStatus;
  orderStatus?: OrderStatus;
  vehicleStatus?: VehicleStatus;
}

function changeHarness(options: HarnessOptions = {}) {
  const now = options.now ?? new Date("2026-08-05T04:00:00.000Z");
  const sourceEndDate = options.sourceEndDate ?? new Date("2026-09-02T00:00:00.000Z");
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  const submitter = {
    id: "op-1",
    menus: [],
    name: "Operator",
    permissions: [
      "subscription_change:create",
      "subscription_change:quote",
      "subscription_change:price_override_approve",
      "subscription_change:submit",
      "subscription_change:cancel",
      "subscription_change:manual_takeover",
      "subscription_change:view"
    ],
    roles: ["OP"],
    username: "op"
  };
  const state = {
    change: {
      completionDeadlineAt: new Date("2026-09-02T16:00:00.000Z"),
      confirmedQuoteId: options.confirmedQuoteId ?? null,
      createdBy: submitter.id,
      customerConfirmationPublishedAt: null as Date | null,
      customerConfirmationPublishedBy: null as string | null,
      currentQuoteId: options.existingQuote ? "quote-1" : null,
      extensionMonths: 6,
      id: "change-1",
      orderId: "order-1",
      priceOverrideApprovedAt: null as Date | null,
      priceOverrideApprovedBy: null as string | null,
      pricingMode: options.pricingMode ?? SubscriptionChangePricingMode.CURRENT_VERSION,
      renewalConsiderationId: null,
      sourceSegmentId: "segment-base",
      status: options.status ?? SubscriptionChangeStatus.DRAFT,
      targetEndDate: new Date("2027-03-02T00:00:00.000Z"),
      targetStartDate: new Date("2026-09-03T00:00:00.000Z"),
      version: 0
    },
    quote: {
      changeOrderId: "change-1",
      createdBy: submitter.id,
      id: "quote-1",
      revision: 1,
      status: SubscriptionChangeQuoteStatus.FORMAL,
      validUntil: new Date("2026-08-08T04:00:00.000Z")
    }
  };
  const sourceSegment = {
    endDate: sourceEndDate,
    energyLimitCount: 2,
    energyLimitKwh: null,
    id: "segment-base",
    mileageLimitKm: 1_500,
    monthlyFeeAmount: 88_000n,
    orderId: "order-1",
    overMileageFeeAmount: 100n,
    planSnapshot: { source: "archived-plan" },
    productId: "product-old",
    productVersionId: "version-old",
    quoteSnapshot: { quoteNo: "QUO-OLD" },
    subscriptionPlanId: "plan-old"
  };
  const order = {
    businessType: options.businessType ?? BusinessType.SUBSCRIPTION,
    deletedAt: null,
    endDate: sourceEndDate,
    id: "order-1",
    orderStatus: options.orderStatus ?? OrderStatus.ACTIVE,
    vehicle: {
      currentSalePriceAmount: 20_000_000n,
      id: "vehicle-1",
      modelDefinitionId: "model-et5",
      purchasePriceAmount: 18_000_000n,
      status: options.vehicleStatus ?? VehicleStatus.LEASED
    }
  };
  const commands = {
    replay: options.replayCommand
      ? {
          actorId: submitter.id,
          idempotencyKey: "quote-replay",
          operation: "CREATE_FORMAL_QUOTE",
          requestHash: expect.any(String),
          resourceId: "quote-replayed",
          resourceType: "QUOTE"
        }
      : null
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => operation(prisma)),
    auditLog: { create: vi.fn(async () => ({})) },
    subscriptionChangeCommand: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "command-1", ...data })),
      findUnique: vi.fn(async () => commands.replay),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "command-1", ...data }))
    },
    subscriptionChangeOrder: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...state.change, ...data })),
      findFirst: vi.fn(async () => (options.activeChange ? state.change : null)),
      findUnique: vi.fn(async () => ({
        ...state.change,
        currentQuote: options.existingQuote ? state.quote : null,
        order,
        quotes: options.existingQuote ? [state.quote] : [],
        sourceSegment
      })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state.change, data);
        return {
          ...state.change,
          currentQuote: options.existingQuote ? state.quote : null,
          order,
          quotes: options.existingQuote ? [state.quote] : [],
          sourceSegment
        };
      })
    },
    subscriptionChangeQuote: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "quote-2",
        ...data
      })),
      findFirst: vi.fn(async () => (options.existingQuote ? state.quote : null)),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "quote-replayed"
          ? { ...state.quote, id: "quote-replayed", revision: 2 }
          : state.quote
      ),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state.quote, data);
        return state.quote;
      })
    },
    subscriptionContractSegment: {
      findFirst: vi.fn(async () => sourceSegment)
    },
    subscriptionOrder: {
      findUnique: vi.fn(async () => order)
    }
  };
  const auditService = { write: vi.fn(async () => undefined) };
  const segmentService = {
    assertAppendableExtension: vi.fn(async () => undefined),
    ensureBaseSegment: vi.fn(async () => sourceSegment)
  };
  const pricingService = {
    calculate: vi.fn(async () => ({
      baselineMonthlyFeeAmount: 97_000n,
      energyLimitCount: 2,
      energyLimitKwh: null,
      mileageLimitKm: 1_800,
      monthlyFeeAmount: 97_000n,
      overMileageFeeAmount: 125n,
      planSnapshot: { planNo: "PLAN-CURRENT" },
      priceRuleSnapshot: { basis: "CURRENT_VERSION" },
      productId: "product-current",
      productVersionId: "version-current",
      quoteSnapshot: { monthlyFeeAmount: "97000" },
      subscriptionPlanId: "plan-current"
    }))
  };
  const service = new SubscriptionExtensionService(
    prisma as never,
    auditService as never,
    segmentService as never,
    pricingService as never,
    { enabled: options.enabled ?? true, now: () => now, quoteValidityHours: 72 }
  );

  return { auditService, context, prisma, service, state, submitter };
}

function createInput() {
  return {
    extensionMonths: 6,
    idempotencyKey: "create-1",
    orderId: "order-1",
    pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION,
    subscriptionPlanId: "plan-current"
  };
}
