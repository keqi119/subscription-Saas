import {
  AuditAction,
  BusinessType,
  ContractStatus,
  ContractTemplateType,
  ContractVersionStatus,
  SubscriptionChangePricingMode,
  SubscriptionChangeQuoteStatus,
  SubscriptionChangeStatus,
  SubscriptionChangeType
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionExtensionContractService } from "../src/subscription-change/subscription-extension-contract.service";

describe("SubscriptionExtensionContractService", () => {
  it("selects only an active SUBSCRIPTION_EXTENSION template and preserves the original contract", async () => {
    const harness = contractHarness();

    const contract = await harness.service.generate(
      "change-1",
      contractCommand(),
      harness.actor,
      harness.context
    );

    expect(harness.prisma.contractVersion.findFirst).toHaveBeenCalledWith({
      orderBy: { effectiveFrom: "desc" },
      where: expect.objectContaining({
        businessType: BusinessType.SUBSCRIPTION,
        status: ContractVersionStatus.ACTIVE,
        templateType: ContractTemplateType.SUBSCRIPTION_EXTENSION
      })
    });
    expect(harness.insuranceService.assertVehicleCoveredThrough).toHaveBeenCalledWith(
      "vehicle-1",
      new Date("2027-03-02T00:00:00.000Z")
    );
    expect(harness.prisma.subscriptionOrder.update).not.toHaveBeenCalled();
    expect(harness.state.change.contractId).toBe(contract.id);
    expect(harness.state.change.status).toBe(SubscriptionChangeStatus.SIGNING_OR_PAYMENT);
    expect(harness.state.order.contractId).toBe("contract-original");
  });

  it("stores a frozen extension snapshot with original contract, dates, and confirmed quote", async () => {
    const harness = contractHarness();

    await harness.service.generate("change-1", contractCommand(), harness.actor, harness.context);

    const create = harness.prisma.contract.create.mock.calls[0]![0];
    expect(create.data.contractSnapshot).toMatchObject({
      confirmedQuote: {
        id: "quote-confirmed",
        quoteNo: "SCQ202608050001",
        revision: 3
      },
      extension: {
        endDate: "2027-03-02",
        monthlyFeeAmount: "97000",
        startDate: "2026-09-03"
      },
      originalContract: {
        contractId: "contract-original",
        contractNo: "CON202602020001",
        endDate: "2026-09-02"
      }
    });
    const writerCalls = harness.artifactWriter.writeGeneratedContractPdfArtifact.mock
      .calls as unknown as Array<[{ renderModel: Record<string, unknown> }]>;
    const renderModel = writerCalls[0]![0].renderModel;
    expect(renderModel).toMatchObject({
      agreementKind: "SUBSCRIPTION_EXTENSION",
      extensionTerms: {
        confirmedQuoteNo: "SCQ202608050001",
        extensionEndDate: new Date("2027-03-02T00:00:00.000Z"),
        extensionStartDate: new Date("2026-09-03T00:00:00.000Z"),
        originalContractNo: "CON202602020001",
        originalEndDate: new Date("2026-09-02T00:00:00.000Z")
      }
    });
  });

  it("generates identical contract terms from typed-only and legacy-compatible extension facts", async () => {
    const legacy = contractHarness();
    const typed = contractHarness({ typedDetailOnly: true });

    await legacy.service.generate(
      "change-1",
      contractCommand("legacy"),
      legacy.actor,
      legacy.context
    );
    await typed.service.generate("change-1", contractCommand("typed"), typed.actor, typed.context);

    const legacyCreate = legacy.prisma.contract.create.mock.calls[0]![0];
    const typedCreate = typed.prisma.contract.create.mock.calls[0]![0];
    expect(typedCreate.data.contractSnapshot).toEqual(legacyCreate.data.contractSnapshot);
    const legacyRender = legacy.artifactWriter.writeGeneratedContractPdfArtifact.mock.calls[0]![0]
      .renderModel as Record<string, unknown>;
    const typedRender = typed.artifactWriter.writeGeneratedContractPdfArtifact.mock.calls[0]![0]
      .renderModel as Record<string, unknown>;
    expect(typedRender.extensionTerms).toEqual(legacyRender.extensionTerms);
  });

  it("returns the existing effective extension contract on a safe retry", async () => {
    const harness = contractHarness({ existingContract: true });

    const contract = await harness.service.generate(
      "change-1",
      contractCommand(),
      harness.actor,
      harness.context
    );

    expect(contract.id).toBe("contract-extension");
    expect(harness.insuranceService.assertVehicleCoveredThrough).not.toHaveBeenCalled();
    expect(harness.prisma.contract.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: SubscriptionChangeStatus.QUOTED }, "EXTENSION_CUSTOMER_CONFIRMATION_REQUIRED"],
    [{ confirmedQuote: null }, "EXTENSION_CONFIRMED_QUOTE_REQUIRED"],
    [{ now: new Date("2026-09-02T16:00:00.000Z") }, "EXTENSION_DEADLINE_PASSED"]
  ] as const)("rejects an invalid generation state %#", async (options, code) => {
    const harness = contractHarness(options);

    await expect(
      harness.service.generate("change-1", contractCommand(), harness.actor, harness.context)
    ).rejects.toMatchObject({ code });
    expect(harness.prisma.contract.create).not.toHaveBeenCalled();
  });

  it("fails closed when no active extension template exists", async () => {
    const harness = contractHarness({ template: null });

    await expect(
      harness.service.generate("change-1", contractCommand(), harness.actor, harness.context)
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_EXTENSION_TEMPLATE_NOT_FOUND" });
    expect(harness.prisma.contract.create).not.toHaveBeenCalled();
  });

  it("checks insurance before creating the contract", async () => {
    const harness = contractHarness({ insuranceCovered: false });

    await expect(
      harness.service.generate("change-1", contractCommand(), harness.actor, harness.context)
    ).rejects.toMatchObject({ code: "VEHICLE_INSURANCE_COVERAGE_INSUFFICIENT" });
    expect(harness.prisma.contractVersion.findFirst).not.toHaveBeenCalled();
    expect(harness.prisma.contract.create).not.toHaveBeenCalled();
  });

  it("audits generation without changing the order's original contract pointer", async () => {
    const harness = contractHarness();

    await harness.service.generate("change-1", contractCommand(), harness.actor, harness.context);

    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CREATE,
        entityType: "subscription_extension_contract",
        module: "subscription_change",
        operatorId: harness.actor.id
      }),
      expect.anything()
    );
  });

  it("fails closed before generation when the extension feature is disabled", async () => {
    const harness = contractHarness({ enabled: false });

    await expect(
      harness.service.generate("change-1", contractCommand(), harness.actor, harness.context)
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_EXTENSION_DISABLED" });
    expect(harness.prisma.contract.create).not.toHaveBeenCalled();
  });

  it("requires an idempotency key and optimistic-lock version", async () => {
    const harness = contractHarness();

    await expect(
      harness.service.generate(
        "change-1",
        { idempotencyKey: undefined, version: 2 },
        harness.actor,
        harness.context
      )
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    expect(harness.prisma.contract.create).not.toHaveBeenCalled();
  });

  it("serializes concurrent contract commands and creates one artifact", async () => {
    const harness = contractHarness();

    const results = await Promise.allSettled([
      harness.service.generate(
        "change-1",
        contractCommand("contract-a"),
        harness.actor,
        harness.context
      ),
      harness.service.generate(
        "change-1",
        contractCommand("contract-b"),
        harness.actor,
        harness.context
      )
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "IDEMPOTENCY_COMMAND_IN_PROGRESS" })
      })
    ]);
    expect(harness.prisma.contract.create).toHaveBeenCalledOnce();
    expect(harness.artifactWriter.writeGeneratedContractPdfArtifact).toHaveBeenCalledOnce();
  });

  it("recovers the reserved contract after upload succeeds but finalization fails", async () => {
    const harness = contractHarness({ finalizeFailsOnce: true });

    await expect(
      harness.service.generate(
        "change-1",
        contractCommand("contract-recovery"),
        harness.actor,
        harness.context
      )
    ).rejects.toThrow("finalization unavailable");
    harness.advanceNow(121_000);

    await expect(
      harness.service.generate(
        "change-1",
        contractCommand("contract-recovery"),
        harness.actor,
        harness.context
      )
    ).resolves.toMatchObject({ id: "contract-new", fileId: "file-extension" });
    expect(harness.prisma.contract.create).toHaveBeenCalledOnce();
    expect(harness.artifactWriter.writeGeneratedContractPdfArtifact).toHaveBeenCalledTimes(2);
    expect(
      harness.artifactWriter.writeGeneratedContractPdfArtifact.mock.calls[1]![0]
    ).toMatchObject({ recoverExistingObject: true });
  });
});

interface HarnessOptions {
  confirmedQuote?: Record<string, unknown> | null;
  enabled?: boolean;
  existingContract?: boolean;
  finalizeFailsOnce?: boolean;
  insuranceCovered?: boolean;
  now?: Date;
  status?: SubscriptionChangeStatus;
  template?: Record<string, unknown> | null;
  typedDetailOnly?: boolean;
}

interface PrismaHarness {
  $queryRaw: ReturnType<typeof vi.fn>;
  $transaction: ReturnType<typeof vi.fn>;
  contract: {
    create: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  contractChargeClauseSnapshot: {
    createMany: ReturnType<typeof vi.fn>;
  };
  contractVersion: {
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
  subscriptionChangeOrder: {
    findUnique: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  subscriptionChangeCommand: {
    create: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  subscriptionOrder: { update: ReturnType<typeof vi.fn> };
}

interface MutationArgs {
  data: Record<string, unknown>;
}

function contractHarness(options: HarnessOptions = {}) {
  let currentNow = options.now ?? new Date("2026-08-05T04:00:00.000Z");
  let failFinalize = options.finalizeFailsOnce ?? false;
  const actor = {
    id: "op-1",
    menus: [],
    name: "Operator",
    permissions: [PermissionCode.CONTRACT_GENERATE],
    roles: ["OP"],
    username: "op"
  };
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  const originalContract = {
    contractNo: "CON202602020001",
    id: "contract-original",
    status: ContractStatus.ARCHIVED
  };
  const quote =
    options.confirmedQuote === null
      ? null
      : {
          depositAmount: 0n,
          energyLimitCount: 2,
          energyLimitKwh: null,
          id: "quote-confirmed",
          mileageLimitKm: 1_500,
          monthlyFeeAmount: 97_000n,
          overMileageFeeAmount: 100n,
          planSnapshot: { planCode: "PLAN-EXTENSION" },
          quoteNo: "SCQ202608050001",
          quoteSnapshot: { quoteNo: "SCQ202608050001" },
          revision: 3,
          status: SubscriptionChangeQuoteStatus.CUSTOMER_CONFIRMED,
          subscriptionPlanId: "plan-extension",
          ...options.confirmedQuote
        };
  const existingContract = options.existingContract
    ? {
        businessType: BusinessType.SUBSCRIPTION,
        contractNo: "CON202608050002",
        contractSnapshot: {},
        contractTitle: "Subscription Extension V1.0",
        contractVersionId: "template-extension",
        createdAt: new Date("2026-08-05T04:00:00.000Z"),
        customerId: "customer-1",
        fileId: "file-extension" as string | null,
        id: "contract-extension",
        orderId: "order-1",
        status: ContractStatus.GENERATED,
        updatedAt: new Date("2026-08-05T04:00:00.000Z")
      }
    : null;
  const sourceSegment = {
    endDate: new Date("2026-09-02T00:00:00.000Z"),
    id: "segment-base",
    sourceContract: originalContract,
    sourceContractId: originalContract.id
  };
  const state = {
    change: {
      changeType: SubscriptionChangeType.EXTENSION,
      completionDeadlineAt: new Date("2026-09-02T16:00:00.000Z"),
      confirmedQuote: quote,
      confirmedQuoteId: quote?.id ?? null,
      contract: existingContract,
      contractId: existingContract?.id ?? null,
      extensionDetail: options.typedDetailOnly
        ? {
            extensionMonths: 6,
            priceOverrideApprovedAt: null,
            priceOverrideApprovedBy: null,
            priceOverrideReason: null,
            pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION,
            sourceSegment,
            sourceSegmentId: sourceSegment.id,
            targetEndDate: new Date("2027-03-02T00:00:00.000Z"),
            targetStartDate: new Date("2026-09-03T00:00:00.000Z")
          }
        : null,
      extensionMonths: options.typedDetailOnly ? null : 6,
      id: "change-1",
      order: {
        businessType: BusinessType.SUBSCRIPTION,
        contractId: "contract-original",
        customer: {
          id: "customer-1",
          identity: { idCardNo: "TEST-ID-001" },
          mobile: "13800000000",
          name: "Synthetic Customer",
          profile: { residenceAddress: "Synthetic Address" }
        },
        customerId: "customer-1",
        id: "order-1",
        orderNo: "ORD202602020001",
        vehicle: {
          brand: "NIO",
          id: "vehicle-1",
          model: "ET5",
          plateNo: "沪DGU581",
          vehicleNo: "VEH-001"
        },
        vehicleId: "vehicle-1"
      },
      orderId: "order-1",
      pricingMode: options.typedDetailOnly ? null : SubscriptionChangePricingMode.CURRENT_VERSION,
      sourceSegment: options.typedDetailOnly ? null : sourceSegment,
      status:
        options.status ??
        (options.existingContract
          ? SubscriptionChangeStatus.SIGNING_OR_PAYMENT
          : SubscriptionChangeStatus.CUSTOMER_CONFIRMED),
      targetEndDate: options.typedDetailOnly ? null : new Date("2027-03-02T00:00:00.000Z"),
      targetStartDate: options.typedDetailOnly ? null : new Date("2026-09-03T00:00:00.000Z"),
      version: 2
    },
    order: { contractId: "contract-original" }
  };
  const commands = new Map<string, Record<string, unknown>>();
  let transactionTail = Promise.resolve();
  const template =
    options.template === null
      ? null
      : {
          businessType: BusinessType.SUBSCRIPTION,
          contentTemplate: "Synthetic extension agreement legal body.",
          effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
          effectiveTo: null,
          id: "template-extension",
          status: ContractVersionStatus.ACTIVE,
          templateName: "Subscription Extension Agreement",
          templateType: ContractTemplateType.SUBSCRIPTION_EXTENSION,
          versionNo: "V1.0",
          ...options.template
        };
  const createdContract = {
    businessType: BusinessType.SUBSCRIPTION,
    contractNo: "CON202608050001",
    contractSnapshot: {},
    contractTitle: "Subscription Extension Agreement V1.0",
    contractVersionId: "template-extension",
    createdAt: new Date("2026-08-05T04:00:00.000Z"),
    customerId: "customer-1",
    fileId: null as string | null,
    id: "contract-new",
    orderId: "order-1",
    status: ContractStatus.GENERATED,
    updatedAt: new Date("2026-08-05T04:00:00.000Z")
  };
  const prisma: PrismaHarness = {
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => {
      const previous = transactionTail;
      let release: () => void = () => {};
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
    contract: {
      create: vi.fn(async (args: MutationArgs) => {
        Object.assign(createdContract, args.data);
        return { ...createdContract };
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === createdContract.id ? { ...createdContract } : null
      ),
      update: vi.fn(async (args: MutationArgs) => {
        if (failFinalize && args.data.fileId) {
          failFinalize = false;
          throw new Error("finalization unavailable");
        }
        Object.assign(createdContract, args.data);
        return { ...createdContract };
      })
    },
    contractChargeClauseSnapshot: {
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }))
    },
    contractVersion: {
      findFirst: vi.fn(async () => template),
      findUnique: vi.fn(async () => template)
    },
    subscriptionChangeOrder: {
      findUnique: vi.fn(async () => state.change),
      update: vi.fn(async (args: MutationArgs) => {
        Object.assign(state.change, args.data);
        if (typeof args.data.contractId === "string") {
          state.change.contract = { ...createdContract, id: args.data.contractId };
        }
        return state.change;
      }),
      updateMany: vi.fn(
        async ({
          data,
          where
        }: {
          data: Record<string, unknown>;
          where: Record<string, unknown>;
        }) => {
          if (where.id === state.change.id && where.contractId === state.change.contractId) {
            Object.assign(state.change, data);
            if (data.contractId === null) state.change.contract = null;
            return { count: 1 };
          }
          return { count: 0 };
        }
      )
    },
    subscriptionChangeCommand: {
      create: vi.fn(async ({ data }: MutationArgs) => {
        const key = `${String(data.actorId)}:${String(data.operation)}:${String(data.idempotencyKey)}`;
        if (commands.has(key)) {
          throw Object.assign(new Error("duplicate command"), { code: "P2002" });
        }
        const row = {
          ...data,
          completedAt: null,
          createdAt: currentNow,
          id: `command-${commands.size + 1}`,
          updatedAt: currentNow
        };
        commands.set(key, row);
        return row;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        for (const [key, row] of commands) {
          if (row.id === where.id) commands.delete(key);
        }
        return {};
      }),
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ("id" in where) {
          return [...commands.values()].find((row) => row.id === where.id) ?? null;
        }
        const identity = where.actorId_operation_idempotencyKey as Record<string, unknown>;
        const key = `${String(identity.actorId)}:${String(identity.operation)}:${String(identity.idempotencyKey)}`;
        return commands.get(key) ?? null;
      }),
      update: vi.fn(
        async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
          const row = [...commands.values()].find((item) => item.id === where.id);
          if (!row) throw new Error("command not found");
          Object.assign(row, data);
          return row;
        }
      )
    },
    subscriptionOrder: {
      update: vi.fn()
    }
  };
  const artifactWriter = {
    writeGeneratedContractPdfArtifact: vi.fn(async (input: Record<string, unknown>) => {
      void input;
      return {
        bucket: "contracts",
        diagnostics: {},
        fileId: "file-extension",
        mimeType: "application/pdf",
        objectKey: "contracts/contract-new/generated/CON202608050001.pdf",
        originalName: "CON202608050001.pdf",
        sizeBytes: 1024
      };
    })
  };
  const insuranceService = {
    assertVehicleCoveredThrough: vi.fn(async () => {
      if (options.insuranceCovered === false) {
        throw Object.assign(new Error("insurance does not cover target end date"), {
          code: "VEHICLE_INSURANCE_COVERAGE_INSUFFICIENT"
        });
      }
    })
  };
  const auditService = { write: vi.fn(async () => undefined) };
  const configService = {
    get: vi.fn((key: string) =>
      key === "CONTRACT_PDF_CJK_FONT_PATH" ? "/fonts/cjk.ttf" : undefined
    )
  };
  const service = new SubscriptionExtensionContractService(
    prisma as never,
    auditService as never,
    artifactWriter as never,
    insuranceService as never,
    configService as never,
    {
      enabled: options.enabled ?? true,
      now: () => currentNow,
      quoteValidityHours: 72
    },
    () => currentNow
  );

  return {
    actor,
    advanceNow: (milliseconds: number) => {
      currentNow = new Date(currentNow.getTime() + milliseconds);
    },
    artifactWriter,
    auditService,
    context,
    insuranceService,
    prisma,
    service,
    state
  };
}

function contractCommand(idempotencyKey = "contract-generate-1") {
  return { idempotencyKey, version: 2 };
}
