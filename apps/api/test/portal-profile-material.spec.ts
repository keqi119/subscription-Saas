import {
  CustomerAccountStatus,
  CustomerProfileMaterialStatus,
  CustomerProfileMaterialType
} from "@prisma/client";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { PortalProfileMaterialService } from "../src/portal/portal-profile-material.service";

describe("PortalProfileMaterialService", () => {
  it("uploads a customer profile material without exposing storage object fields", async () => {
    const { service, storageService, tx } = createFixture();

    const result = await service.uploadMaterial(
      { materialType: CustomerProfileMaterialType.ID_CARD_FRONT },
      [uploadFile("id-front.png", "image/png")],
      currentCustomer("customer-1")
    );

    expect(storageService.putCustomerProfileMaterial).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "customer-1",
        originalName: "id-front.png"
      })
    );
    expect(tx.customerProfileMaterial.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { materialStatus: CustomerProfileMaterialStatus.REPLACED },
        where: expect.objectContaining({
          customerId: "customer-1",
          materialStatus: CustomerProfileMaterialStatus.ACTIVE,
          materialType: CustomerProfileMaterialType.ID_CARD_FRONT
        })
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        fileName: "id-front.png",
        materialStatus: CustomerProfileMaterialStatus.ACTIVE,
        materialType: CustomerProfileMaterialType.ID_CARD_FRONT,
        previewUrl: "/api/portal/profile/materials/profile-material-new/preview"
      })
    );
    expect(result).not.toHaveProperty("bucket");
    expect(result).not.toHaveProperty("objectKey");
  });

  it("rejects video uploads", async () => {
    const { service, storageService } = createFixture();

    await expect(
      service.uploadMaterial(
        { materialType: CustomerProfileMaterialType.DRIVER_LICENSE_FRONT },
        [uploadFile("license.mp4", "video/mp4")],
        currentCustomer("customer-1")
      )
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(storageService.putCustomerProfileMaterial).not.toHaveBeenCalled();
  });

  it("calculates required material completeness", async () => {
    const { service } = createFixture({
      materials: [
        createProfileMaterial({ materialType: CustomerProfileMaterialType.ID_CARD_FRONT }),
        createProfileMaterial({ id: "profile-material-2", materialType: CustomerProfileMaterialType.ID_CARD_BACK })
      ]
    });

    const result = await service.getCompleteness(currentCustomer("customer-1"));

    expect(result).toMatchObject({
      canSubmit: true,
      complete: false,
      completedCount: 2,
      requiredCount: 4,
      stronglyRecommendedUploadBeforeSubmit: true
    });
    expect(result.missingMaterials.map((item) => item.type)).toEqual([
      CustomerProfileMaterialType.DRIVER_LICENSE_FRONT,
      CustomerProfileMaterialType.DRIVER_LICENSE_BACK
    ]);
  });

  it("streams previews only for the owning customer", async () => {
    const { service, storageService } = createFixture({
      materials: [createProfileMaterial()]
    });

    const preview = await service.previewMaterial("profile-material-1", currentCustomer("customer-1"));

    expect(preview.filename).toBe("id-front.png");
    expect(storageService.getCustomerProfileMaterialStream).toHaveBeenCalledWith(
      "application-materials",
      "customer-profile-materials/customer-1/2026/id-front.png"
    );

    await expect(
      service.previewMaterial("profile-material-1", currentCustomer("customer-other"))
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("soft deletes customer profile materials", async () => {
    const material = createProfileMaterial();
    const { prisma, service } = createFixture({ materials: [material] });

    const result = await service.deleteMaterial("profile-material-1", currentCustomer("customer-1"));

    expect(prisma.customerProfileMaterial.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          materialStatus: CustomerProfileMaterialStatus.ARCHIVED
        }),
        where: { id: "profile-material-1" }
      })
    );
    expect(result.materialStatus).toBe(CustomerProfileMaterialStatus.ARCHIVED);
  });
});

function createFixture(overrides: { materials?: ReturnType<typeof createProfileMaterial>[] } = {}) {
  const materials = overrides.materials ?? [];
  const storageService = {
    getCustomerProfileMaterialStream: vi.fn(async () => ({
      contentLength: 128,
      contentType: "image/png",
      stream: Readable.from(["image"])
    })),
    putCustomerProfileMaterial: vi.fn(async () => ({
      bucket: "application-materials",
      objectKey: "customer-profile-materials/customer-1/2026/id-front.png",
      stored: {
        driver: "local",
        key: "customer-profile-materials/customer-1/2026/id-front.png",
        size: 128
      }
    }))
  };
  const tx = {
    customerProfileMaterial: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
        createProfileMaterial({
          ...data,
          id: "profile-material-new"
        })
      ),
      updateMany: vi.fn(async () => ({ count: 1 }))
    }
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    customerProfileMaterial: {
      findFirst: vi.fn(async ({ where }: { where: { customerId?: string; id?: string } }) => {
        const material = materials.find((item) => item.id === where.id && item.customerId === where.customerId);
        return material?.deletedAt ? null : material ?? null;
      }),
      findMany: vi.fn(async () => materials.filter((material) => !material.deletedAt)),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const material = materials.find((item) => item.id === where.id) ?? createProfileMaterial({ id: where.id });
        return {
          ...material,
          ...data
        };
      })
    }
  };
  const service = new PortalProfileMaterialService(prisma as never, storageService as never);
  return { prisma, service, storageService, tx };
}

function createProfileMaterial(overrides: Record<string, unknown> = {}) {
  return {
    bucket: "application-materials",
    createdAt: new Date("2026-06-22T08:00:00.000Z"),
    customerId: "customer-1",
    deletedAt: null,
    fileName: "id-front.png",
    fileSize: 128,
    id: "profile-material-1",
    materialStatus: CustomerProfileMaterialStatus.ACTIVE,
    materialType: CustomerProfileMaterialType.ID_CARD_FRONT,
    mimeType: "image/png",
    objectKey: "customer-profile-materials/customer-1/2026/id-front.png",
    originalName: "id-front.png",
    remark: null,
    snapshot: null,
    updatedAt: new Date("2026-06-22T08:00:00.000Z"),
    ...overrides
  };
}

function uploadFile(originalname: string, mimetype: string) {
  return {
    buffer: Buffer.from("image"),
    mimetype,
    originalname,
    size: 128
  };
}

function currentCustomer(customerId: string) {
  return {
    accountStatus: CustomerAccountStatus.ACTIVE,
    customerAccountId: "account-1",
    customerId,
    phone: "13800000000"
  };
}
