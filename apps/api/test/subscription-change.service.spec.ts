import {
  AuditAction,
  BusinessType,
  ContractSegmentStatus,
  OrderStatus,
  SubscriptionChangePricingMode,
  SubscriptionChangeQuoteStatus,
  SubscriptionChangeStatus,
  SubscriptionChangeType,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { loadSubscriptionChangeConfig } from "../src/subscription-change/subscription-change.config";
import { SubscriptionChangeRepository } from "../src/subscription-change/subscription-change.repository";
import { SubscriptionExtensionService } from "../src/subscription-change/subscription-extension.service";

describe("SubscriptionExtensionService", () => {
  it.each([undefined, "1", "TRUE", "True", "false"])(
    "keeps the feature disabled for non-exact flag value %s",
    (value) => {
      expect(loadSubscriptionChangeConfig({ SUBSCRIPTION_EXTENSION_ENABLED: value }).enabled).toBe(
        false
      );
    }
  );

  it("enables the feature only for the exact lowercase string true", () => {
    expect(loadSubscriptionChangeConfig({ SUBSCRIPTION_EXTENSION_ENABLED: "true" }).enabled).toBe(
      true
    );
  });

  it("fails closed when the feature flag is not the exact string true", async () => {
    const harness = changeHarness({ enabled: false });

    await expect(
      harness.service.createExtension(createInput(), harness.submitter, harness.context)
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_EXTENSION_DISABLED" });
  });

  it("allows manual takeover while new extension writes are disabled", async () => {
    const harness = changeHarness({
      enabled: false,
      status: SubscriptionChangeStatus.EXECUTING
    });

    await expect(
      harness.service.manualTakeover(
        "change-1",
        { idempotencyKey: "takeover-disabled-1", reason: "rollback operations", version: 0 },
        harness.submitter,
        harness.context
      )
    ).resolves.toMatchObject({ status: SubscriptionChangeStatus.MANUAL_TAKEOVER });
  });

  it("does not cancel a change while its reserved contract is rendering", async () => {
    const harness = changeHarness({
      contractRendering: true,
      status: SubscriptionChangeStatus.CUSTOMER_CONFIRMED
    });

    await expect(
      harness.service.cancel(
        "change-1",
        { idempotencyKey: "cancel-rendering-1", reason: "customer request", version: 0 },
        harness.submitter,
        harness.context
      )
    ).rejects.toMatchObject({ code: "CONTRACT_GENERATION_IN_PROGRESS", status: 409 });
  });

  it("does not enter manual takeover while its reserved contract is rendering", async () => {
    const harness = changeHarness({
      contractRendering: true,
      status: SubscriptionChangeStatus.CUSTOMER_CONFIRMED
    });

    await expect(
      harness.service.manualTakeover(
        "change-1",
        { idempotencyKey: "takeover-rendering-1", reason: "operator request", version: 0 },
        harness.submitter,
        harness.context
      )
    ).rejects.toMatchObject({ code: "CONTRACT_GENERATION_IN_PROGRESS", status: 409 });
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

    const createData = harness.prisma.subscriptionChangeOrder.create.mock.calls[0]![0].data;
    expect(createData).toEqual(
      expect.objectContaining({
        completionDeadlineAt: new Date("2026-01-30T16:00:00.000Z"),
        extensionDetail: {
          create: expect.objectContaining({
            extensionMonths: 1,
            pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION,
            sourceSegmentId: "segment-base",
            targetEndDate: new Date("2026-02-27T00:00:00.000Z"),
            targetStartDate: new Date("2026-01-31T00:00:00.000Z")
          })
        }
      })
    );
    for (const legacyField of [
      "extensionMonths",
      "priceOverrideReason",
      "pricingMode",
      "sourceSegmentId",
      "targetEndDate",
      "targetStartDate"
    ]) {
      expect(createData).not.toHaveProperty(legacyField);
    }
    expect(harness.lockedTables().slice(0, 3)).toEqual([
      "subscription_order",
      "subscription_contract_segment",
      "subscription_change_order"
    ]);
  });

  it("replays the exact extension create command and rejects a changed payload", async () => {
    const harness = changeHarness({ persistCommands: true });

    const first = await harness.service.createExtension(
      createInput(),
      harness.submitter,
      harness.context
    );
    const replay = await harness.service.createExtension(
      createInput(),
      harness.submitter,
      harness.context
    );

    expect(replay.id).toBe(first.id);
    expect(harness.prisma.subscriptionChangeOrder.create).toHaveBeenCalledOnce();
    await expect(
      harness.service.createExtension(
        { ...createInput(), extensionMonths: 12 },
        harness.submitter,
        harness.context
      )
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" });
  });

  it("prices an extension from its typed detail after legacy root fields become nullable", async () => {
    const harness = changeHarness({ typedDetailOnly: true });

    await harness.service.previewQuote("change-1", {}, harness.submitter);

    expect(harness.pricingService.calculate).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionMonths: 6,
        pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION,
        sourceSegment: expect.objectContaining({ id: "segment-base" })
      })
    );
  });

  it("temporarily falls back to legacy root facts when no typed detail is present", async () => {
    const harness = changeHarness({ legacyRootOnly: true });

    await harness.service.previewQuote("change-1", {}, harness.submitter);

    expect(harness.pricingService.calculate).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionMonths: 6,
        pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION,
        sourceSegment: expect.objectContaining({ id: "segment-base" })
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

  it("stores price-exception approval on the typed extension detail", async () => {
    const harness = changeHarness({
      existingQuote: true,
      pricingMode: SubscriptionChangePricingMode.ORIGINAL_PRICE,
      typedDetailOnly: true
    });
    const approver = { ...harness.submitter, id: "approver-1", username: "approver" };

    await harness.service.approvePriceOverride(
      "change-1",
      { idempotencyKey: "approve-typed-detail", reason: "retain agreed price", version: 0 },
      approver,
      harness.context
    );

    expect(harness.prisma.subscriptionChangeOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          extensionDetail: {
            update: {
              priceOverrideApprovedAt: expect.any(Date),
              priceOverrideApprovedBy: approver.id,
              priceOverrideReason: "retain agreed price"
            }
          }
        })
      })
    );
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
          extensionDetail: {
            update: {
              priceOverrideApprovedAt: null,
              priceOverrideApprovedBy: null
            }
          }
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

  it("requeues only a dead-lettered extension execution job and returns the change to EXECUTING", async () => {
    const harness = changeHarness({ status: SubscriptionChangeStatus.MANUAL_TAKEOVER });

    await harness.service.retryAutomationJob(
      "change-1",
      "job-1",
      { idempotencyKey: "retry-job-1", version: 0 },
      harness.submitter,
      harness.context
    );

    expect(harness.prisma.subscriptionAutomationJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attemptCount: 0,
          jobStatus: SubscriptionAutomationJobStatus.PENDING,
          leaseToken: null
        }),
        where: expect.objectContaining({
          changeOrderId: "change-1",
          id: "job-1",
          jobStatus: SubscriptionAutomationJobStatus.DEAD_LETTER
        })
      })
    );
    expect(harness.prisma.subscriptionChangeOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failureCode: null,
          failureMessage: null,
          status: SubscriptionChangeStatus.EXECUTING
        })
      })
    );
  });

  it("rejects retry for a non-extension or non-dead-letter job", async () => {
    const harness = changeHarness({
      jobStatus: SubscriptionAutomationJobStatus.COMPLETED,
      status: SubscriptionChangeStatus.MANUAL_TAKEOVER
    });

    await expect(
      harness.service.retryAutomationJob(
        "change-1",
        "job-1",
        { idempotencyKey: "retry-job-2", version: 0 },
        harness.submitter,
        harness.context
      )
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_CHANGE_JOB_NOT_RETRYABLE", status: 409 });
  });

  it("restores a failed segment activation to SCHEDULED so the activation transition remains valid", async () => {
    const harness = changeHarness({
      jobType: SubscriptionAutomationJobType.EXTENSION_SEGMENT_ACTIVATE,
      status: SubscriptionChangeStatus.MANUAL_TAKEOVER
    });

    await harness.service.retryAutomationJob(
      "change-1",
      "job-1",
      { idempotencyKey: "retry-activation", version: 0 },
      harness.submitter,
      harness.context
    );

    expect(harness.prisma.subscriptionChangeOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: SubscriptionChangeStatus.SCHEDULED })
      })
    );
  });

  it("rejects retry unless the current manual takeover was caused by the same target-segment job", async () => {
    const harness = changeHarness({
      changeFailureCode: "DIFFERENT_FAILURE",
      status: SubscriptionChangeStatus.MANUAL_TAKEOVER
    });

    await expect(
      harness.service.retryAutomationJob(
        "change-1",
        "job-1",
        { idempotencyKey: "retry-unrelated", version: 0 },
        harness.submitter,
        harness.context
      )
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_CHANGE_JOB_RETRY_NOT_ALLOWED", status: 409 });
  });

  it("rejects a dead-letter retry from FAILED instead of the worker-owned manual takeover state", async () => {
    const harness = changeHarness({ status: SubscriptionChangeStatus.FAILED });

    await expect(
      harness.service.retryAutomationJob(
        "change-1",
        "job-1",
        { idempotencyKey: "retry-failed-change", version: 0 },
        harness.submitter,
        harness.context
      )
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_CHANGE_JOB_RETRY_NOT_ALLOWED", status: 409 });
  });

  it("validates feature flag and deadline under the change-scoped e-sign command", async () => {
    const disabled = changeHarness({
      enabled: false,
      status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT
    });
    const expired = changeHarness({
      now: new Date("2026-09-02T16:00:00.000Z"),
      status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT
    });
    const start = vi.fn(async () => ({ id: "task-1" }));

    await expect(
      disabled.service.startOrRetryESign(
        "change-1",
        { idempotencyKey: "esign-disabled", version: 0 },
        disabled.submitter,
        start
      )
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_EXTENSION_DISABLED" });
    await expect(
      expired.service.startOrRetryESign(
        "change-1",
        { idempotencyKey: "esign-expired", version: 0 },
        expired.submitter,
        start
      )
    ).rejects.toMatchObject({ code: "EXTENSION_DEADLINE_PASSED", status: 409 });
    expect(start).not.toHaveBeenCalled();
  });

  it("does not start e-sign after the change leaves its signing state", async () => {
    const harness = changeHarness({ status: SubscriptionChangeStatus.CANCELLED });
    const start = vi.fn(async () => ({ id: "task-1" }));

    await expect(
      harness.service.startOrRetryESign(
        "change-1",
        { idempotencyKey: "esign-cancelled", version: 0 },
        harness.submitter,
        start
      )
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_CHANGE_ESIGN_NOT_ALLOWED", status: 409 });
    expect(start).not.toHaveBeenCalled();
  });

  it("reserves and replays an e-sign command without starting a second provider task", async () => {
    const harness = changeHarness({
      persistCommands: true,
      status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT
    });
    const start = vi.fn(async () => ({ id: "task-1" }));
    const replay = vi.fn(async (taskId: string) => ({ id: taskId }));
    const input = { idempotencyKey: "esign-once", version: 0 };

    await expect(
      harness.service.startOrRetryESign("change-1", input, harness.submitter, start, replay)
    ).resolves.toEqual({ id: "task-1" });
    await expect(
      harness.service.startOrRetryESign("change-1", input, harness.submitter, start, replay)
    ).resolves.toEqual({ id: "task-1" });

    expect(start).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledWith("task-1");
  });

  it("recovers a stale e-sign command after a crash between provider start and completion", async () => {
    const harness = changeHarness({
      esignRecoveryCommand: true,
      status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT
    });
    const recover = vi.fn(async () => ({ id: "task-recovered" }));

    await expect(
      harness.service.startOrRetryESign(
        "change-1",
        { idempotencyKey: "esign-recover", version: 0 },
        harness.submitter,
        recover,
        vi.fn()
      )
    ).resolves.toEqual({ id: "task-recovered" });

    expect(recover).toHaveBeenCalledWith("contract-1");
    expect(harness.prisma.subscriptionChangeCommand.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          resourceId: "task-recovered",
          resourceType: "ESIGN_TASK"
        })
      })
    );
  });

  it("serializes concurrent stale e-sign recovery under the command row lock", async () => {
    const harness = changeHarness({
      esignRecoveryCommand: true,
      serializeTransactions: true,
      status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT
    });
    const start = vi.fn(async () => ({ id: "task-recovered" }));
    const replay = vi.fn(async (taskId: string) => ({ id: taskId }));
    const recoverExisting = vi.fn(async () => null);
    const run = () =>
      harness.service.startOrRetryESign(
        "change-1",
        { idempotencyKey: "esign-recover", version: 0 },
        harness.submitter,
        start,
        replay,
        recoverExisting
      );

    await expect(Promise.all([run(), run()])).resolves.toEqual([
      { id: "task-recovered" },
      { id: "task-recovered" }
    ]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledWith("task-recovered");
  });

  it("does not start a missing provider task when stale recovery occurs after the deadline", async () => {
    const harness = changeHarness({
      esignRecoveryCommand: true,
      now: new Date("2026-09-02T16:00:00.000Z"),
      status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT
    });
    const start = vi.fn(async () => ({ id: "task-too-late" }));

    await expect(
      harness.service.startOrRetryESign(
        "change-1",
        { idempotencyKey: "esign-recover", version: 0 },
        harness.submitter,
        start,
        vi.fn(),
        vi.fn(async () => null)
      )
    ).rejects.toMatchObject({ code: "EXTENSION_DEADLINE_PASSED", status: 409 });
    expect(start).not.toHaveBeenCalled();
  });

  it("returns job retry audit events in the subscription change timeline", async () => {
    const harness = changeHarness();

    await harness.service.timeline("change-1", harness.submitter);

    expect(harness.prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          entityId: { in: expect.arrayContaining(["change-1", "job-1"]) },
          entityType: {
            in: expect.arrayContaining(["subscription_change_job_retry"])
          }
        }
      })
    );
  });
});

interface HarnessOptions {
  activeChange?: boolean;
  businessType?: BusinessType;
  confirmedQuoteId?: string | null;
  contractRendering?: boolean;
  enabled?: boolean;
  esignRecoveryCommand?: boolean;
  existingQuote?: boolean;
  now?: Date;
  pricingMode?: SubscriptionChangePricingMode;
  replayCommand?: boolean;
  serializeTransactions?: boolean;
  sourceEndDate?: Date;
  status?: SubscriptionChangeStatus;
  orderStatus?: OrderStatus;
  persistCommands?: boolean;
  jobStatus?: SubscriptionAutomationJobStatus;
  jobType?: SubscriptionAutomationJobType;
  changeFailureCode?: string | null;
  jobContractSegmentId?: string | null;
  jobErrorCode?: string | null;
  legacyRootOnly?: boolean;
  targetSegmentStatus?: ContractSegmentStatus;
  typedDetailOnly?: boolean;
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
      "subscription_change:esign_retry",
      "subscription_change:execute",
      "subscription_change:cancel",
      "subscription_change:manual_takeover",
      "subscription_change:view"
    ],
    roles: ["OP"],
    username: "op"
  };
  const state = {
    change: {
      changeType: SubscriptionChangeType.EXTENSION,
      completionDeadlineAt: new Date("2026-09-02T16:00:00.000Z"),
      confirmedQuoteId: options.confirmedQuoteId ?? null,
      createdBy: submitter.id,
      customerConfirmationPublishedAt: null as Date | null,
      customerConfirmationPublishedBy: null as string | null,
      failureCode:
        options.changeFailureCode === undefined
          ? "SUBSCRIPTION_CHANGE_JOB_FAILED"
          : options.changeFailureCode,
      failureMessage: "provider timeout",
      currentQuoteId: options.existingQuote ? "quote-1" : null,
      extensionMonths: options.typedDetailOnly ? null : 6,
      id: "change-1",
      orderId: "order-1",
      priceOverrideApprovedAt: null as Date | null,
      priceOverrideApprovedBy: null as string | null,
      pricingMode: options.typedDetailOnly
        ? null
        : (options.pricingMode ?? SubscriptionChangePricingMode.CURRENT_VERSION),
      renewalConsiderationId: null,
      sourceSegmentId: options.typedDetailOnly ? null : "segment-base",
      status: options.status ?? SubscriptionChangeStatus.DRAFT,
      targetEndDate: options.typedDetailOnly ? null : new Date("2027-03-02T00:00:00.000Z"),
      targetStartDate: options.typedDetailOnly ? null : new Date("2026-09-03T00:00:00.000Z"),
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
  const extensionDetailState = {
    extensionMonths: 6,
    priceOverrideApprovedAt: null as Date | null,
    priceOverrideApprovedBy: null as string | null,
    priceOverrideReason: null as string | null,
    pricingMode: options.pricingMode ?? SubscriptionChangePricingMode.CURRENT_VERSION,
    sourceSegment,
    sourceSegmentId: sourceSegment.id,
    targetEndDate: new Date("2027-03-02T00:00:00.000Z"),
    targetStartDate: new Date("2026-09-03T00:00:00.000Z")
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
    replay: options.esignRecoveryCommand
      ? {
          actorId: submitter.id,
          createdAt: new Date(now.getTime() - 10 * 60_000),
          id: "command-esign-recover",
          idempotencyKey: "esign-recover",
          operation: "START_OR_RETRY_ESIGN",
          resourceId: "contract-1",
          resourceType: "ESIGN_CONTRACT"
        }
      : options.replayCommand
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
  const persistedCommands = new Map<string, Record<string, unknown>>();
  const commandKey = (data: Record<string, unknown>) =>
    `${String(data.actorId)}:${String(data.operation)}:${String(data.idempotencyKey)}`;
  let transactionTail = Promise.resolve();
  const querySql: string[] = [];
  const prisma = {
    $queryRaw: vi.fn(async (sql: { strings?: readonly string[] }) => {
      querySql.push(sql.strings?.join(" ") ?? String(sql));
      return [];
    }),
    $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => {
      if (!options.serializeTransactions) return operation(prisma);
      let release: () => void = () => {};
      const previous = transactionTail;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation(prisma);
      } finally {
        release();
      }
    }),
    auditLog: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => [])
    },
    subscriptionChangeCommand: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (!options.persistCommands) return { id: "command-1", ...data };
        const key = commandKey(data);
        if (persistedCommands.has(key)) {
          throw Object.assign(new Error("duplicate command"), { code: "P2002" });
        }
        const row = {
          createdAt: now,
          id: `command-${persistedCommands.size + 1}`,
          ...data
        };
        persistedCommands.set(key, row);
        return row;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        for (const [key, row] of persistedCommands) {
          if (row.id === where.id) persistedCommands.delete(key);
        }
        return {};
      }),
      findUnique: vi.fn(
        async ({ where }: { where?: Record<string, Record<string, unknown>> } = {}) => {
          if (!options.persistCommands) return commands.replay;
          const identity = where?.actorId_operation_idempotencyKey;
          return identity ? (persistedCommands.get(commandKey(identity)) ?? null) : null;
        }
      ),
      update: vi.fn(
        async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
          if (!options.persistCommands) {
            const replayCommand = commands.replay as Record<string, unknown> | null;
            if (options.esignRecoveryCommand && replayCommand?.id === where.id) {
              Object.assign(replayCommand, data);
            }
            return { id: "command-1", ...data };
          }
          for (const row of persistedCommands.values()) {
            if (row.id === where.id) Object.assign(row, data);
          }
          return { id: where.id, ...data };
        }
      )
    },
    subscriptionChangeOrder: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const nested = data.extensionDetail as { create?: Record<string, unknown> } | undefined;
        if (nested?.create) Object.assign(extensionDetailState, nested.create);
        return {
          ...state.change,
          ...data,
          extensionDetail: extensionDetailState,
          sourceSegment: options.typedDetailOnly ? null : sourceSegment
        };
      }),
      findFirst: vi.fn(async () => (options.activeChange ? state.change : null)),
      findUnique: vi.fn(async () => ({
        ...state.change,
        automationJobs: [{ id: "job-1" }],
        contract: options.contractRendering
          ? { fileId: null, id: "contract-rendering", status: "GENERATED" }
          : { fileId: "file-1", id: "contract-1", status: "ARCHIVED" },
        currentQuote: options.existingQuote ? state.quote : null,
        extensionDetail: options.legacyRootOnly ? null : extensionDetailState,
        order,
        quotes: options.existingQuote ? [state.quote] : [],
        sourceSegment: options.typedDetailOnly ? null : sourceSegment,
        targetSegment: {
          id: "segment-extension",
          status: options.targetSegmentStatus ?? ContractSegmentStatus.ACTIVE
        }
      })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const nested = data.extensionDetail as { update?: Record<string, unknown> } | undefined;
        if (nested?.update) Object.assign(extensionDetailState, nested.update);
        const rootData = { ...data };
        delete rootData.extensionDetail;
        Object.assign(state.change, rootData);
        return {
          ...state.change,
          currentQuote: options.existingQuote ? state.quote : null,
          extensionDetail: options.legacyRootOnly ? null : extensionDetailState,
          order,
          quotes: options.existingQuote ? [state.quote] : [],
          sourceSegment: options.typedDetailOnly ? null : sourceSegment
        };
      })
    },
    subscriptionAutomationJob: {
      findUnique: vi.fn(async () => ({
        changeOrderId: "change-1",
        contractSegmentId:
          options.jobContractSegmentId === undefined
            ? "segment-extension"
            : options.jobContractSegmentId,
        id: "job-1",
        lastErrorCode:
          options.jobErrorCode === undefined
            ? "SUBSCRIPTION_CHANGE_JOB_FAILED"
            : options.jobErrorCode,
        lastErrorMessage: "provider timeout",
        jobStatus: options.jobStatus ?? SubscriptionAutomationJobStatus.DEAD_LETTER,
        jobType: options.jobType ?? SubscriptionAutomationJobType.EXTENSION_BILLING_RESUME
      })),
      updateMany: vi.fn(async () => ({ count: 1 }))
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
    { enabled: options.enabled ?? true, now: () => now, quoteValidityHours: 72 },
    new SubscriptionChangeRepository(prisma as never)
  );

  return {
    auditService,
    context,
    lockedTables: () =>
      querySql.flatMap((sql) =>
        ["subscription_order", "subscription_contract_segment", "subscription_change_order"].filter(
          (table) => sql.includes(`"${table}"`)
        )
      ),
    pricingService,
    prisma,
    service,
    state,
    submitter
  };
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
