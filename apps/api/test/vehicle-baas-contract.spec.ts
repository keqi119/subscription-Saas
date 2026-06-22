import {
  VehicleBaasBillingCycle,
  VehicleBaasContractStatus,
  VehicleBaasCostRecordStatus,
  VehicleBaasCostSource,
  VehicleBatteryUsageType
} from "@prisma/client";
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { VehicleBaasService } from "../src/vehicle-baas/vehicle-baas.service";

describe("VehicleBaasService contract and cost records", () => {
  it("creates a DRAFT BaaS contract", async () => {
    const { prisma, service, user } = createHarness();

    const contract = await service.createContract(
      "vehicle-1",
      {
        contractNo: "BAAS-001",
        effectiveFrom: "2026-07-01",
        paymentDayOfMonth: 15,
        providerName: "NIO Power",
        rentalAmount: 98000
      },
      user
    );

    expect(contract).toMatchObject({
      contractNo: "BAAS-001",
      contractStatus: VehicleBaasContractStatus.DRAFT,
      paymentDayOfMonth: 15,
      providerName: "NIO Power",
      rentalAmount: 98000
    });
    expect(prisma.vehicleBaasContract.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contractNo: "BAAS-001",
          contractStatus: VehicleBaasContractStatus.DRAFT,
          vehicleId: "vehicle-1"
        })
      })
    );
  });

  it("activates a BAAS vehicle contract", async () => {
    const { prisma, service, user } = createHarness();

    const contract = await service.activateContract("contract-1", user);

    expect(contract.contractStatus).toBe(VehicleBaasContractStatus.ACTIVE);
    expect(prisma.vehicleBaasContract.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contractStatus: VehicleBaasContractStatus.ACTIVE
        })
      })
    );
  });

  it("rejects activation for non-BAAS vehicles", async () => {
    const { service, user } = createHarness({ batteryUsageType: VehicleBatteryUsageType.BUYOUT });

    await expect(service.activateContract("contract-1", user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("prevents two ACTIVE contracts for the same vehicle", async () => {
    const { prisma, service, user } = createHarness();
    prisma.vehicleBaasContract.count.mockResolvedValueOnce(1);

    await expect(service.activateContract("contract-1", user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("uploads contract attachments through private storage and hides object fields", async () => {
    const { service, storageService, user } = createHarness();

    const attachment = await service.uploadAttachment(
      "contract-1",
      { attachmentType: "CONTRACT", title: "BaaS 服务协议" },
      [uploadFile("baas.pdf", "application/pdf")],
      user
    );

    expect(storageService.putVehicleBaasContractAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        contractId: "contract-1",
        originalName: "baas.pdf"
      })
    );
    expect(attachment).toMatchObject({
      attachmentType: "CONTRACT",
      previewUrl: "/api/vehicle-baas-contract-attachments/attachment-1/preview",
      title: "BaaS 服务协议"
    });
    expect(attachment).not.toHaveProperty("bucket");
    expect(attachment).not.toHaveProperty("objectKey");
  });

  it("rejects video attachments", async () => {
    const { service, storageService, user } = createHarness();

    await expect(
      service.uploadAttachment("contract-1", {}, [uploadFile("baas.mp4", "video/mp4")], user)
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storageService.putVehicleBaasContractAttachment).not.toHaveBeenCalled();
  });

  it("dry-runs monthly cost record generation without writing", async () => {
    const { prisma, service, user } = createHarness();

    const result = await service.generateCostRecords(
      "contract-1",
      { dryRun: true, fromPeriod: "2026-07", toPeriod: "2026-09" },
      user
    );

    expect(result).toMatchObject({
      dryRun: true,
      generatedCount: 0,
      skippedCount: 0
    });
    expect(result.records).toHaveLength(3);
    expect(prisma.vehicleBaasCostRecord.create).not.toHaveBeenCalled();
  });

  it("generates cost records and uses month-end when payment day exceeds month length", async () => {
    const { prisma, service, user } = createHarness({ paymentDayOfMonth: 31 });

    const result = await service.generateCostRecords(
      "contract-1",
      { dryRun: false, fromPeriod: "2026-02", toPeriod: "2026-02" },
      user
    );

    expect(result.generatedCount).toBe(1);
    expect(prisma.vehicleBaasCostRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          costPeriod: "2026-02",
          dueDate: new Date("2026-02-28T00:00:00.000Z")
        })
      })
    );
  });

  it("skips existing cost periods when generating records", async () => {
    const existing = createCostRecord({ costPeriod: "2026-07" });
    const { prisma, service, user } = createHarness({ existingCostRecords: [existing] });

    const result = await service.generateCostRecords(
      "contract-1",
      { dryRun: false, fromPeriod: "2026-07", toPeriod: "2026-08" },
      user
    );

    expect(result.generatedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(prisma.vehicleBaasCostRecord.create).toHaveBeenCalledTimes(1);
    expect(prisma.vehicleBaasCostRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ costPeriod: "2026-08" })
      })
    );
  });

  it("updates cost record states through confirm, mark-paid, and void actions", async () => {
    const { prisma, service, user } = createHarness();

    const confirmed = await service.confirmCostRecord("cost-1", {}, user);
    expect(confirmed.costStatus).toBe(VehicleBaasCostRecordStatus.CONFIRMED);

    prisma.vehicleBaasCostRecord.findFirst.mockResolvedValueOnce(
      createCostRecord({ costStatus: VehicleBaasCostRecordStatus.CONFIRMED }) as never
    );
    const paid = await service.markCostRecordPaid("cost-1", { paymentRefNo: "PAY-1" }, user);
    expect(paid.costStatus).toBe(VehicleBaasCostRecordStatus.PAID);

    prisma.vehicleBaasCostRecord.findFirst.mockResolvedValueOnce(createCostRecord() as never);
    const voided = await service.voidCostRecord("cost-1", {}, user);
    expect(voided.costStatus).toBe(VehicleBaasCostRecordStatus.VOIDED);
  });

  it("does not generate future costs for terminated contracts", async () => {
    const { service, user } = createHarness({ contractStatus: VehicleBaasContractStatus.TERMINATED });

    await expect(
      service.generateCostRecords("contract-1", { dryRun: false, fromPeriod: "2026-07", toPeriod: "2026-07" }, user)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("does not modify vehicle state or create bills/payment orders", async () => {
    const { prisma, service, user } = createHarness();

    await service.generateCostRecords("contract-1", { dryRun: false, fromPeriod: "2026-07", toPeriod: "2026-07" }, user);

    expect(prisma.vehicle.update).not.toHaveBeenCalled();
    expect(prisma.receivableBill.create).not.toHaveBeenCalled();
    expect(prisma.paymentOrder.create).not.toHaveBeenCalled();
  });
});

function createHarness(options: {
  batteryUsageType?: VehicleBatteryUsageType;
  contractStatus?: VehicleBaasContractStatus;
  existingCostRecords?: Array<ReturnType<typeof createCostRecord>>;
  paymentDayOfMonth?: number;
} = {}) {
  const contract = createContract(options);
  const attachment = createAttachment();
  const costRecord = createCostRecord();
  const prisma = {
    paymentOrder: {
      create: vi.fn()
    },
    receivableBill: {
      create: vi.fn()
    },
    vehicle: {
      findFirst: vi.fn(async () => ({ deletedAt: null, id: "vehicle-1" })),
      update: vi.fn()
    },
    vehicleBaasContract: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...contract,
        ...data,
        attachments: [],
        costRecords: [],
        vehicle: vehicleBrief(options.batteryUsageType)
      })),
      findFirst: vi.fn(async () => contract),
      findMany: vi.fn(async () => [contract]),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...contract,
        ...data,
        attachments: [],
        costRecords: [],
        vehicle: vehicleBrief(options.batteryUsageType)
      }))
    },
    vehicleBaasContractAttachment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...attachment,
        ...data,
        contract: { contractNo: contract.contractNo, id: contract.id, vehicleId: contract.vehicleId }
      })),
      findFirst: vi.fn(async () => ({
        ...attachment,
        contract: { contractNo: contract.contractNo, id: contract.id, vehicleId: contract.vehicleId }
      })),
      findMany: vi.fn(async () => []),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...attachment,
        ...data,
        contract: { contractNo: contract.contractNo, id: contract.id, vehicleId: contract.vehicleId }
      }))
    },
    vehicleBaasCostRecord: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...costRecord,
        ...data,
        contract: { contractNo: contract.contractNo, id: contract.id, providerName: contract.providerName },
        vehicle: vehicleBrief(options.batteryUsageType)
      })),
      findFirst: vi.fn(async () => ({
        ...costRecord,
        contract: { contractNo: contract.contractNo, id: contract.id, providerName: contract.providerName },
        vehicle: vehicleBrief(options.batteryUsageType)
      })),
      findMany: vi.fn(async () => options.existingCostRecords ?? []),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...costRecord,
        ...data,
        contract: { contractNo: contract.contractNo, id: contract.id, providerName: contract.providerName },
        vehicle: vehicleBrief(options.batteryUsageType)
      }))
    }
  };
  const storageService = {
    getVehicleBaasContractAttachmentStream: vi.fn(),
    putVehicleBaasContractAttachment: vi.fn(async () => ({
      bucket: "private-bucket",
      objectKey: "vehicle-baas-contracts/contract-1/2026/baas.pdf",
      stored: {
        driver: "local" as const,
        key: "vehicle-baas-contracts/contract-1/2026/baas.pdf",
        size: 128
      }
    }))
  };
  const service = new VehicleBaasService(prisma as never, storageService as never);
  const user = {
    id: "user-1",
    menus: [],
    name: "Admin",
    permissions: [],
    roles: [],
    username: "admin"
  };

  return { prisma, service, storageService, user };
}

function createContract(options: {
  batteryUsageType?: VehicleBatteryUsageType;
  contractStatus?: VehicleBaasContractStatus;
  paymentDayOfMonth?: number;
} = {}) {
  const now = new Date("2026-06-22T08:00:00.000Z");
  return {
    activatedAt: null,
    archivedAt: null,
    attachments: [],
    batteryPackageName: "75kWh",
    batterySerialNo: null,
    billingCycle: VehicleBaasBillingCycle.MONTHLY,
    contractNo: "BAAS-001",
    contractStatus: options.contractStatus ?? VehicleBaasContractStatus.ACTIVE,
    costRecords: [],
    createdAt: now,
    createdBy: "user-1",
    currency: "CNY",
    deletedAt: null,
    effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
    effectiveTo: null,
    graceDays: 0,
    id: "contract-1",
    invoiceRequired: false,
    paymentDayOfMonth: options.paymentDayOfMonth ?? 15,
    providerContractNo: null,
    providerName: "NIO Power",
    remark: null,
    rentalAmount: 98000n,
    snapshot: null,
    suspendedAt: null,
    taxIncluded: true,
    terminatedAt: null,
    updatedAt: now,
    updatedBy: "user-1",
    vehicle: vehicleBrief(options.batteryUsageType),
    vehicleId: "vehicle-1"
  };
}

function createAttachment() {
  const now = new Date("2026-06-22T08:00:00.000Z");
  return {
    attachmentType: "CONTRACT",
    bucket: "private-bucket",
    contractId: "contract-1",
    createdAt: now,
    deletedAt: null,
    description: null,
    fileName: "baas.pdf",
    fileSize: 128,
    id: "attachment-1",
    mimeType: "application/pdf",
    objectKey: "vehicle-baas-contracts/contract-1/2026/baas.pdf",
    originalName: "baas.pdf",
    title: null,
    updatedAt: now,
    uploadedBy: "user-1"
  };
}

function createCostRecord(options: {
  costPeriod?: string;
  costStatus?: VehicleBaasCostRecordStatus;
} = {}) {
  const now = new Date("2026-06-22T08:00:00.000Z");
  return {
    confirmedAt: null,
    contractId: "contract-1",
    costAmount: 98000n,
    costPeriod: options.costPeriod ?? "2026-07",
    costRecordNo: "BCR001",
    costSource: VehicleBaasCostSource.GENERATED,
    costStatus: options.costStatus ?? VehicleBaasCostRecordStatus.SCHEDULED,
    createdAt: now,
    createdBy: "user-1",
    currency: "CNY",
    deletedAt: null,
    dueDate: new Date("2026-07-15T00:00:00.000Z"),
    id: "cost-1",
    invoiceNo: null,
    paidAt: null,
    paymentRefNo: null,
    periodEnd: new Date("2026-07-31T00:00:00.000Z"),
    periodStart: new Date("2026-07-01T00:00:00.000Z"),
    remark: null,
    snapshot: null,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleId: "vehicle-1",
    voidedAt: null
  };
}

function uploadFile(originalname: string, mimetype: string) {
  return {
    buffer: Buffer.from("file"),
    mimetype,
    originalname,
    size: 128
  };
}

function vehicleBrief(batteryUsageType: VehicleBatteryUsageType = VehicleBatteryUsageType.BAAS): {
  batteryUsageType: VehicleBatteryUsageType;
  brand: string;
  id: string;
  model: string;
  plateNo: string;
  series: string;
  vehicleNo: string;
} {
  return {
    batteryUsageType,
    brand: "NIO",
    id: "vehicle-1",
    model: "ES6",
    plateNo: "沪A12345",
    series: "ES6",
    vehicleNo: "VH001"
  };
}
