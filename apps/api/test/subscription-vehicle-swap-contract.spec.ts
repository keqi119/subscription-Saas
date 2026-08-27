import {
  BusinessType,
  ContractStatus,
  ContractTemplateType,
  ContractVersionStatus,
  SubscriptionChangeQuoteStatus,
  SubscriptionChangeStatus,
  SubscriptionChangeType,
  VehicleStatus
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionVehicleSwapContractService } from "../src/subscription-change/subscription-vehicle-swap-contract.service";

describe("SubscriptionVehicleSwapContractService", () => {
  it("generates one supplement with both vehicles, commercial deltas, and physical obligations", async () => {
    const harness = contractHarness();

    const contract = await harness.service.generate(
      "change-swap",
      { idempotencyKey: "swap-contract-1", version: 3 },
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
    const create = harness.prisma.contract.create.mock.calls[0]![0];
    expect(create.data.contractSnapshot).toMatchObject({
      confirmedQuote: { id: "quote-confirmed", revision: 2 },
      originalContract: { contractId: "contract-original", contractNo: "CON-ORIGINAL" },
      swap: {
        commercial: {
          classification: "OUT_OF_PACKAGE",
          deltas: {
            depositAmount: "50000",
            mileageLimitKm: 500,
            monthlyFeeAmount: "12000"
          }
        },
        deliveryConditions: expect.any(Array),
        plannedSwapAt: "2026-09-15T02:00:00.000Z",
        returnObligations: expect.any(Array),
        sourceVehicle: { id: "vehicle-source", vehicleNo: "VEH-SOURCE" },
        targetVehicle: { id: "vehicle-target", vehicleNo: "VEH-TARGET" }
      }
    });
    const artifactInput = harness.artifactWriter.writeGeneratedContractPdfArtifact.mock
      .calls[0]![0] as { renderModel: unknown };
    expect(artifactInput.renderModel).toMatchObject({
      agreementKind: "VEHICLE_SWAP_SUPPLEMENT",
      swapTerms: {
        confirmedQuoteNo: "SCQ-SWAP-2",
        plannedSwapAt: new Date("2026-09-15T02:00:00.000Z"),
        sourceVehicleNo: "VEH-SOURCE",
        targetVehicleNo: "VEH-TARGET"
      }
    });
    expect(contract.id).toBe("contract-swap");
    expect(harness.state.change.status).toBe(SubscriptionChangeStatus.SIGNING_OR_PAYMENT);
    expect(harness.state.order.contractId).toBe("contract-original");
  });

  it("returns the same supplement on exact replay", async () => {
    const harness = contractHarness();
    const command = { idempotencyKey: "swap-contract-replay", version: 3 };

    const first = await harness.service.generate(
      "change-swap",
      command,
      harness.actor,
      harness.context
    );
    const second = await harness.service.generate(
      "change-swap",
      command,
      harness.actor,
      harness.context
    );

    expect(second.id).toBe(first.id);
    expect(harness.prisma.contract.create).toHaveBeenCalledOnce();
    expect(harness.artifactWriter.writeGeneratedContractPdfArtifact).toHaveBeenCalledOnce();
  });

  it("starts one e-sign task and replays the same task for the exact command", async () => {
    const harness = contractHarness();
    await harness.service.generate(
      "change-swap",
      { idempotencyKey: "swap-contract-before-esign", version: 3 },
      harness.actor,
      harness.context
    );
    const start = vi.fn(async () => ({ id: "task-swap" }));
    const replay = vi.fn(async (taskId: string) => ({ id: taskId }));
    const command = { idempotencyKey: "swap-esign-replay", version: 4 };

    const first = await harness.service.startOrRetryESign(
      "change-swap",
      command,
      harness.actor,
      start,
      replay
    );
    const second = await harness.service.startOrRetryESign(
      "change-swap",
      command,
      harness.actor,
      start,
      replay
    );

    expect(first.id).toBe("task-swap");
    expect(second.id).toBe("task-swap");
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith("contract-swap");
    expect(replay).toHaveBeenCalledOnce();
    expect(replay).toHaveBeenCalledWith("task-swap");
  });

  it.each([
    [
      { changeStatus: SubscriptionChangeStatus.QUOTED },
      "VEHICLE_SWAP_CUSTOMER_CONFIRMATION_REQUIRED"
    ],
    [
      { quoteStatus: SubscriptionChangeQuoteStatus.FORMAL },
      "VEHICLE_SWAP_CONFIRMED_QUOTE_REQUIRED"
    ],
    [{ targetStatus: VehicleStatus.AVAILABLE }, "VEHICLE_SWAP_TARGET_RESERVATION_REQUIRED"]
  ] as const)("rejects an invalid supplement source %#", async (options, code) => {
    const harness = contractHarness(options);

    await expect(
      harness.service.generate(
        "change-swap",
        { idempotencyKey: `invalid-${code}`, version: 3 },
        harness.actor,
        harness.context
      )
    ).rejects.toMatchObject({ code });
    expect(harness.prisma.contract.create).not.toHaveBeenCalled();
  });
});

interface HarnessOptions {
  changeStatus?: SubscriptionChangeStatus;
  quoteStatus?: SubscriptionChangeQuoteStatus;
  targetStatus?: VehicleStatus;
}

function contractHarness(options: HarnessOptions = {}) {
  const now = new Date("2026-08-27T04:00:00.000Z");
  const confirmedQuote = {
    changeOrderId: "change-swap",
    depositAmount: 350_000n,
    energyLimitCount: 6,
    energyLimitKwh: null,
    id: "quote-confirmed",
    mileageLimitKm: 2_000,
    monthlyFeeAmount: 100_000n,
    overMileageFeeAmount: 100n,
    planSnapshot: { planNo: "PLAN-TARGET" },
    pricingMode: "CURRENT_VERSION",
    productId: "product-1",
    productVersionId: "version-1",
    quoteNo: "SCQ-SWAP-2",
    quoteSnapshot: {
      commercialSnapshot: {
        classification: "OUT_OF_PACKAGE",
        deltas: {
          depositAmount: "50000",
          energyLimitCount: 2,
          energyLimitKwh: null,
          mileageLimitKm: 500,
          monthlyFeeAmount: "12000"
        }
      },
      commercialSnapshotHash: "a".repeat(64)
    },
    revision: 2,
    status: options.quoteStatus ?? SubscriptionChangeQuoteStatus.CUSTOMER_CONFIRMED,
    subscriptionPlanId: "plan-target",
    validUntil: new Date("2026-09-01T00:00:00.000Z")
  };
  const order = {
    contractId: "contract-original",
    customer: {
      id: "customer-1",
      identity: { idCardNo: "310101199001011234" },
      mobile: "13800000000",
      name: "Test Customer",
      profile: { residenceAddress: "Shanghai" }
    },
    customerId: "customer-1",
    id: "order-1",
    orderNo: "ORD-SWAP-1"
  };
  const change: Record<string, unknown> = {
    changeType: SubscriptionChangeType.VEHICLE_SWAP,
    completionDeadlineAt: new Date("2026-09-15T02:00:00.000Z"),
    confirmedQuote,
    confirmedQuoteId: confirmedQuote.id,
    contract: null,
    contractId: null,
    id: "change-swap",
    order,
    orderId: order.id,
    sourceSegment: {
      endDate: new Date("2027-02-28T00:00:00.000Z"),
      id: "segment-source",
      sourceContract: {
        contractNo: "CON-ORIGINAL",
        id: "contract-original",
        status: ContractStatus.ARCHIVED
      }
    },
    status: options.changeStatus ?? SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
    vehicleSwapDetail: {
      plannedSwapAt: new Date("2026-09-15T02:00:00.000Z"),
      sourceVehicle: {
        brand: "NIO",
        id: "vehicle-source",
        model: "ET5",
        modelDefinitionId: "model-source",
        plateNo: "沪A12345",
        status: VehicleStatus.LEASED,
        vehicleNo: "VEH-SOURCE",
        vin: "VIN-SOURCE"
      },
      sourceVehicleId: "vehicle-source",
      targetSubscriptionPlanId: "plan-target",
      targetVehicle: {
        brand: "NIO",
        id: "vehicle-target",
        model: "ES6",
        modelDefinitionId: "model-target",
        plateNo: null,
        status: options.targetStatus ?? VehicleStatus.REVIEW_RESERVED,
        vehicleNo: "VEH-TARGET",
        vin: "VIN-TARGET"
      },
      targetVehicleId: "vehicle-target",
      targetVehiclePackageId: "package-target"
    },
    version: 3
  };
  const commands = new Map<string, Record<string, unknown>>();
  let contract: Record<string, unknown> | null = null;
  const refresh = () => ({ ...change, contract });
  const prisma = {
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)),
    contract: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        contract = {
          ...data,
          createdAt: now,
          fileId: null,
          id: "contract-swap",
          status: ContractStatus.GENERATED
        };
        return contract;
      }),
      findUnique: vi.fn(async () => contract),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        contract = { ...contract, ...data };
        return contract;
      })
    },
    contractVersion: {
      findFirst: vi.fn(async () => ({
        businessType: BusinessType.SUBSCRIPTION,
        contentTemplate: "Vehicle swap supplement terms",
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        id: "template-supplement",
        status: ContractVersionStatus.ACTIVE,
        templateName: "Subscription supplement",
        templateType: ContractTemplateType.SUBSCRIPTION_EXTENSION,
        versionNo: "V1.0"
      })),
      findUnique: vi.fn(async () => null)
    },
    subscriptionChangeCommand: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          ...data,
          completedAt: null,
          id: `command-${commands.size + 1}`,
          resourceId: null,
          resourceType: null,
          updatedAt: now
        };
        commands.set(`${data.actorId}:${data.operation}:${data.idempotencyKey}`, row);
        return row;
      }),
      delete: vi.fn(async () => ({})),
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ("id" in where) {
          return [...commands.values()].find((item) => item.id === where.id) ?? null;
        }
        const identity = where.actorId_operation_idempotencyKey as Record<string, string>;
        return (
          commands.get(`${identity.actorId}:${identity.operation}:${identity.idempotencyKey}`) ??
          null
        );
      }),
      update: vi.fn(
        async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
          const row = [...commands.values()].find((item) => item.id === where.id)!;
          Object.assign(row, data, { updatedAt: now });
          return row;
        }
      )
    },
    subscriptionChangeOrder: {
      findUnique: vi.fn(async () => refresh()),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const previousVersion = Number(change.version);
        Object.assign(change, data);
        if (data.version && typeof data.version === "object") {
          change.version =
            previousVersion + Number((data.version as { increment: number }).increment);
        }
        return refresh();
      }),
      updateMany: vi.fn(async () => ({ count: 1 }))
    }
  };
  const artifactWriter = {
    writeGeneratedContractPdfArtifact: vi.fn(async (input: unknown) => {
      void input;
      return {
        bucket: "test",
        diagnostics: {},
        fileId: "file-swap",
        mimeType: "application/pdf",
        objectKey: "contracts/swap.pdf",
        originalName: "swap.pdf",
        sizeBytes: 1024
      };
    })
  };
  const actor = {
    id: "operator-1",
    menus: [],
    name: "Operator",
    permissions: [PermissionCode.CONTRACT_GENERATE, PermissionCode.SUBSCRIPTION_CHANGE_ESIGN_RETRY],
    roles: ["OP"],
    username: "operator"
  };
  return {
    actor,
    artifactWriter,
    context: { ipAddress: "127.0.0.1", userAgent: "vitest" },
    prisma,
    service: new SubscriptionVehicleSwapContractService(
      prisma as never,
      { write: vi.fn(async () => undefined) } as never,
      artifactWriter as never,
      { assertVehicleCoveredThrough: vi.fn(async () => undefined) } as never,
      { get: vi.fn(() => undefined) } as never,
      { enabled: true, now: () => now, quoteValidityHours: 72 }
    ),
    state: { change, order }
  };
}
