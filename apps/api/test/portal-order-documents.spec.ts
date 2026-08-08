import { VehicleDocumentStatus, VehicleDocumentType } from "@prisma/client";
import { NotFoundException } from "@nestjs/common";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { VehicleInsuranceService } from "../src/vehicle-insurance/vehicle-insurance.service";

describe("Portal order vehicle documents", () => {
  it("returns only customer-visible active documents for the current customer's order", async () => {
    const { prisma, service } = createHarness();

    const documents = await service.buildPortalOrderDocuments("order-1", "customer-1");

    expect(prisma.subscriptionOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerId: "customer-1",
          id: "order-1"
        })
      })
    );
    expect(prisma.vehicleDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerVisible: true,
          documentStatus: VehicleDocumentStatus.ACTIVE,
          vehicleId: "vehicle-1"
        })
      })
    );
    expect(documents[0]).toMatchObject({
      documentType: VehicleDocumentType.VEHICLE_LICENSE,
      previewUrl: "/api/portal/orders/order-1/documents/document-1/preview"
    });
    expect(documents[0]).not.toHaveProperty("bucket");
    expect(documents[0]).not.toHaveProperty("objectKey");
  });

  it("does not preview documents through another customer's order", async () => {
    const { prisma, service, storageService } = createHarness();
    prisma.subscriptionOrder.findFirst.mockResolvedValueOnce(null as never);

    await expect(
      service.previewPortalOrderDocument("order-1", "document-1", "customer-other")
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storageService.getVehicleDocumentStream).not.toHaveBeenCalled();
  });

  it("previews only customer-visible active documents through API stream", async () => {
    const { prisma, service, storageService } = createHarness();

    const preview = await service.previewPortalOrderDocument("order-1", "document-1", "customer-1");

    expect(prisma.vehicleDocument.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerVisible: true,
          documentStatus: VehicleDocumentStatus.ACTIVE,
          id: "document-1",
          vehicleId: "vehicle-1"
        })
      })
    );
    expect(preview.filename).toBe("license.pdf");
    expect(storageService.getVehicleDocumentStream).toHaveBeenCalledWith(
      "private-bucket",
      "vehicle-documents/vehicle-1/2026/license.pdf"
    );
  });
});

function createHarness() {
  const document = createDocument();
  const prisma = {
    insuranceClaim: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => [])
    },
    subscriptionOrder: {
      findFirst: vi.fn(async () => ({
        id: "order-1",
        vehicleId: "vehicle-1"
      }))
    },
    vehicle: {
      findFirst: vi.fn()
    },
    vehicleDocument: {
      findFirst: vi.fn(async () => document),
      findMany: vi.fn(async () => [{ ...document, policy: null, vehicle: vehicleBrief() }])
    },
    vehicleInsurancePolicy: {
      findFirst: vi.fn()
    }
  };
  const storageService = {
    getVehicleDocumentStream: vi.fn(async () => ({
      contentLength: 128,
      contentType: "application/pdf",
      stream: Readable.from(["pdf"])
    })),
    putVehicleDocument: vi.fn()
  };
  const auditService = { write: vi.fn() };
  const service = new VehicleInsuranceService(
    prisma as never,
    storageService as never,
    auditService as never
  );
  return { auditService, prisma, service, storageService };
}

function vehicleBrief() {
  return {
    brand: "NIO",
    id: "vehicle-1",
    model: "ES6",
    plateNo: "沪A12345",
    series: "ES6",
    vehicleNo: "VH001"
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
    documentStatus: VehicleDocumentStatus.ACTIVE,
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
