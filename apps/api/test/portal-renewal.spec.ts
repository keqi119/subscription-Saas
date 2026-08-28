import {
  RenewalConsiderationStatus,
  RenewalDecision,
  SubscriptionChangeQuoteStatus,
  SubscriptionChangeStatus,
  SubscriptionChangeType
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { PortalRenewalService } from "../src/portal/portal-renewal.service";
import { SubscriptionChangeRepository } from "../src/subscription-change/subscription-change.repository";

describe("PortalRenewalService", () => {
  it("keeps expiry available while hiding renewal when the extension capability is off", async () => {
    const disabled = portalRenewalHarness({ enabled: false });

    await expect(disabled.service.get("consideration-1", disabled.customer)).resolves.toMatchObject(
      {
        allowedActions: ["EXPIRE"],
        featureAvailability: {
          enabled: false,
          flagName: "SUBSCRIPTION_EXTENSION_ENABLED"
        }
      }
    );
    await expect(
      disabled.service.decide(
        "consideration-1",
        { decision: RenewalDecision.EXPIRE, idempotencyKey: "expire-while-disabled", version: 0 },
        disabled.customer,
        disabled.context
      )
    ).resolves.toMatchObject({ decision: RenewalDecision.EXPIRE });

    const renewDisabled = portalRenewalHarness({ enabled: false });
    await expect(
      renewDisabled.service.decide(
        "consideration-1",
        { decision: RenewalDecision.RENEW, idempotencyKey: "renew-while-disabled", version: 0 },
        renewDisabled.customer,
        renewDisabled.context
      )
    ).rejects.toMatchObject({ status: 503 });
  });

  it("projects whether the current quote has been published to the customer", async () => {
    const harness = portalRenewalHarness({ publishedQuote: true });

    const result = await harness.service.getChange("change-1", harness.customer);

    expect(result.customerConfirmationPublishedAt).toBe("2026-08-05T04:00:00.000Z");
  });

  it("sorts renewal customer actions before processing and terminal records", async () => {
    const harness = portalRenewalHarness();
    const action = {
      ...harness.state.consideration,
      changeOrder: null,
      completionDeadlineAt: new Date("2026-08-11T00:00:00Z"),
      id: "renewal-action"
    };
    const processing = {
      ...harness.state.consideration,
      changeOrder: {
        ...harness.state.change,
        status: SubscriptionChangeStatus.DRAFT
      },
      completionDeadlineAt: new Date("2026-08-10T00:00:00Z"),
      decision: RenewalDecision.RENEW,
      id: "renewal-processing",
      status: RenewalConsiderationStatus.RENEWAL_REQUESTED
    };
    const completed = {
      ...harness.state.consideration,
      changeOrder: {
        ...harness.state.change,
        status: SubscriptionChangeStatus.COMPLETED
      },
      completionDeadlineAt: new Date("2026-08-09T00:00:00Z"),
      decision: RenewalDecision.RENEW,
      id: "renewal-completed",
      status: RenewalConsiderationStatus.EXTENDED
    };
    vi.mocked(harness.prisma.renewalConsideration.findMany).mockResolvedValue([
      completed,
      processing,
      action
    ] as never);

    const result = await harness.service.list(harness.customer);
    expect(result.map((item) => item.id)).toEqual([
      "renewal-action",
      "renewal-processing",
      "renewal-completed"
    ]);
  });

  it("orders renewal actions by completion deadline", async () => {
    const harness = portalRenewalHarness();
    const late = {
      ...harness.state.consideration,
      changeOrder: null,
      completionDeadlineAt: new Date("2026-08-12T00:00:00Z"),
      id: "renewal-late"
    };
    const soon = {
      ...harness.state.consideration,
      changeOrder: null,
      completionDeadlineAt: new Date("2026-08-11T00:00:00Z"),
      id: "renewal-soon"
    };
    vi.mocked(harness.prisma.renewalConsideration.findMany).mockResolvedValue([
      late,
      soon
    ] as never);

    const result = await harness.service.list(harness.customer);
    expect(result.map((item) => item.id)).toEqual(["renewal-soon", "renewal-late"]);
  });

  it("idempotently records RENEW and links exactly one extension change", async () => {
    const harness = portalRenewalHarness();

    const first = await harness.service.decide(
      "consideration-1",
      { decision: RenewalDecision.RENEW, idempotencyKey: "renewal-decision-1", version: 0 },
      harness.customer,
      harness.context
    );
    const retry = await harness.service.decide(
      "consideration-1",
      { decision: RenewalDecision.RENEW, idempotencyKey: "renewal-decision-1", version: 0 },
      harness.customer,
      harness.context
    );

    expect(retry.changeOrderId).toBe(first.changeOrderId);
    expect(harness.prisma.subscriptionChangeOrder.create).toHaveBeenCalledTimes(1);
    expect(harness.state.consideration.status).toBe(RenewalConsiderationStatus.RENEWAL_REQUESTED);
  });

  it("creates the renewal extension through typed detail facts behind the shared creation lock", async () => {
    const harness = portalRenewalHarness();

    await harness.service.decide(
      "consideration-1",
      { decision: RenewalDecision.RENEW, idempotencyKey: "renewal-typed-create", version: 0 },
      harness.customer,
      harness.context
    );

    const createData = harness.prisma.subscriptionChangeOrder.create.mock.calls[0]![0].data;
    expect(createData).toEqual(
      expect.objectContaining({
        changeType: SubscriptionChangeType.EXTENSION,
        extensionDetail: {
          create: expect.objectContaining({
            extensionMonths: 6,
            pricingMode: "CURRENT_VERSION",
            sourceSegmentId: "segment-1"
          })
        }
      })
    );
    expect(harness.lockedTables()).toEqual(
      expect.arrayContaining([
        "subscription_order",
        "subscription_contract_segment",
        "subscription_change_order"
      ])
    );
    for (const legacyField of [
      "extensionMonths",
      "pricingMode",
      "sourceSegmentId",
      "targetEndDate",
      "targetStartDate"
    ]) {
      expect(createData).not.toHaveProperty(legacyField);
    }
  });

  it("rejects renewal creation when the shared active-change slot is already occupied", async () => {
    const harness = portalRenewalHarness({ activeChange: true });

    await expect(
      harness.service.decide(
        "consideration-1",
        { decision: RenewalDecision.RENEW, idempotencyKey: "renewal-active-conflict", version: 0 },
        harness.customer,
        harness.context
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(harness.prisma.subscriptionChangeOrder.create).not.toHaveBeenCalled();
  });

  it("stops future renewal reminders after the customer chooses RENEW", async () => {
    const harness = portalRenewalHarness();

    await harness.service.decide(
      "consideration-1",
      { decision: RenewalDecision.RENEW, idempotencyKey: "renewal-reminders", version: 0 },
      harness.customer,
      harness.context
    );

    expect(harness.prisma.subscriptionAutomationJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ renewalConsiderationId: "consideration-1" })
      })
    );
    expect(harness.prisma.renewalReminder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ renewalConsiderationId: "consideration-1" })
      })
    );
  });

  it("rejects a conflicting second customer decision", async () => {
    const harness = portalRenewalHarness();
    await harness.service.decide(
      "consideration-1",
      { decision: RenewalDecision.RENEW, idempotencyKey: "renewal-drift", version: 0 },
      harness.customer,
      harness.context
    );

    await expect(
      harness.service.decide(
        "consideration-1",
        { decision: RenewalDecision.EXPIRE, idempotencyKey: "renewal-drift", version: 0 },
        harness.customer,
        harness.context
      )
    ).rejects.toMatchObject({ status: 409 });
  });

  it("records EXPIRE and cancels future renewal reminders", async () => {
    const harness = portalRenewalHarness();

    await harness.service.decide(
      "consideration-1",
      { decision: RenewalDecision.EXPIRE, idempotencyKey: "renewal-expire", version: 0 },
      harness.customer,
      harness.context
    );

    expect(harness.state.consideration.status).toBe(RenewalConsiderationStatus.EXPIRY_CONFIRMED);
    expect(harness.prisma.subscriptionAutomationJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ renewalConsiderationId: "consideration-1" })
      })
    );
    expect(harness.prisma.renewalReminder.updateMany).toHaveBeenCalled();
  });

  it("confirms only the exact published formal quote revision", async () => {
    const harness = portalRenewalHarness({ publishedQuote: true });

    const result = await harness.service.confirmQuote(
      "change-1",
      {
        idempotencyKey: "portal-extension-confirm-1",
        quoteId: "quote-1",
        revision: 2,
        version: 0
      },
      harness.customer,
      harness.context
    );

    expect(result.confirmedQuoteId).toBe("quote-1");
    expect(harness.state.change.status).toBe(SubscriptionChangeStatus.CUSTOMER_CONFIRMED);
    expect(harness.state.quote.status).toBe(SubscriptionChangeQuoteStatus.CUSTOMER_CONFIRMED);
  });

  it("rejects stale and superseded quote identities", async () => {
    const harness = portalRenewalHarness({ publishedQuote: true });

    await expect(
      harness.service.confirmQuote(
        "change-1",
        {
          idempotencyKey: "portal-extension-stale-1",
          quoteId: "quote-old",
          revision: 1,
          version: 0
        },
        harness.customer,
        harness.context
      )
    ).rejects.toMatchObject({ status: 409 });
  });

  it("returns the original confirmation for an idempotent exact-quote retry", async () => {
    const harness = portalRenewalHarness({ publishedQuote: true });
    await harness.service.confirmQuote(
      "change-1",
      {
        idempotencyKey: "portal-extension-replay-1",
        quoteId: "quote-1",
        revision: 2,
        version: 0
      },
      harness.customer,
      harness.context
    );

    await expect(
      harness.service.confirmQuote(
        "change-1",
        {
          idempotencyKey: "portal-extension-replay-1",
          quoteId: "quote-1",
          revision: 2,
          version: 0
        },
        harness.customer,
        harness.context
      )
    ).resolves.toMatchObject({ confirmedQuoteId: "quote-1" });
    expect(harness.prisma.subscriptionChangeQuote.update).toHaveBeenCalledTimes(1);
    await expect(
      harness.service.confirmQuote(
        "change-1",
        {
          idempotencyKey: "portal-extension-replay-1",
          quoteId: "quote-1",
          revision: 2,
          version: 1
        },
        harness.customer,
        harness.context
      )
    ).rejects.toMatchObject({
      response: { code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" }
    });
  });

  it("cancels a customer-rejected quote with the supplied reason", async () => {
    const harness = portalRenewalHarness({ publishedQuote: true });

    const result = await harness.service.rejectQuote(
      "change-1",
      {
        idempotencyKey: "portal-extension-reject-1",
        quoteId: "quote-1",
        reason: "价格方案暂不接受",
        revision: 2,
        version: 0
      },
      harness.customer,
      harness.context
    );

    expect(result).toMatchObject({
      cancelReason: "CUSTOMER_QUOTE_REJECTED: 价格方案暂不接受",
      status: SubscriptionChangeStatus.CANCELLED
    });
    expect(harness.state.quote.status).toBe(SubscriptionChangeQuoteStatus.CUSTOMER_REJECTED);
  });
});

interface HarnessOptions {
  activeChange?: boolean;
  enabled?: boolean;
  publishedQuote?: boolean;
}

function portalRenewalHarness(options: HarnessOptions = {}) {
  const customer = {
    accountStatus: "ACTIVE",
    customerAccountId: "account-1",
    customerId: "customer-1",
    phone: "13800138000"
  } as never;
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  const state = {
    commands: [] as Array<Record<string, unknown>>,
    consideration: {
      changeOrderId: null as string | null,
      completionDeadlineAt: new Date("2026-09-02T16:00:00.000Z"),
      considerationStartAt: new Date("2026-08-03T01:00:00.000Z"),
      createdAt: new Date("2026-08-03T01:00:00.000Z"),
      decision: null as RenewalDecision | null,
      decidedAt: null as Date | null,
      id: "consideration-1",
      order: {
        customerId: "customer-1",
        id: "order-1",
        orderNo: "ORD-1",
        periodMonths: 6,
        vehicle: { plateNo: "沪DGU581" }
      },
      orderId: "order-1",
      reminders: [],
      segment: {
        endDate: new Date("2026-09-02T00:00:00.000Z"),
        id: "segment-1",
        monthlyFeeAmount: 88_000n,
        sequenceNo: 1,
        startDate: new Date("2026-03-03T00:00:00.000Z"),
        status: "ACTIVE",
        subscriptionPlanId: "plan-source"
      },
      segmentId: "segment-1",
      status: RenewalConsiderationStatus.PENDING_DECISION,
      updatedAt: new Date("2026-08-03T01:00:00.000Z"),
      version: 0
    },
    change: {
      cancelReason: null as string | null,
      changeType: SubscriptionChangeType.EXTENSION,
      completionDeadlineAt: new Date("2026-09-02T16:00:00.000Z"),
      confirmedQuoteId: null as string | null,
      currentQuoteId: "quote-1",
      customerConfirmationPublishedAt: options.publishedQuote
        ? new Date("2026-08-05T04:00:00.000Z")
        : null,
      id: "change-1",
      contractId: null,
      extensionMonths: 6,
      order: { customerId: "customer-1", id: "order-1" },
      orderId: "order-1",
      pricingMode: "CURRENT_VERSION",
      renewalConsiderationId: "consideration-1",
      sourceSegment: null as unknown,
      status: SubscriptionChangeStatus.QUOTED,
      targetEndDate: new Date("2027-03-02T00:00:00.000Z"),
      targetSegment: null,
      targetStartDate: new Date("2026-09-03T00:00:00.000Z"),
      version: 0
    },
    quote: {
      changeOrderId: "change-1",
      id: "quote-1",
      energyLimitCount: 2,
      energyLimitKwh: null,
      mileageLimitKm: 1_500,
      monthlyFeeAmount: 88_000n,
      overMileageFeeAmount: 100n,
      pricingMode: "CURRENT_VERSION",
      quoteNo: "SCQ-1",
      revision: 2,
      status: SubscriptionChangeQuoteStatus.FORMAL,
      validUntil: new Date("2026-08-08T04:00:00.000Z")
    }
  };
  state.change.sourceSegment = state.consideration.segment;
  const querySql: string[] = [];
  const prisma = {
    $queryRaw: vi.fn(async (sql: { strings?: readonly string[] }) => {
      querySql.push(sql.strings?.join(" ") ?? String(sql));
      return [];
    }),
    $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => operation(prisma)),
    auditLog: { create: vi.fn(async () => ({})) },
    renewalConsideration: {
      findFirst: vi.fn(async () => state.consideration),
      findMany: vi.fn(async () => [state.consideration]),
      findUnique: vi.fn(async () => state.consideration),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        applyMutation(state.consideration, data);
        return state.consideration;
      })
    },
    renewalReminder: { updateMany: vi.fn(async () => ({ count: 3 })) },
    subscriptionAutomationJob: { updateMany: vi.fn(async () => ({ count: 3 })) },
    subscriptionChangeCommand: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const command = {
          ...data,
          completedAt: null,
          id: `command-${state.commands.length + 1}`,
          resourceId: null,
          resourceType: null
        };
        state.commands.push(command);
        return command;
      }),
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
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
          Object.assign(command, data);
          return command;
        }
      )
    },
    subscriptionChangeOrder: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        applyMutation(state.change, { ...data, id: "change-1" });
        return state.change;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) => {
        if (where.id) {
          return {
            ...state.change,
            currentQuote: state.quote,
            order: state.change.order,
            quotes: [state.quote]
          };
        }
        return options.activeChange ? state.change : null;
      }),
      findUnique: vi.fn(async () => ({
        ...state.change,
        currentQuote: state.quote,
        order: state.change.order,
        quotes: [state.quote]
      })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        applyMutation(state.change, data);
        return {
          ...state.change,
          currentQuote: state.quote,
          order: state.change.order,
          quotes: [state.quote]
        };
      })
    },
    subscriptionChangeQuote: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        applyMutation(state.quote, data);
        return state.quote;
      })
    },
    subscriptionContractSegment: { findMany: vi.fn(async () => [state.consideration.segment]) }
  };
  const service = new PortalRenewalService(
    prisma as never,
    { write: vi.fn(async () => undefined) } as never,
    {
      enabled: options.enabled ?? true,
      extensionEnabled: options.enabled ?? true,
      now: () => new Date("2026-08-05T04:00:00.000Z"),
      quoteValidityHours: 72
    },
    new SubscriptionChangeRepository(prisma as never)
  );
  return {
    context,
    customer,
    lockedTables: () =>
      querySql.flatMap((sql) =>
        ["subscription_order", "subscription_contract_segment", "subscription_change_order"].filter(
          (table) => sql.includes(`"${table}"`)
        )
      ),
    prisma,
    service,
    state
  };
}

function applyMutation(target: Record<string, unknown>, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && "increment" in value) {
      target[key] = Number(target[key] ?? 0) + Number(value.increment);
    } else {
      target[key] = value;
    }
  }
}
