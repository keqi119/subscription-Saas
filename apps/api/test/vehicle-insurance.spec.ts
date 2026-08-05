import {
  VehicleDocumentType,
  VehicleInsuranceCoverageType,
  VehicleInsurancePolicyStatus,
  VehicleInsurancePolicyType
} from "@prisma/client";
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { VehicleInsuranceService } from "../src/vehicle-insurance/vehicle-insurance.service";

describe("VehicleInsuranceService policy and document management", () => {
  it("accepts a target end date only when compulsory and commercial policies both cover it", async () => {
    const { prisma, service } = createHarness();
    prisma.vehicleInsurancePolicy.findMany.mockResolvedValueOnce([
      coveragePolicy(VehicleInsurancePolicyType.COMPULSORY_TRAFFIC),
      coveragePolicy(VehicleInsurancePolicyType.COMMERCIAL)
    ] as never);

    await expect(
      service.assertVehicleCoveredThrough("vehicle-1", new Date("2027-03-02T00:00:00.000Z"))
    ).resolves.toMatchObject({ covered: true });
  });

  it("rejects an extension end date when either required policy is missing", async () => {
    const { prisma, service } = createHarness();
    prisma.vehicleInsurancePolicy.findMany.mockResolvedValueOnce([
      coveragePolicy(VehicleInsurancePolicyType.COMPULSORY_TRAFFIC)
    ] as never);

    await expect(
      service.assertVehicleCoveredThrough("vehicle-1", new Date("2027-03-02T00:00:00.000Z"))
    ).rejects.toMatchObject({ code: "VEHICLE_INSURANCE_COVERAGE_INSUFFICIENT" });
  });

  it("creates compulsory and commercial policies with independent periods", async () => {
    const { prisma, service, user } = createHarness();

    const compulsory = await service.createPolicy(
      "vehicle-1",
      {
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-12-31",
        insurerName: "Compulsory Insurer",
        policyNo: "JQ-001",
        policyType: VehicleInsurancePolicyType.COMPULSORY_TRAFFIC
      },
      user
    );
    const commercial = await service.createPolicy(
      "vehicle-1",
      {
        coverages: [
          {
            coverageType: VehicleInsuranceCoverageType.VEHICLE_DAMAGE,
            insuredAmount: 20000000
          }
        ],
        effectiveFrom: "2026-03-01",
        effectiveTo: "2027-02-28",
        insurerName: "Commercial Insurer",
        policyNo: "SY-001",
        policyType: VehicleInsurancePolicyType.COMMERCIAL
      },
      user
    );

    expect(compulsory).toMatchObject({
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-12-31",
      policyNo: "JQ-001",
      policyType: VehicleInsurancePolicyType.COMPULSORY_TRAFFIC
    });
    expect(commercial).toMatchObject({
      effectiveFrom: "2026-03-01",
      effectiveTo: "2027-02-28",
      policyNo: "SY-001",
      policyType: VehicleInsurancePolicyType.COMMERCIAL
    });
    expect(prisma.vehicleInsurancePolicy.create).toHaveBeenCalledTimes(2);
  });

  it("filters policies expiring within a configured day window", async () => {
    const { prisma, service } = createHarness();

    await service.listPolicies({ expiringWithinDays: 30, vehicleId: "vehicle-1" });

    expect(prisma.vehicleInsurancePolicy.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          effectiveTo: expect.objectContaining({
            gte: expect.any(Date),
            lte: expect.any(Date)
          }),
          vehicleId: "vehicle-1"
        })
      })
    );
  });

  it("includes vehicle VIN and plate number in listed policy summaries", async () => {
    const { service } = createHarness();

    const result = await service.listPolicies({});

    expect(result.items[0]?.vehicle).toMatchObject({
      plateNo: "沪A12345",
      vehicleNo: "VH001",
      vin: "SYNTHETICVIN000001"
    });
  });

  it("uploads vehicle documents through private storage and hides object fields", async () => {
    const { service, storageService, user } = createHarness();

    const document = await service.uploadDocument(
      "vehicle-1",
      {
        customerVisible: true,
        documentType: VehicleDocumentType.VEHICLE_LICENSE,
        title: "行驶证"
      },
      [uploadFile("license.pdf", "application/pdf")],
      user
    );

    expect(storageService.putVehicleDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        originalName: "license.pdf",
        vehicleId: "vehicle-1"
      })
    );
    expect(document).toMatchObject({
      customerVisible: true,
      documentType: VehicleDocumentType.VEHICLE_LICENSE,
      previewUrl: "/api/vehicle-documents/document-1/preview"
    });
    expect(document).not.toHaveProperty("bucket");
    expect(document).not.toHaveProperty("objectKey");
  });

  it("rejects video vehicle document uploads", async () => {
    const { service, storageService, user } = createHarness();

    await expect(
      service.uploadDocument(
        "vehicle-1",
        { documentType: VehicleDocumentType.OTHER },
        [uploadFile("policy.mp4", "video/mp4")],
        user
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storageService.putVehicleDocument).not.toHaveBeenCalled();
  });
});

function createHarness() {
  const policy = createPolicy();
  const document = createDocument();
  const prisma = {
    insuranceClaim: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => [])
    },
    subscriptionOrder: {
      findFirst: vi.fn()
    },
    vehicle: {
      findFirst: vi.fn(async () => ({ deletedAt: null, id: "vehicle-1" }))
    },
    vehicleDocument: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...document,
        ...data,
        policy: null,
        vehicle: vehicleBrief()
      })),
      findFirst: vi.fn(async () => ({ ...document, policy: null, vehicle: vehicleBrief() })),
      findMany: vi.fn(async () => [{ ...document, policy: null, vehicle: vehicleBrief() }]),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...document,
        ...data,
        policy: null,
        vehicle: vehicleBrief()
      }))
    },
    vehicleInsuranceCoverage: {
      createMany: vi.fn(async () => ({ count: 1 })),
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    vehicleInsurancePolicy: {
      count: vi.fn(async () => 1),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...policy,
        ...data,
        claims: [],
        coverages: data.coverages ? [createCoverage()] : [],
        documents: [],
        vehicle: vehicleBrief()
      })),
      findFirst: vi.fn(async () => ({ ...policy, claims: [], coverages: [], documents: [], vehicle: vehicleBrief() })),
      findMany: vi.fn(async () => [{ ...policy, claims: [], coverages: [], documents: [], vehicle: vehicleBrief() }]),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...policy,
        ...data,
        claims: [],
        coverages: [],
        documents: [],
        vehicle: vehicleBrief()
      }))
    }
  };
  const storageService = {
    getVehicleDocumentStream: vi.fn(),
    putVehicleDocument: vi.fn(async () => ({
      bucket: "private-bucket",
      objectKey: "vehicle-documents/vehicle-1/2026/license.pdf",
      stored: {
        driver: "local" as const,
        key: "vehicle-documents/vehicle-1/2026/license.pdf",
        size: 128
      }
    }))
  };
  const service = new VehicleInsuranceService(prisma as never, storageService as never);
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

function coveragePolicy(policyType: VehicleInsurancePolicyType) {
  return {
    deletedAt: null,
    effectiveFrom: new Date("2026-03-03T00:00:00.000Z"),
    effectiveTo: new Date("2027-03-02T00:00:00.000Z"),
    id: `policy-${policyType}`,
    policyStatus: VehicleInsurancePolicyStatus.ACTIVE,
    policyType
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

function vehicleBrief() {
  return {
    brand: "NIO",
    id: "vehicle-1",
    model: "ES6",
    plateNo: "沪A12345",
    series: "ES6",
    vehicleNo: "VH001",
    vin: "SYNTHETICVIN000001"
  };
}

function createPolicy() {
  const now = new Date("2026-06-22T08:00:00.000Z");
  return {
    claims: [],
    coverages: [],
    createdAt: now,
    createdBy: "user-1",
    currency: "CNY",
    deletedAt: null,
    documents: [],
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: new Date("2026-12-31T00:00:00.000Z"),
    id: "policy-1",
    insuredAmount: 20000000n,
    insuredName: null,
    insurerName: "Insurer",
    policyHolderName: null,
    policyNo: "POLICY-001",
    policyStatus: VehicleInsurancePolicyStatus.ACTIVE,
    policyType: VehicleInsurancePolicyType.COMPULSORY_TRAFFIC,
    premiumAmount: 300000n,
    remark: null,
    renewalReminderAt: null,
    snapshot: null,
    updatedAt: now,
    updatedBy: "user-1",
    vehicle: vehicleBrief(),
    vehicleId: "vehicle-1"
  };
}

function createCoverage() {
  const now = new Date("2026-06-22T08:00:00.000Z");
  return {
    coverageName: null,
    coverageType: VehicleInsuranceCoverageType.VEHICLE_DAMAGE,
    createdAt: now,
    deductibleAmount: null,
    deletedAt: null,
    id: "coverage-1",
    insuredAmount: 20000000n,
    policyId: "policy-1",
    remark: null,
    updatedAt: now
  };
}

function createDocument() {
  const now = new Date("2026-06-22T08:00:00.000Z");
  return {
    bucket: "private-bucket",
    createdAt: now,
    customerVisible: true,
    deletedAt: null,
    description: null,
    documentStatus: "ACTIVE",
    documentType: VehicleDocumentType.VEHICLE_LICENSE,
    effectiveFrom: null,
    effectiveTo: null,
    fileName: "license.pdf",
    fileSize: 128,
    id: "document-1",
    mimeType: "application/pdf",
    objectKey: "vehicle-documents/vehicle-1/2026/license.pdf",
    originalName: "license.pdf",
    policy: null,
    policyId: null,
    title: "行驶证",
    updatedAt: now,
    uploadedBy: "user-1",
    vehicle: vehicleBrief(),
    vehicleId: "vehicle-1"
  };
}
