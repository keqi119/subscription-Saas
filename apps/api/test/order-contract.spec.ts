import { Readable } from "node:stream";

import {
  ApplicationStatus,
  BusinessType,
  ContractStatus,
  ContractVersionStatus,
  OrderChangeType,
  OrderSource,
  OrderStatus,
  ProductStatus,
  QuoteStatus,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { createBusinessNo, withUniqueBusinessNoRetry } from "../src/common/business-number";
import { STAGE1_CONTRACT_PDF_SIGNING_SLOT_DEFINITIONS } from "../src/contract/contract-pdf-render-model";
import {
  ensureAllowedChangeType,
  ensureSubscriptionBusinessType,
  OrderService
} from "../src/order/order.service";

const STAGE1_SLOT_KEYWORDS = [
  "合同正文-订阅方签字",
  "合同正文-服务提供方盖章",
  "附件1订阅方案-订阅方签字",
  "附件1订阅方案-服务提供方盖章"
];

describe("subscription order and contract rules", () => {
  it("defaults order business type to subscription", () => {
    expect(ensureSubscriptionBusinessType()).toBe(BusinessType.SUBSCRIPTION);
    expect(ensureSubscriptionBusinessType(BusinessType.SUBSCRIPTION)).toBe(
      BusinessType.SUBSCRIPTION
    );
  });

  it("rejects rent-to-own order creation during the current phase", () => {
    expect(() => ensureSubscriptionBusinessType(BusinessType.RENT_TO_OWN)).toThrow(
      "当前阶段暂未开放以租代购订单"
    );
  });

  it("allows current-stage subscription order change types", () => {
    expect(() => ensureAllowedChangeType(OrderChangeType.PLAN_CHANGE)).not.toThrow();
    expect(() => ensureAllowedChangeType(OrderChangeType.VEHICLE_SWAP)).not.toThrow();
    expect(() => ensureAllowedChangeType(OrderChangeType.TERMINATION)).not.toThrow();
  });

  it("rejects rent-to-own only order change types during the current phase", () => {
    expect(() => ensureAllowedChangeType(OrderChangeType.BUYOUT)).toThrow(
      "当前阶段暂未开放以租代购订单变更"
    );
    expect(() => ensureAllowedChangeType(OrderChangeType.EARLY_SETTLEMENT)).toThrow(
      "当前阶段暂未开放以租代购订单变更"
    );
    expect(() => ensureAllowedChangeType(OrderChangeType.OWNERSHIP_TRANSFER)).toThrow(
      "当前阶段暂未开放以租代购订单变更"
    );
  });

  it("cancels the generated contract and rolls the order back for regeneration", async () => {
    const harness = createOrderServiceHarness();

    const firstContract = (await harness.service.generateContract(
      harness.orderId,
      harness.user,
      harness.context
    )) as Record<string, unknown>;

    expect(harness.state.contractId).toBe(firstContract.id);
    expect(harness.state.orderStatus).toBe(OrderStatus.PENDING_SIGN);

    const cancelled = (await harness.service.cancelContract(
      firstContract.id as string,
      harness.user,
      harness.context
    )) as {
      order: { contractId: string | null; orderStatus: OrderStatus };
      status: ContractStatus;
    };

    expect(cancelled.status).toBe(ContractStatus.CANCELLED);
    expect(cancelled.order.contractId).toBeNull();
    expect(cancelled.order.orderStatus).toBe(OrderStatus.PENDING_CONTRACT);
    expect(harness.state.contractId).toBeNull();
    expect(harness.state.orderStatus).toBe(OrderStatus.PENDING_CONTRACT);

    const secondContract = (await harness.service.generateContract(
      harness.orderId,
      harness.user,
      harness.context
    )) as Record<string, unknown>;

    expect(secondContract.id).not.toBe(firstContract.id);
    expect(harness.state.contractId).toBe(secondContract.id);
    expect(harness.state.orderStatus).toBe(OrderStatus.PENDING_SIGN);
  });

  it("keeps legacy contract generation behavior when PDF artifact generation is disabled", async () => {
    const harness = createOrderServiceHarness({
      artifactWriter: createArtifactWriterMock()
    });

    const contract = (await harness.service.generateContract(
      harness.orderId,
      harness.user,
      harness.context
    )) as Record<string, unknown>;

    expect(contract.fileId).toBeNull();
    expect(harness.artifactWriter.writeGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(harness.state.contractId).toBe(contract.id);
    expect(harness.state.orderStatus).toBe(OrderStatus.PENDING_SIGN);
  });

  it("attaches a generated PDF artifact before moving the order to pending sign when enabled", async () => {
    const harness = createOrderServiceHarness({
      artifactGenerationEnabled: true,
      artifactWriter: createArtifactWriterMock({ fileId: "generated-file-1" })
    });

    const contract = (await harness.service.generateContract(
      harness.orderId,
      harness.user,
      harness.context
    )) as Record<string, unknown>;

    expect(harness.artifactWriter.writeGeneratedContractPdfArtifact).toHaveBeenCalledOnce();
    type ArtifactWriterInput = {
      renderModel: {
        appendix: {
          sections: Array<{
            rows: Array<{ label: string; value: unknown }>;
            title: string;
          }>;
        };
        contentTemplate: string;
        signingSlots: Array<{
          documentType: string;
          keyword: string;
          signerRole: string;
          slotId: string;
          stage: string;
        }>;
        signingStage: string;
        subscriberParty?: Record<string, unknown>;
      };
    } & Record<string, unknown>;
    const calls = harness.artifactWriter.writeGeneratedContractPdfArtifact.mock.calls as unknown as Array<[ArtifactWriterInput]>;
    const input = calls[0]?.[0];
    if (!input) {
      throw new Error("expected artifact writer input");
    }
    expect(input).toMatchObject({
      contractStatus: ContractStatus.GENERATED,
      existingContractFileId: null,
      uploadedBy: harness.user.id
    });
    expect(input.renderModel).toMatchObject({
      contractId: "contract-1",
      contractNo: contract.contractNo,
      contentTemplate: harness.template.contentTemplate,
      orderNo: "ORD202606020800000001",
      signingStage: "STAGE1_CONTRACT",
      templateName: harness.template.templateName,
      templateVersion: harness.template.versionNo
    });
    expect(input.renderModel.signingSlots).toEqual([
      expect.objectContaining({
        documentType: "CONTRACT_BODY",
        keyword: "合同正文-订阅方签字",
        signerRole: "CUSTOMER",
        slotId: "STAGE1_BODY_CUSTOMER",
        stage: "STAGE1_CONTRACT"
      }),
      expect.objectContaining({
        documentType: "CONTRACT_BODY",
        keyword: "合同正文-服务提供方盖章",
        signerRole: "PLATFORM",
        slotId: "STAGE1_BODY_PLATFORM",
        stage: "STAGE1_CONTRACT"
      }),
      expect.objectContaining({
        documentType: "ATTACHMENT1_SUBSCRIPTION_PLAN",
        keyword: "附件1订阅方案-订阅方签字",
        signerRole: "CUSTOMER",
        slotId: "STAGE1_ATTACHMENT1_CUSTOMER",
        stage: "STAGE1_CONTRACT"
      }),
      expect.objectContaining({
        documentType: "ATTACHMENT1_SUBSCRIPTION_PLAN",
        keyword: "附件1订阅方案-服务提供方盖章",
        signerRole: "PLATFORM",
        slotId: "STAGE1_ATTACHMENT1_PLATFORM",
        stage: "STAGE1_CONTRACT"
      })
    ]);
    expect(input.renderModel.signingSlots.map((slot) => slot.keyword)).toEqual(STAGE1_SLOT_KEYWORDS);
    expect(input.renderModel.signingSlots.map((slot) => slot.keyword)).not.toContain("服务提供方盖章");
    expect(input.renderModel.signingSlots.map((slot) => slot.keyword)).not.toContain("订阅方盖章/签字");
    expect(input.renderModel.appendix.sections.length).toBeGreaterThan(0);
    expect(input.renderModel.subscriberParty).toEqual({
      subscriberContactAddress: "上海市测试路 1 号",
      subscriberContactName: "测试客户",
      subscriberContactPhone: "13800000000",
      subscriberEmail: null,
      subscriberIdNumber: "TEST-ID-0001",
      subscriberName: "测试客户",
      subscriberWechat: null
    });
    const planSection = input.renderModel.appendix.sections.find((section) => section.title === "订阅方案摘要");
    expect(planSection?.rows).toEqual(expect.arrayContaining([
      { label: "月租金（人民币元）", value: "3000.00" },
      { label: "押金（人民币元）", value: "5000.00" },
      { label: "里程额度（公里/月）", value: 1500 },
      { label: "能源额度（kWh/月）", value: 200 },
      { label: "能源次数（次/月）", value: 4 },
      { label: "超里程费（人民币元/公里）", value: "1.00" }
    ]));
    const planRowLabels = planSection?.rows.map((row) => row.label) ?? [];
    expect(planRowLabels).not.toEqual(expect.arrayContaining([
      "月租金（分）",
      "押金（分）",
      "里程额度（公里）",
      "能源额度（kWh）",
      "能源次数",
      "超里程费（分）"
    ]));
    const searchableModel = JSON.stringify(input.renderModel);
    expect(searchableModel).not.toContain("risk-result-1");
    expect(searchableModel).not.toContain("VIN202606020000001");
    expect(searchableModel).not.toContain("DELIVERY_HANDOVER");
    expect(JSON.stringify(contract)).not.toContain("TEST-ID-0001");
    expect(JSON.stringify(harness.state.contracts[0]!.contractSnapshot)).not.toContain("TEST-ID-0001");
    expect(JSON.stringify(harness.auditService.write.mock.calls)).not.toContain("TEST-ID-0001");
    expect(searchableModel).not.toContain("附件2");
    expect(contract.fileId).toBe("generated-file-1");
    expect(harness.state.contracts[0]!.fileId).toBe("generated-file-1");
    expect(harness.state.contractId).toBe(contract.id);
    expect(harness.state.orderStatus).toBe(OrderStatus.PENDING_SIGN);
  });

  it("previews the generated signing source PDF for an admin contract", async () => {
    const harness = createOrderServiceHarness({
      artifactGenerationEnabled: true,
      artifactWriter: createArtifactWriterMock({ fileId: "generated-file-1" })
    });

    const contract = (await harness.service.generateContract(
      harness.orderId,
      harness.user,
      harness.context
    )) as Record<string, unknown>;

    const preview = await (harness.service as unknown as {
      previewGeneratedContractPdf: (id: string, user: typeof harness.user) => Promise<{
        filename: string;
        mimeType?: string | null;
        sizeBytes: number;
        stream: Readable;
      }>;
    }).previewGeneratedContractPdf(contract.id as string, harness.user);

    expect(harness.prisma.fileObject.findUnique).toHaveBeenCalledWith({
      where: { id: "generated-file-1" }
    });
    expect(harness.storageService.getObject).toHaveBeenCalledWith(
      "application-materials",
      "contracts/contract-1/generated/CON-TEST.pdf"
    );
    expect(preview).toMatchObject({
      filename: "CON-TEST.pdf",
      mimeType: "application/pdf",
      sizeBytes: 17
    });
  });

  it("blocks Stage 1 PDF generation when the subscriber ID number is missing", async () => {
    const harness = createOrderServiceHarness({
      artifactGenerationEnabled: true,
      artifactWriter: createArtifactWriterMock({ fileId: "generated-file-1" }),
      customer: {
        identity: null,
        profile: null
      }
    });

    await expect(harness.service.generateContract(harness.orderId, harness.user, harness.context))
      .rejects.toThrow("STAGE1_PARTY_B_ID_NUMBER_MISSING");

    expect(harness.artifactWriter.writeGeneratedContractPdfArtifact).not.toHaveBeenCalled();
    expect(harness.state.contractId).toBeNull();
    expect(harness.state.orderStatus).toBe(OrderStatus.PENDING_CONTRACT);
    expect(harness.state.contracts).toHaveLength(0);
  });

  it("persists generated PDF slot coordinates in the contract snapshot", async () => {
    const slotCoordinates = createSlotCoordinates();
    const harness = createOrderServiceHarness({
      artifactGenerationEnabled: true,
      artifactWriter: createArtifactWriterMock({
        fileId: "generated-file-1",
        slotCoordinates
      })
    });

    const contract = (await harness.service.generateContract(
      harness.orderId,
      harness.user,
      harness.context
    )) as Record<string, unknown>;

    expect(contract.fileId).toBe("generated-file-1");
    expect(harness.state.orderStatus).toBe(OrderStatus.PENDING_SIGN);
    expect(harness.state.contracts[0]!.contractSnapshot).toMatchObject({
      generatedContractPdfArtifact: {
        fileId: "generated-file-1",
        objectKey: "contracts/contract-1/generated/CON-TEST.pdf",
        signingStage: "STAGE1_CONTRACT",
        slotCoordinates,
        source: "GENERATED_CONTRACT_PDF"
      }
    });
  });

  it("does not advance the order when generated PDF artifact writing fails", async () => {
    const writerError = new Error("writer failed");
    const harness = createOrderServiceHarness({
      artifactGenerationEnabled: true,
      artifactWriter: createArtifactWriterMock({ error: writerError })
    });

    await expect(
      harness.service.generateContract(harness.orderId, harness.user, harness.context)
    ).rejects.toThrow(writerError);

    expect(harness.artifactWriter.writeGeneratedContractPdfArtifact).toHaveBeenCalledOnce();
    expect(harness.state.contractId).toBeNull();
    expect(harness.state.orderStatus).toBe(OrderStatus.PENDING_CONTRACT);
    expect(harness.state.contracts[0]!.status).toBe(ContractStatus.CANCELLED);
  });

  it("does not advance the order when Contract.fileId update fails", async () => {
    const updateError = new Error("contract file update failed");
    const harness = createOrderServiceHarness({
      artifactGenerationEnabled: true,
      artifactWriter: createArtifactWriterMock({ fileId: "generated-file-1" }),
      contractFileUpdateError: updateError
    });

    await expect(
      harness.service.generateContract(harness.orderId, harness.user, harness.context)
    ).rejects.toThrow(updateError);

    expect(harness.artifactWriter.writeGeneratedContractPdfArtifact).toHaveBeenCalledOnce();
    expect(harness.state.contractId).toBeNull();
    expect(harness.state.orderStatus).toBe(OrderStatus.PENDING_CONTRACT);
    expect(harness.state.contracts[0]!.status).toBe(ContractStatus.CANCELLED);
  });

  it("does not advance the order when slot coordinate persistence fails", async () => {
    const updateError = new Error("contract snapshot update failed");
    const harness = createOrderServiceHarness({
      artifactGenerationEnabled: true,
      artifactWriter: createArtifactWriterMock({ fileId: "generated-file-1" }),
      contractSnapshotUpdateError: updateError
    });

    await expect(
      harness.service.generateContract(harness.orderId, harness.user, harness.context)
    ).rejects.toThrow(updateError);

    expect(harness.artifactWriter.writeGeneratedContractPdfArtifact).toHaveBeenCalledOnce();
    expect(harness.state.contractId).toBeNull();
    expect(harness.state.orderStatus).toBe(OrderStatus.PENDING_CONTRACT);
    expect(harness.state.contracts[0]!.status).toBe(ContractStatus.CANCELLED);
  });

  it("rejects cancelling an archived contract", async () => {
    const harness = createOrderServiceHarness();
    const contract = (await harness.service.generateContract(
      harness.orderId,
      harness.user,
      harness.context
    )) as Record<string, unknown>;

    harness.state.contracts[0]!.status = ContractStatus.ARCHIVED;

    await expect(
      harness.service.cancelContract(contract.id as string, harness.user, harness.context)
    ).rejects.toThrow("已归档合同不能取消");
  });

  it("creates an order from a confirmed quote only after the vehicle is reserved", async () => {
    const harness = createOrderServiceHarness();
    harness.state.vehicleStatus = VehicleStatus.RESERVED;

    const order = (await harness.service.createOrderFromQuote(
      harness.quoteId,
      { businessType: BusinessType.SUBSCRIPTION },
      harness.user,
      harness.context
    )) as { quoteSnapshot: { vehicleSnapshot?: { vehicleNo?: string } }; vehicleId: string | null };

    expect(order.vehicleId).toBe(harness.vehicleId);
    expect(order.quoteSnapshot.vehicleSnapshot?.vehicleNo).toBe("VEH2026060200001");
    expect(harness.prisma.subscriptionOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderStatus: OrderStatus.PENDING_CONTRACT
        })
      })
    );
    expect(harness.prisma.subscriptionOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({
          orderSource: OrderSource.CUSTOMER_SELF_SERVICE,
          orderStatus: OrderStatus.PENDING_REVIEW
        })
      })
    );
  });

  it("freezes the quote model snapshot when creating an order from quote", async () => {
    const harness = createOrderServiceHarness({
      quote: {
        modelCodeSnapshot: "NIO_ET5",
        modelDefinitionIdSnapshot: "quote-model-definition",
        modelDisplayNameSnapshot: "Quote Frozen ET5"
      },
      vehicle: {
        modelDefinition: {
          displayName: "Current Vehicle Display",
          id: "current-vehicle-model-definition",
          modelCode: "CURRENT_MODEL"
        },
        modelDefinitionId: "current-vehicle-model-definition"
      }
    });
    harness.state.vehicleStatus = VehicleStatus.RESERVED;

    await harness.service.createOrderFromQuote(
      harness.quoteId,
      { businessType: BusinessType.SUBSCRIPTION },
      harness.user,
      harness.context
    );

    expect(harness.prisma.subscriptionOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modelCodeSnapshot: "NIO_ET5",
          modelDefinitionIdSnapshot: "quote-model-definition",
          modelDisplayNameSnapshot: "Quote Frozen ET5"
        })
      })
    );
  });

  it("copies the required canonical model code snapshot from the quote", async () => {
    const harness = createOrderServiceHarness({
      quote: {
        modelCodeSnapshot: "MODEL_X_2027",
        modelDefinitionIdSnapshot: "quote-model-definition",
        modelDisplayNameSnapshot: "Model X 2027"
      }
    });
    harness.state.vehicleStatus = VehicleStatus.RESERVED;

    await harness.service.createOrderFromQuote(
      harness.quoteId,
      { businessType: BusinessType.SUBSCRIPTION },
      harness.user,
      harness.context
    );

    expect(harness.prisma.subscriptionOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modelCodeSnapshot: "MODEL_X_2027"
        })
      })
    );
  });

  it("reads legacy sales-assisted order details without A/B extension fields", async () => {
    const harness = createOrderServiceHarness();

    const order = (await harness.service.getOrder(harness.orderId, harness.user)) as {
      orderStatus: OrderStatus;
      quoteSnapshot: { vehicleSnapshot?: { vehicleNo?: string } };
    };

    expect(order.orderStatus).toBe(OrderStatus.PENDING_CONTRACT);
    expect(order.quoteSnapshot.vehicleSnapshot?.vehicleNo).toBe("VEH2026060200001");
  });

  it("order response exposes snapshot display metadata before runtime vehicle display", async () => {
    const harness = createOrderServiceHarness({
      order: {
        modelCodeSnapshot: "NIO_ET5",
        modelDefinitionIdSnapshot: "snapshot-model",
        modelDisplayNameSnapshot: "Frozen Order ET5"
      },
      vehicle: {
        modelDefinition: {
          displayName: "Runtime Vehicle ET5",
          id: "runtime-model",
          modelCode: "RUNTIME_ET5"
        },
        modelDefinitionId: "runtime-model"
      }
    });

    const order = (await harness.service.getOrder(harness.orderId, harness.user)) as {
      modelCodeSnapshot: string;
      modelDefinitionIdSnapshot: string;
      modelDisplayName: string;
      modelDisplaySource: string;
    };

    expect(order).toMatchObject({
      modelCodeSnapshot: "NIO_ET5",
      modelDefinitionIdSnapshot: "snapshot-model",
      modelDisplayName: "Frozen Order ET5",
      modelDisplaySource: "SNAPSHOT"
    });
  });

  it("rejects creating an order when the quote vehicle is not locked", async () => {
    const harness = createOrderServiceHarness();
    harness.state.vehicleStatus = VehicleStatus.AVAILABLE;

    await expect(
      harness.service.createOrderFromQuote(
        harness.quoteId,
        { businessType: BusinessType.SUBSCRIPTION },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("已确认报价绑定车辆未锁定");
  });

  it("releases the reserved vehicle when cancelling a pre-delivery order", async () => {
    const harness = createOrderServiceHarness();
    harness.state.orderStatus = OrderStatus.PENDING_CONTRACT;
    harness.state.vehicleStatus = VehicleStatus.RESERVED;

    await harness.service.cancelOrder(
      harness.orderId,
      { reason: "customer withdrew" },
      harness.user,
      harness.context
    );

    expect(harness.state.vehicleStatus).toBe(VehicleStatus.AVAILABLE);
    expect(harness.tx.vehicle.update).toHaveBeenCalledWith({
      data: { status: VehicleStatus.AVAILABLE, updatedBy: harness.user.id },
      where: { id: harness.vehicleId }
    });
  });

  it("does not release a vehicle when cancelling is rejected for an active order", async () => {
    const harness = createOrderServiceHarness();
    harness.state.orderStatus = OrderStatus.ACTIVE;
    harness.state.vehicleStatus = VehicleStatus.RESERVED;

    await expect(
      harness.service.cancelOrder(
        harness.orderId,
        { reason: "cannot cancel active order" },
        harness.user,
        harness.context
      )
    ).rejects.toThrow();

    expect(harness.state.vehicleStatus).toBe(VehicleStatus.RESERVED);
    expect(harness.tx.vehicle.update).not.toHaveBeenCalled();
  });

  it("lists non-deleted contracts without search filters", async () => {
    const { findMany, service } = createContractListService();

    await service.listContracts(contractListUser());

    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({
      deletedAt: null,
      order: { deletedAt: null }
    });
  });

  it("excludes contracts whose parent order is soft deleted", async () => {
    const { service } = createContractListService({
      contracts: [
        contractListRecord("contract-active", null),
        contractListRecord(
          "contract-deleted-order",
          new Date("2026-07-28T08:00:00.000Z")
        )
      ]
    });

    const contracts = await service.listContracts(contractListUser());

    expect(contracts.map((contract) => contract.id)).toEqual([
      "contract-active"
    ]);
  });

  it("filters contracts by a trimmed case-insensitive contract number", async () => {
    const { findMany, service } = createContractListService();

    await service.listContracts(contractListUser(), { contractNo: "  con-2026  " });

    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({
      AND: [{ contractNo: { contains: "con-2026", mode: "insensitive" } }],
      deletedAt: null,
      order: { deletedAt: null }
    });
  });

  it("filters contracts by a case-insensitive order number", async () => {
    const { findMany, service } = createContractListService();

    await service.listContracts(contractListUser(), { orderNo: "ord-2026" });

    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({
      AND: [{ order: { orderNo: { contains: "ord-2026", mode: "insensitive" } } }],
      deletedAt: null,
      order: { deletedAt: null }
    });
  });

  it("combines contract and order number filters with AND", async () => {
    const { findMany, service } = createContractListService();

    await service.listContracts(contractListUser(), { contractNo: "CON-2026", orderNo: "ORD-2026" });

    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({
      AND: [
        { contractNo: { contains: "CON-2026", mode: "insensitive" } },
        { order: { orderNo: { contains: "ORD-2026", mode: "insensitive" } } }
      ],
      deletedAt: null,
      order: { deletedAt: null }
    });
  });

  it("preserves the sales-user scope while applying contract search", async () => {
    const { findMany, service } = createContractListService();

    await service.listContracts(contractListUser({ id: "sales-1", roles: ["SA"] }), {
      contractNo: "CON-2026"
    });

    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({
      AND: [{ contractNo: { contains: "CON-2026", mode: "insensitive" } }],
      deletedAt: null,
      order: {
        application: { salesUserId: "sales-1" },
        deletedAt: null
      }
    });
  });

  it("generates timestamp and random business numbers without count based suffixes", () => {
    const now = new Date(2026, 5, 2, 15, 30, 45);
    let sequence = 0;
    const numbers = Array.from({ length: 100 }, () =>
      createBusinessNo("ORD", now, () => String(sequence++).padStart(4, "0"))
    );

    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers[0]).toBe("ORD202606021530450000");
    expect(numbers.at(-1)).toBe("ORD202606021530450099");
  });

  it("retries creation when a generated business number hits a unique constraint", async () => {
    let attempts = 0;
    const result = await withUniqueBusinessNoRetry(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw { code: "P2002" };
      }
      return "created";
    });

    expect(result).toBe("created");
    expect(attempts).toBe(3);
  });
});

function createContractListService(options: {
  contracts?: Array<Record<string, unknown>>;
} = {}) {
  const findMany = vi.fn(async (args: {
    where?: {
      deletedAt?: Date | null;
      order?: {
        deletedAt?: Date | null;
      };
    };
  }) => {
    return (options.contracts ?? []).filter((contract) => {
      if (args.where?.deletedAt === null && contract.deletedAt !== null) {
        return false;
      }
      const order = contract.order as { deletedAt: Date | null };
      if (
        args.where?.order?.deletedAt === null &&
        order.deletedAt !== null
      ) {
        return false;
      }
      return true;
    });
  });
  const service = new OrderService(
    { write: vi.fn(async () => undefined) } as never,
    { contract: { findMany } } as never,
    {} as never,
    {} as never,
    {} as never
  );

  return { findMany, service };
}

function contractListRecord(id: string, orderDeletedAt: Date | null) {
  return {
    contractSnapshot: null,
    deletedAt: null,
    fileId: null,
    id,
    order: {
      deletedAt: orderDeletedAt,
      id: `order-${id}`
    }
  };
}

function contractListUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "admin-1",
    menus: [],
    name: "Admin",
    permissions: [],
    roles: ["ADMIN"],
    username: "admin",
    ...overrides
  } as never;
}

function createOrderServiceHarness(options: {
  artifactGenerationEnabled?: boolean;
  artifactWriter?: ReturnType<typeof createArtifactWriterMock>;
  contractFileUpdateError?: Error;
  contractSnapshotUpdateError?: Error;
  customer?: Record<string, unknown>;
  order?: Record<string, unknown>;
  quote?: Record<string, unknown>;
  vehicle?: Record<string, unknown>;
} = {}) {
  const now = new Date("2026-06-02T08:00:00.000Z");
  const orderId = "order-1";
  const quoteId = "quote-1";
  const vehicleId = "vehicle-1";
  const user = {
    id: "user-1",
    menus: [],
    name: "Admin",
    permissions: [],
    roles: ["ADMIN"],
    username: "admin"
  };
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  const state: {
    contractId: string | null;
    contracts: Array<Record<string, unknown> & { id: string; status: ContractStatus }>;
    orderStatus: OrderStatus;
    quoteSnapshot: Record<string, unknown> | null;
    vehicleStatus: VehicleStatus;
  } = {
    contractId: null,
    contracts: [],
    orderStatus: OrderStatus.PENDING_CONTRACT,
    quoteSnapshot: null,
    vehicleStatus: VehicleStatus.RESERVED
  };
  const template = {
    approvedAt: now,
    approvedBy: user.id,
    businessType: BusinessType.SUBSCRIPTION,
    contentTemplate: "合同模板",
    createdAt: now,
    createdBy: user.id,
    deletedAt: null,
    effectiveFrom: now,
    effectiveTo: null,
    fileId: null,
    id: "contract-version-1",
    status: ContractVersionStatus.ACTIVE,
    templateName: "订阅合同",
    templateType: "SUBSCRIPTION_STANDARD",
    updatedAt: now,
    updatedBy: user.id,
    versionNo: "V1.0"
  };

  function buildVehicle() {
    return {
      brand: "NIO",
      createdAt: now,
      currentSalePriceAmount: 10000000n,
      deletedAt: null,
      id: vehicleId,
      model: "ET5",
      modelDefinition: {
        displayName: "ET5",
        id: "model-et5",
        modelCode: "NIO_ET5"
      },
      modelDefinitionId: "model-et5",
      plateNo: "沪A00001",
      purchasePriceAmount: 12000000n,
      status: state.vehicleStatus,
      updatedAt: now,
      vehicleNo: "VEH2026060200001",
      vin: "VIN202606020000001",
      ...options.vehicle
    };
  }

  function buildCustomer() {
    return {
      grade: "A",
      id: "customer-1",
      identity: { idCardNo: "TEST-ID-0001" },
      mobile: "13800000000",
      name: "测试客户",
      profile: { residenceAddress: "上海市测试路 1 号" },
      ...options.customer
    };
  }

  function buildQuote() {
    return {
      application: {
        applicationNo: "APP202606020001",
        id: "application-1",
        salesUserId: user.id,
        status: ApplicationStatus.APPROVED
      },
      applicationId: "application-1",
      cancelledAt: null,
      createdAt: now,
      createdBy: user.id,
      customer: buildCustomer(),
      customerId: "customer-1",
      deletedAt: null,
      depositAmount: 500000n,
      energyLimitCount: 4,
      energyLimitKwh: 200,
      expiredAt: null,
      id: quoteId,
      mileageLimitKm: 1500,
      modelCodeSnapshot: "NIO_ET5",
      modelDefinitionIdSnapshot: "model-et5",
      modelDisplayNameSnapshot: "ET5",
      monthlyFeeAmount: 300000n,
      order: null,
      overMileageFeeAmount: 100n,
      periodMonths: 12,
      productId: "product-1",
      productVersion: {
        product: { productType: BusinessType.SUBSCRIPTION, status: ProductStatus.ACTIVE }
      },
      productVersionId: "product-version-1",
      quoteNo: "QUO202606020800000001",
      riskResult: { id: "risk-result-1" },
      riskResultId: "risk-result-1",
      status: QuoteStatus.CONFIRMED,
      updatedAt: now,
      updatedBy: user.id,
      vehicle: buildVehicle(),
      vehicleId,
      vehiclePurchasePriceAmount: 10000000n,
      vehicleSnapshot: { vehicleNo: "VEH2026060200001", vin: "VIN202606020000001" },
      ...options.quote
    };
  }

  function buildOrder() {
    const currentContract =
      state.contracts.find((contract) => contract.id === state.contractId) ?? null;
    return {
      actualDeliveryAt: null,
      application: {
        applicationNo: "APP202606020001",
        id: "application-1",
        salesUserId: user.id,
        status: ApplicationStatus.APPROVED
      },
      applicationId: "application-1",
      businessType: BusinessType.SUBSCRIPTION,
      changes: [],
      contract: currentContract,
      contractId: state.contractId,
      contracts: state.contracts,
      createdAt: now,
      createdBy: user.id,
      customer: buildCustomer(),
      customerId: "customer-1",
      deletedAt: null,
      depositAmount: 500000n,
      endDate: null,
      energyLimitCount: 4,
      energyLimitKwh: 200,
      id: orderId,
      mileageLimitKm: 1500,
      modelCodeSnapshot: "NIO_ET5",
      modelDefinitionIdSnapshot: "model-et5",
      modelDisplayNameSnapshot: "ET5",
      monthlyFeeAmount: 300000n,
      orderNo: "ORD202606020800000001",
      orderStatus: state.orderStatus,
      overMileageFeeAmount: 100n,
      periodMonths: 12,
      productId: "product-1",
      productVersion: {
        product: { productType: BusinessType.SUBSCRIPTION, status: ProductStatus.ACTIVE }
      },
      productVersionId: "product-version-1",
      quote: { id: quoteId, quoteNo: "QUO202606020800000001", status: QuoteStatus.CONFIRMED },
      quoteId,
      quoteSnapshot: state.quoteSnapshot ?? {
        vehicleSnapshot: { vehicleNo: "VEH2026060200001", vin: "VIN202606020000001" }
      },
      riskResult: { id: "risk-result-1" },
      riskResultId: "risk-result-1",
      startDate: null,
      updatedAt: now,
      updatedBy: user.id,
      vehicle: buildVehicle(),
      vehicleId,
      vehiclePurchasePriceAmount: 10000000n,
      ...options.order
    };
  }

  function buildContract(
    contract: Record<string, unknown> & { id: string; status: ContractStatus }
  ) {
    return {
      ...contract,
      contractVersion: template,
      customer: { id: "customer-1", mobile: "13800000000", name: "测试客户" },
      order: buildOrder()
    };
  }

  const tx = {
    contract: {
      count: vi.fn(async () => state.contracts.length),
      create: vi.fn(async ({ data }) => {
        const contract = {
          ...data,
          archivedAt: null,
          createdAt: now,
          deletedAt: null,
          fileId: null,
          id: `contract-${state.contracts.length + 1}`,
          signedAt: null,
          updatedAt: now
        };
        state.contracts.push(contract);
        return contract;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }) => {
        const contract = state.contracts.find((item) => item.id === where.id);
        if (!contract) {
          throw new Error("Contract not found");
        }
        return buildContract(contract);
      }),
      update: vi.fn(async ({ data, where }) => {
        const contract = state.contracts.find((item) => item.id === where.id);
        if (!contract) {
          throw new Error("Contract not found");
        }
        if ("fileId" in data && options.contractFileUpdateError) {
          throw options.contractFileUpdateError;
        }
        if ("contractSnapshot" in data && options.contractSnapshotUpdateError) {
          throw options.contractSnapshotUpdateError;
        }
        Object.assign(contract, data);
        return buildContract(contract);
      })
    },
    subscriptionOrder: {
      create: vi.fn(async ({ data }) => {
        if (data.orderStatus) {
          state.orderStatus = data.orderStatus;
        }
        state.quoteSnapshot = data.quoteSnapshot as Record<string, unknown>;
        return buildOrder();
      }),
      update: vi.fn(async ({ data }) => {
        if ("contractId" in data) {
          state.contractId = data.contractId;
        }
        if (data.orderStatus) {
          state.orderStatus = data.orderStatus;
        }
        return buildOrder();
      })
    },
    vehicle: {
      update: vi.fn(async ({ data }) => {
        if (data.status) {
          state.vehicleStatus = data.status;
        }
        return buildVehicle();
      })
    }
  };

  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
    contract: {
      findUnique: vi.fn(async ({ where }) => {
        const contract = state.contracts.find((item) => item.id === where.id);
        return contract ? buildContract(contract) : null;
      }),
      update: vi.fn(async ({ data, where }) => {
        const contract = state.contracts.find((item) => item.id === where.id);
        if (!contract) {
          throw new Error("Contract not found");
        }
        Object.assign(contract, data);
        return buildContract(contract);
      })
    },
    fileObject: {
      findUnique: vi.fn(async ({ where }) => {
        if (where.id !== "generated-file-1") {
          return null;
        }
        return {
          bucket: "application-materials",
          createdAt: now,
          id: "generated-file-1",
          mimeType: "application/pdf",
          objectKey: "contracts/contract-1/generated/CON-TEST.pdf",
          originalName: "CON-TEST.pdf",
          sizeBytes: 17n,
          uploadedBy: user.id
        };
      })
    },
    contractVersion: {
      findFirst: vi.fn(async () => template)
    },
    subscriptionQuote: {
      findUnique: vi.fn(async () => buildQuote())
    },
    subscriptionOrder: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }) => {
        if (data.orderStatus) {
          state.orderStatus = data.orderStatus;
        }
        state.quoteSnapshot = data.quoteSnapshot as Record<string, unknown>;
        return buildOrder();
      }),
      findUnique: vi.fn(async () => buildOrder())
    }
  };
  const auditService = { write: vi.fn(async () => undefined) };
  const artifactWriter = options.artifactWriter ?? createArtifactWriterMock();
  const configService = {
    get: vi.fn((key: string) => {
      if (key === "CONTRACT_PDF_ARTIFACT_GENERATION_ENABLED") {
        return options.artifactGenerationEnabled ? "true" : undefined;
      }
      return undefined;
    })
  };
  const storageService = {
    getObject: vi.fn(async () => ({
      contentLength: 17,
      contentType: "application/pdf",
      stream: Readable.from([Buffer.from("%PDF-1.4\n%%EOF\n")])
    }))
  };
  const service = new OrderService(
    auditService as never,
    prisma as never,
    artifactWriter as never,
    configService as never,
    storageService as never
  );

  return { artifactWriter, auditService, context, orderId, prisma, quoteId, service, state, storageService, template, tx, user, vehicleId };
}

function createArtifactWriterMock(options: {
  error?: Error;
  fileId?: string;
  slotCoordinates?: ReturnType<typeof createSlotCoordinates>;
} = {}) {
  return {
    writeGeneratedContractPdfArtifact: vi.fn(async () => {
      if (options.error) {
        throw options.error;
      }
      return {
        bucket: "application-materials",
        diagnostics: {
          anchorOccurrences: {
            stage1SigningSlots: {
              STAGE1_ATTACHMENT1_CUSTOMER: 1,
              STAGE1_ATTACHMENT1_PLATFORM: 1,
              STAGE1_BODY_CUSTOMER: 1,
              STAGE1_BODY_PLATFORM: 1
            }
          },
          renderDiagnostics: {
            hasAppendix: true,
            hasCjkContent: true,
            hasCustomerSignatureKeyword: true,
            hasLegalBody: true,
            hasPlatformSealKeyword: true,
            hasStage1SigningSlots: true
          },
          searchableTextPdfRequired: true,
          signingStage: "STAGE1_CONTRACT",
          slotCoordinates: options.slotCoordinates ?? createSlotCoordinates(),
          source: "GENERATED_CONTRACT_PDF",
          textExtractionVerified: false
        },
        fileId: options.fileId ?? "generated-file-1",
        mimeType: "application/pdf",
        objectKey: "contracts/contract-1/generated/CON-TEST.pdf",
        originalName: "CON-TEST.pdf",
        sizeBytes: 1024
      };
    })
  };
}

function createSlotCoordinates() {
  return STAGE1_CONTRACT_PDF_SIGNING_SLOT_DEFINITIONS.map((slot, index) => ({
    coordinateSource: "PDFKIT_RENDERER",
    coordinateSystem: "FADADA_800_1131_TOP_LEFT",
    documentType: slot.documentType,
    height: 48,
    keyword: slot.keyword,
    pageNumber: slot.documentType === "CONTRACT_BODY" ? 0 : 1,
    pdfPageHeight: 841.89,
    pdfPageWidth: 595.28,
    signerRole: slot.signerRole,
    signingStage: "STAGE1_CONTRACT",
    slotId: slot.slotId,
    width: 160,
    x: slot.signerRole === "CUSTOMER" ? 520 : 620,
    y: 720 + index
  }));
}
