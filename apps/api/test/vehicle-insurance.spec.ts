import {
  VehicleDocumentType,
  VehicleDocumentStatus,
  VehicleInsuranceCoverageType,
  VehicleInsurancePolicyStatus,
  VehicleInsurancePolicyType,
  VehicleListingSourceSection
} from "@prisma/client";
import { BadRequestException, ConflictException, Logger } from "@nestjs/common";
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

  it("soft deletes an erroneous policy and active unbound documents with one audit", async () => {
    const { auditService, prisma, service, user } = createHarness();
    prisma.vehicleInsurancePolicy.findFirst.mockResolvedValueOnce({
      ...createPolicy(),
      claims: [],
      coverages: [],
      documents: [{ id: "document-1" }],
      vehicle: vehicleBrief()
    } as never);

    const result = await service.deletePolicy(
      "policy-1",
      { reason: "保单号记录录入错误" },
      user
    );

    expect(prisma.vehicleInsurancePolicy.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deletedAt: expect.any(Date),
          updatedBy: "user-1"
        }),
        where: { id: "policy-1" }
      })
    );
    expect(prisma.vehicleDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null, policyId: "policy-1" }
      })
    );
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DELETE",
        after: expect.objectContaining({ reason: "保单号记录录入错误" }),
        entityId: "policy-1"
      }),
      prisma
    );
    expect(result.id).toBe("policy-1");
  });

  it("rejects deleting a policy with any active claim", async () => {
    const { auditService, prisma, service, user } = createHarness();
    prisma.insuranceClaim.count.mockResolvedValueOnce(1);

    await expect(
      service.deletePolicy("policy-1", { reason: "重复录入" }, user)
    ).rejects.toMatchObject({ response: { code: "POLICY_HAS_CLAIMS" } });

    expect(prisma.vehicleInsurancePolicy.update).not.toHaveBeenCalled();
    expect(prisma.vehicleDocument.updateMany).not.toHaveBeenCalled();
    expect(auditService.write).not.toHaveBeenCalled();
  });

  it("rejects deleting a policy whose document is bound to product display", async () => {
    const { auditService, prisma, service, user } = createHarness();
    prisma.vehicleInsurancePolicy.findFirst.mockResolvedValueOnce({
      ...createPolicy(),
      claims: [],
      coverages: [],
      documents: [{ id: "document-1" }],
      vehicle: vehicleBrief()
    } as never);
    prisma.vehicleListingSourceBinding.findFirst.mockResolvedValueOnce({
      id: "binding-1"
    });

    await expect(
      service.deletePolicy("policy-1", { reason: "重复录入" }, user)
    ).rejects.toMatchObject({ response: { code: "POLICY_DOCUMENT_BOUND" } });

    expect(prisma.vehicleInsurancePolicy.update).not.toHaveBeenCalled();
    expect(prisma.vehicleDocument.updateMany).not.toHaveBeenCalled();
    expect(auditService.write).not.toHaveBeenCalled();
  });

  it.each([
    [
      VehicleInsurancePolicyType.COMPULSORY_TRAFFIC,
      VehicleDocumentType.COMPULSORY_INSURANCE_POLICY
    ],
    [
      VehicleInsurancePolicyType.COMMERCIAL,
      VehicleDocumentType.COMMERCIAL_INSURANCE_POLICY
    ],
    [VehicleInsurancePolicyType.OTHER, VehicleDocumentType.OTHER]
  ])("derives %s policy documents as %s", async (policyType, documentType) => {
    const { prisma, service, user } = createHarness({ policyType });

    await service.uploadPolicyDocuments(
      "policy-1",
      { description: "正式保单" },
      [uploadFile("保单.pdf", "application/pdf")],
      user
    );

    expect(prisma.vehicleDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customerVisible: true,
          description: "正式保单",
          documentType,
          effectiveFrom: expect.any(Date),
          effectiveTo: expect.any(Date),
          policyId: "policy-1",
          vehicleId: "vehicle-1"
        })
      })
    );
  });

  it("rejects more than twenty policy files before storage", async () => {
    const { service, storageService, user } = createHarness();
    const files = Array.from({ length: 21 }, (_, index) =>
      uploadFile(`policy-${index + 1}.pdf`, "application/pdf")
    );

    await expect(
      service.uploadPolicyDocuments("policy-1", {}, files, user)
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(storageService.putVehicleDocument).not.toHaveBeenCalled();
  });

  it("cleans up stored policy files when a later upload fails", async () => {
    const { prisma, service, storageService, user } = createHarness();
    storageService.putVehicleDocument
      .mockResolvedValueOnce(storedDocument("policy-1.pdf"))
      .mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(
      service.uploadPolicyDocuments(
        "policy-1",
        {},
        [
          uploadFile("policy-1.pdf", "application/pdf"),
          uploadFile("policy-2.pdf", "application/pdf")
        ],
        user
      )
    ).rejects.toThrow("storage unavailable");

    expect(storageService.deleteObject).toHaveBeenCalledWith(
      "private-bucket",
      "vehicle-documents/vehicle-1/2026/policy-1.pdf"
    );
    expect(prisma.vehicleDocument.create).not.toHaveBeenCalled();
  });

  it("rejects policy document upload when the policy was deleted", async () => {
    const { prisma, service, storageService, user } = createHarness();
    prisma.vehicleInsurancePolicy.findFirst.mockResolvedValueOnce(null as never);

    await expect(
      service.uploadPolicyDocuments(
        "policy-1",
        {},
        [uploadFile("policy.pdf", "application/pdf")],
        user
      )
    ).rejects.toMatchObject({ status: 404 });

    expect(storageService.putVehicleDocument).not.toHaveBeenCalled();
  });

  it("projects unique product listing bindings on document views", async () => {
    const { prisma, service } = createHarness();
    prisma.vehicleDocument.findMany.mockResolvedValueOnce([
      {
        ...createDocument(),
        listingSourceBindings: [
          { section: VehicleListingSourceSection.CONFIGURATION_SHEET },
          { section: VehicleListingSourceSection.CONFIGURATION_SHEET }
        ],
        policy: null,
        vehicle: vehicleBrief()
      }
    ] as never);

    const documents = await service.listDocuments("vehicle-1");

    expect(documents[0]?.boundListingSections).toEqual([
      VehicleListingSourceSection.CONFIGURATION_SHEET
    ]);
  });

  it("audits a successful document soft delete without deleting storage", async () => {
    const { auditService, prisma, service, storageService, user } =
      createHarness();

    await service.deleteDocument("document-1", user);

    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DELETE",
        entityId: "document-1",
        entityType: "vehicle_document"
      }),
      prisma
    );
    expect(storageService.deleteObject).not.toHaveBeenCalled();
  });

  it("uploads vehicle documents through private storage and hides object fields", async () => {
    const { service, storageService, user } = createHarness();

    const document = await service.uploadDocument(
      "vehicle-1",
      {
        customerVisible: true,
        documentType: VehicleDocumentType.COMMERCIAL_INSURANCE_POLICY,
        title: "商业险保单"
      },
      [uploadFile("commercial-policy.pdf", "application/pdf")],
      user
    );

    expect(storageService.putVehicleDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        originalName: "commercial-policy.pdf",
        vehicleId: "vehicle-1"
      })
    );
    expect(document).toMatchObject({
      customerVisible: true,
      documentType: VehicleDocumentType.COMMERCIAL_INSURANCE_POLICY,
      previewUrl: "/api/vehicle-documents/document-1/preview"
    });
    expect(document).not.toHaveProperty("bucket");
    expect(document).not.toHaveProperty("objectKey");
  });

  it("rejects customer-visible internal rights document uploads", async () => {
    const { service, storageService, user } = createHarness();

    await expect(
      service.uploadDocument(
        "vehicle-1",
        {
          customerVisible: true,
          documentType: VehicleDocumentType.VEHICLE_LICENSE
        },
        [uploadFile("license.pdf", "application/pdf")],
        user
      )
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(storageService.putVehicleDocument).not.toHaveBeenCalled();
  });

  it("rejects making an existing internal rights document customer-visible", async () => {
    const { prisma, service } = createHarness();

    await expect(service.updateDocument("document-1", { customerVisible: true })).rejects.toBeInstanceOf(
      BadRequestException
    );

    expect(prisma.vehicleDocument.update).not.toHaveBeenCalled();
  });

  it("stores multiple purchase payment receipts in one versioned batch", async () => {
    const { service, user } = createHarness();

    const batch = await service.uploadDocumentBatch(
      "vehicle-1",
      { documentType: VehicleDocumentType.PURCHASE_PAYMENT_VOUCHER },
      [uploadFile("receipt-1.pdf", "application/pdf"), uploadFile("receipt-2.jpg", "image/jpeg")],
      user
    );

    expect(batch).toMatchObject({
      documentType: VehicleDocumentType.PURCHASE_PAYMENT_VOUCHER,
      id: "batch-1",
      versionNo: 1
    });
    expect(batch.items).toHaveLength(2);
    expect(batch.items.map((item) => item.fileName)).toEqual(["receipt-1.pdf", "receipt-2.jpg"]);
    expect(batch.items.every((item) => item.customerVisible === false)).toBe(true);
    expect(batch.items.every((item) => !Object.hasOwn(item, "bucket") && !Object.hasOwn(item, "objectKey"))).toBe(
      true
    );
  });

  it.each([
    VehicleDocumentType.VEHICLE_PURCHASE_AGREEMENT,
    VehicleDocumentType.OWNER_IDENTITY_DOCUMENT,
    VehicleDocumentType.PURCHASE_PAYMENT_VOUCHER
  ])("accepts multiple files for %s", async (documentType) => {
    const { service, user } = createHarness();

    const batch = await service.uploadDocumentBatch(
      "vehicle-1",
      { documentType },
      [uploadFile("part-1.pdf", "application/pdf"), uploadFile("part-2.jpg", "image/jpeg")],
      user
    );

    expect(batch.items).toHaveLength(2);
  });

  it("rejects an empty vehicle document batch before storage", async () => {
    const { service, storageService, user } = createHarness();

    await expect(
      service.uploadDocumentBatch(
        "vehicle-1",
        { documentType: VehicleDocumentType.PURCHASE_PAYMENT_VOUCHER },
        [],
        user
      )
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(storageService.putVehicleDocument).not.toHaveBeenCalled();
  });

  it("rejects more than twenty files before storage", async () => {
    const { service, storageService, user } = createHarness();
    const files = Array.from({ length: 21 }, (_, index) =>
      uploadFile(`receipt-${index + 1}.pdf`, "application/pdf")
    );

    await expect(
      service.uploadDocumentBatch(
        "vehicle-1",
        { documentType: VehicleDocumentType.PURCHASE_PAYMENT_VOUCHER },
        files,
        user
      )
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(storageService.putVehicleDocument).not.toHaveBeenCalled();
  });

  it("rejects the whole batch before storage when any file is unsupported", async () => {
    const { service, storageService, user } = createHarness();

    await expect(
      service.uploadDocumentBatch(
        "vehicle-1",
        { documentType: VehicleDocumentType.VEHICLE_PURCHASE_AGREEMENT },
        [uploadFile("agreement.pdf", "application/pdf"), uploadFile("recording.mp4", "video/mp4")],
        user
      )
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(storageService.putVehicleDocument).not.toHaveBeenCalled();
  });

  it("cleans up already stored objects when a later file upload fails", async () => {
    const { service, storageService, user } = createHarness();
    storageService.putVehicleDocument
      .mockResolvedValueOnce(storedDocument("receipt-1.pdf"))
      .mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(
      service.uploadDocumentBatch(
        "vehicle-1",
        { documentType: VehicleDocumentType.PURCHASE_PAYMENT_VOUCHER },
        [uploadFile("receipt-1.pdf", "application/pdf"), uploadFile("receipt-2.pdf", "application/pdf")],
        user
      )
    ).rejects.toThrow("storage unavailable");

    expect(storageService.deleteObject).toHaveBeenCalledTimes(1);
    expect(storageService.deleteObject).toHaveBeenCalledWith(
      "private-bucket",
      "vehicle-documents/vehicle-1/2026/receipt-1.pdf"
    );
  });

  it("records cleanup failures without replacing the original upload error", async () => {
    const { service, storageService, user } = createHarness();
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    storageService.putVehicleDocument
      .mockResolvedValueOnce(storedDocument("receipt-1.pdf"))
      .mockRejectedValueOnce(new Error("storage unavailable"));
    storageService.deleteObject.mockRejectedValueOnce(new Error("cleanup unavailable"));

    await expect(
      service.uploadDocumentBatch(
        "vehicle-1",
        { documentType: VehicleDocumentType.PURCHASE_PAYMENT_VOUCHER },
        [uploadFile("receipt-1.pdf", "application/pdf"), uploadFile("receipt-2.pdf", "application/pdf")],
        user
      )
    ).rejects.toThrow("storage unavailable");

    expect(warn).toHaveBeenCalledWith("Failed to clean up 1 vehicle document object after batch upload failure");
    warn.mockRestore();
  });

  it("cleans up every newly stored object when the batch transaction fails", async () => {
    const { prisma, service, storageService, user } = createHarness();
    prisma.$transaction.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      service.uploadDocumentBatch(
        "vehicle-1",
        { documentType: VehicleDocumentType.OWNER_IDENTITY_DOCUMENT },
        [uploadFile("license.pdf", "application/pdf"), uploadFile("id-card.jpg", "image/jpeg")],
        user
      )
    ).rejects.toThrow("database unavailable");

    expect(storageService.deleteObject).toHaveBeenCalledTimes(2);
    expect(storageService.deleteObject).toHaveBeenCalledWith(
      "private-bucket",
      "vehicle-documents/vehicle-1/2026/license.pdf"
    );
    expect(storageService.deleteObject).toHaveBeenCalledWith(
      "private-bucket",
      "vehicle-documents/vehicle-1/2026/id-card.jpg"
    );
  });

  it("retries a concurrent batch version collision without re-uploading the file", async () => {
    const { prisma, service, storageService, user } = createHarness();
    prisma.vehicleDocumentBatch.aggregate.mockResolvedValue({ _max: { versionNo: 1 } });
    prisma.vehicleDocumentBatch.create.mockRejectedValueOnce({ code: "P2002" });

    const batch = await service.uploadDocumentBatch(
      "vehicle-1",
      { documentType: VehicleDocumentType.VEHICLE_CONFIGURATION_SHEET },
      [uploadFile("configuration.jpg", "image/jpeg")],
      user
    );

    expect(batch.versionNo).toBe(2);
    expect(storageService.putVehicleDocument).toHaveBeenCalledTimes(1);
    expect(storageService.deleteObject).not.toHaveBeenCalled();
  });

  it("allows three transaction attempts for repeated batch version collisions", async () => {
    const { prisma, service, storageService, user } = createHarness();
    prisma.vehicleDocumentBatch.aggregate.mockResolvedValue({ _max: { versionNo: 1 } });
    prisma.vehicleDocumentBatch.create
      .mockRejectedValueOnce({ code: "P2002" })
      .mockRejectedValueOnce({ code: "P2002" });

    const batch = await service.uploadDocumentBatch(
      "vehicle-1",
      { documentType: VehicleDocumentType.VEHICLE_CONFIGURATION_SHEET },
      [uploadFile("configuration.jpg", "image/jpeg")],
      user
    );

    expect(batch.versionNo).toBe(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(storageService.putVehicleDocument).toHaveBeenCalledTimes(1);
    expect(storageService.deleteObject).not.toHaveBeenCalled();
  });

  it("lists document batch versions without exposing storage object fields", async () => {
    const { prisma, service } = createHarness();
    prisma.vehicleDocumentBatch.findMany.mockResolvedValue([
      createDocumentBatch("batch-2", 2),
      createDocumentBatch("batch-1", 1)
    ]);

    const batches = await service.listDocumentBatches("vehicle-1");

    expect(batches.map((batch) => batch.versionNo)).toEqual([2, 1]);
    expect(batches[0]?.items[0]).not.toHaveProperty("bucket");
    expect(batches[0]?.items[0]).not.toHaveProperty("objectKey");
    expect(prisma.vehicleDocumentBatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ documentType: "asc" }, { versionNo: "desc" }],
        where: { vehicleId: "vehicle-1" }
      })
    );
  });

  it("archives every active item in a document batch without deleting stored originals", async () => {
    const { prisma, service, storageService } = createHarness();
    const batch = createDocumentBatch("batch-1", 1);
    prisma.vehicleDocumentBatch.findFirst.mockResolvedValue(batch);
    prisma.vehicleDocumentBatch.findUnique.mockResolvedValue({
      ...batch,
      documents: batch.documents.map((document) => ({
        ...document,
        customerVisible: false,
        documentStatus: "ARCHIVED"
      }))
    });

    const archived = await service.archiveDocumentBatch("batch-1");

    expect(archived.items.every((item) => item.documentStatus === "ARCHIVED")).toBe(true);
    expect(archived.items.every((item) => item.customerVisible === false)).toBe(true);
    expect(prisma.vehicleDocument.updateMany).toHaveBeenCalledWith({
      data: {
        customerVisible: false,
        documentStatus: "ARCHIVED"
      },
      where: {
        batchId: "batch-1",
        deletedAt: null
      }
    });
    expect(storageService.deleteObject).not.toHaveBeenCalled();
  });

  it("rejects deleting a document that is bound to a product listing section", async () => {
    const { auditService, prisma, service, user } = createHarness();
    prisma.vehicleListingSourceBinding.findFirst.mockResolvedValueOnce({ id: "binding-1" });

    await expect(service.deleteDocument("document-1", user)).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(prisma.vehicleDocument.update).not.toHaveBeenCalled();
    expect(auditService.write).not.toHaveBeenCalled();
  });

  it.each([
    { documentStatus: VehicleDocumentStatus.ARCHIVED },
    { documentType: VehicleDocumentType.MOTOR_VEHICLE_INVOICE }
  ])("rejects an incompatible update to a bound source document", async (dto) => {
    const { prisma, service } = createHarness();
    prisma.vehicleListingSourceBinding.findFirst.mockResolvedValueOnce({ id: "binding-1" });

    await expect(service.updateDocument("document-1", dto)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.vehicleDocument.update).not.toHaveBeenCalled();
  });

  it("rejects archiving a batch that contains a product listing source document", async () => {
    const { prisma, service } = createHarness();
    prisma.vehicleDocumentBatch.findFirst.mockResolvedValueOnce(createDocumentBatch("batch-1", 1));
    prisma.vehicleListingSourceBinding.findFirst.mockResolvedValueOnce({ id: "binding-1" });

    await expect(service.archiveDocumentBatch("batch-1")).rejects.toMatchObject({
      response: {
        code: "VEHICLE_DOCUMENT_SOURCE_BOUND"
      }
    });

    expect(prisma.vehicleDocument.updateMany).not.toHaveBeenCalled();
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

function createHarness({
  policyType = VehicleInsurancePolicyType.COMPULSORY_TRAFFIC
}: { policyType?: VehicleInsurancePolicyType } = {}) {
  const policy = createPolicy(policyType);
  const document = createDocument();
  const prisma = {
    $transaction: vi.fn(),
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
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...document,
        ...data,
        policy: null,
        vehicle: vehicleBrief()
      }))
    },
    vehicleDocumentBatch: {
      aggregate: vi.fn(async (): Promise<{ _max: { versionNo: number | null } }> => ({
        _max: { versionNo: null }
      })),
      create: vi.fn(async ({
        data
      }: {
        data: Record<string, unknown> & {
          documents?: { create?: Record<string, unknown>[] };
        };
      }) => ({
        createdAt: new Date("2026-06-22T08:00:00.000Z"),
        documentType: data.documentType,
        documents: (data.documents?.create ?? []).map((item: Record<string, unknown>, index: number) => ({
          ...document,
          ...item,
          id: `document-${index + 1}`,
          policy: null,
          vehicle: vehicleBrief()
        })),
        id: "batch-1",
        uploadedBy: data.uploadedBy,
        vehicleId: data.vehicleId,
        versionNo: data.versionNo
      })),
      findFirst: vi.fn(async (): Promise<ReturnType<typeof createDocumentBatch> | null> => null),
      findMany: vi.fn(async (): Promise<ReturnType<typeof createDocumentBatch>[]> => []),
      findUnique: vi.fn(async (): Promise<ReturnType<typeof createDocumentBatch> | null> => null)
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
    },
    vehicleListingSourceBinding: {
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => null)
    }
  };
  prisma.$transaction.mockImplementation(async (callback: (transaction: typeof prisma) => unknown) =>
    callback(prisma)
  );
  const storageService = {
    deleteObject: vi.fn(),
    getVehicleDocumentStream: vi.fn(),
    putVehicleDocument: vi.fn(async (input: { originalName?: string }) => ({
      bucket: "private-bucket",
      objectKey: `vehicle-documents/vehicle-1/2026/${input.originalName ?? "file"}`,
      stored: {
        driver: "local" as const,
        key: `vehicle-documents/vehicle-1/2026/${input.originalName ?? "file"}`,
        size: 128
      }
    }))
  };
  const auditService = {
    write: vi.fn()
  };
  const service = new VehicleInsuranceService(
    prisma as never,
    storageService as never,
    auditService as never
  );
  const user = {
    id: "user-1",
    menus: [],
    name: "Admin",
    permissions: [],
    roles: [],
    username: "admin"
  };

  return { auditService, prisma, service, storageService, user };
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

function storedDocument(originalName: string) {
  const objectKey = `vehicle-documents/vehicle-1/2026/${originalName}`;
  return {
    bucket: "private-bucket",
    objectKey,
    stored: {
      driver: "local" as const,
      key: objectKey,
      size: 128
    }
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

function createPolicy(
  policyType: VehicleInsurancePolicyType =
    VehicleInsurancePolicyType.COMPULSORY_TRAFFIC
) {
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
    policyType,
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
    listingSourceBindings: [],
    policy: null,
    policyId: null,
    title: "行驶证",
    updatedAt: now,
    uploadedBy: "user-1",
    vehicle: vehicleBrief(),
    vehicleId: "vehicle-1"
  };
}

function createDocumentBatch(id: string, versionNo: number) {
  return {
    createdAt: new Date("2026-06-22T08:00:00.000Z"),
    documentType: VehicleDocumentType.VEHICLE_CONFIGURATION_SHEET,
    documents: [
      {
        ...createDocument(),
        batchId: id,
        customerVisible: false,
        documentType: VehicleDocumentType.VEHICLE_CONFIGURATION_SHEET,
        policy: null,
        vehicle: vehicleBrief()
      }
    ],
    id,
    uploadedBy: "user-1",
    vehicleId: "vehicle-1",
    versionNo
  };
}
