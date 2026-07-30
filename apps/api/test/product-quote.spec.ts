import { Logger } from "@nestjs/common";
import { Prisma, ProductStatus, ProductType, ProductVersionStatus, RecordStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  assertMonthlyFeeWithinCap,
  ensureNoRentToOwnQuoteFields,
  ensureSubscriptionProductType,
  ensurePeriodInRange,
  ensureValidPeriod,
  ProductService
} from "../src/product/product.service";

describe("product and quote rules", () => {
  it("validates product price rule period ranges", () => {
    expect(() => ensureValidPeriod(12, 36)).not.toThrow();
    expect(() => ensureValidPeriod(36, 12)).toThrow();
  });

  it("validates quote period against the matched price rule", () => {
    const rule = { maxPeriodMonths: 36, minPeriodMonths: 12 };

    expect(() => ensurePeriodInRange(12, rule)).not.toThrow();
    expect(() => ensurePeriodInRange(24, rule)).not.toThrow();
    expect(() => ensurePeriodInRange(6, rule)).toThrow();
    expect(() => ensurePeriodInRange(48, rule)).toThrow();
  });

  it("rejects monthly fees above the configured purchase-price cap", () => {
    const vehiclePurchasePriceAmount = 16000000;
    const monthlyFeeRate = new Prisma.Decimal("0.035");

    expect(() =>
      assertMonthlyFeeWithinCap(560000, vehiclePurchasePriceAmount, monthlyFeeRate)
    ).not.toThrow();
    expect(() =>
      assertMonthlyFeeWithinCap(600000, vehiclePurchasePriceAmount, monthlyFeeRate)
    ).toThrow();
  });

  it("defaults product type to subscription and rejects rent-to-own during the current phase", () => {
    expect(ensureSubscriptionProductType()).toBe(ProductType.SUBSCRIPTION);
    expect(ensureSubscriptionProductType(ProductType.SUBSCRIPTION)).toBe(ProductType.SUBSCRIPTION);
    expect(() => ensureSubscriptionProductType(ProductType.RENT_TO_OWN)).toThrow("当前阶段暂未开放以租代购产品线");
  });

  it("rejects rent-to-own quote fields during the current phase", () => {
    expect(() =>
      ensureNoRentToOwnQuoteFields({
        downPaymentAmount: 100000,
        modelDefinitionId: "00000000-0000-0000-0000-000000000001",
        monthlyFeeAmount: 560000,
        periodMonths: 12,
        productVersionId: "00000000-0000-0000-0000-000000000001",
        vehiclePurchasePriceAmount: 16000000
      })
    ).toThrow("当前阶段暂未开放以租代购报价字段");
  });

  it("creates products as subscription products when productType is omitted", async () => {
    const now = new Date("2026-05-30T00:00:00.000Z");
    const create = vi.fn().mockImplementation(({ data }) =>
      Promise.resolve({
        ...data,
        createdAt: now,
        deletedAt: null,
        id: "product-1",
        productNo: data.productNo,
        updatedAt: now,
        versions: []
      })
    );
    const service = new ProductService(
      { write: vi.fn().mockResolvedValue(undefined) } as never,
      {
        product: {
          count: vi.fn().mockResolvedValue(0),
          create
        }
      } as never
    );

    const product = await service.createProduct(
      { name: "上海二手纯电订阅标准产品" },
      { id: "user-1", menus: [], name: "运营", permissions: [], roles: ["OP"], username: "op" },
      {}
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ productType: ProductType.SUBSCRIPTION })
      })
    );
    expect(product).toMatchObject({ productType: ProductType.SUBSCRIPTION });
  });

  it("lists products without versions as an empty version list", async () => {
    const now = new Date("2026-05-30T00:00:00.000Z");
    const findMany = vi.fn().mockResolvedValue([
      {
        createdAt: now,
        createdBy: "user-1",
        deletedAt: null,
        description: null,
        id: "product-1",
        name: "Standard subscription",
        productNo: "PRD2026053000001",
        productType: "SUBSCRIPTION",
        status: ProductStatus.DRAFT,
        updatedAt: now,
        updatedBy: "user-1",
        versions: []
      }
    ]);
    const service = new ProductService({} as never, {
      product: {
        findMany
      }
    } as never);

    const products = await service.listProducts();

    expect(products[0]).toMatchObject({
      activeVersion: null,
      id: "product-1",
      versions: []
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ productType: ProductType.SUBSCRIPTION })
      })
    );
  });

  it("treats a missing product versions relation as an empty version list", async () => {
    const now = new Date("2026-05-30T00:00:00.000Z");
    const findMany = vi.fn().mockResolvedValue([
      {
        createdAt: now,
        createdBy: "user-1",
        deletedAt: null,
        description: null,
        id: "product-1",
        name: "Standard subscription",
        productNo: "PRD2026053000001",
        productType: "SUBSCRIPTION",
        status: ProductStatus.DRAFT,
        updatedAt: now,
        updatedBy: "user-1"
      }
    ]);
    const service = new ProductService({} as never, {
      product: {
        findMany
      }
    } as never);

    const products = await service.listProducts();

    expect(products[0]).toMatchObject({
      activeVersion: null,
      id: "product-1",
      versions: []
    });
  });

  it("skips malformed historical versions and downgrades missing relations", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const now = new Date("2026-05-30T00:00:00.000Z");
    const service = new ProductService({} as never, {
      product: {
        findMany: vi.fn().mockResolvedValue([
          {
            createdAt: now,
            createdBy: "user-1",
            deletedAt: null,
            description: null,
            id: "product-1",
            name: "Standard subscription",
            productNo: "PRD2026053000001",
            productType: "SUBSCRIPTION",
            status: ProductStatus.ACTIVE,
            updatedAt: now,
            updatedBy: "user-1",
            versions: [
              null,
              undefined,
              { status: ProductVersionStatus.ACTIVE },
              {
                approvedAt: null,
                approver: null,
                effectiveFrom: now,
                effectiveTo: null,
                id: "version-legacy",
                priceRules: [
                  {
                    baseMileageKm: 1500,
                    energyLimitCount: null,
                    energyLimitKwh: null,
                    id: "rule-legacy",
                    maxPeriodMonths: 36,
                    minPeriodMonths: 12,
                    productVersionId: "version-legacy",
                    status: RecordStatus.ACTIVE,
                    vehicleModel: "ET5"
                  }
                ],
                productId: "product-1",
                status: ProductVersionStatus.ACTIVE,
                versionNo: "V-legacy"
              }
            ]
          }
        ])
      }
    } as never);

    try {
      const products = await service.listProducts();
      const version = products[0]?.versions[0];

      expect(products[0]?.versions).toHaveLength(1);
      expect(products[0]?.activeVersion).toMatchObject({ id: "version-legacy", productId: "product-1" });
      expect(version).toMatchObject({
        benefitPackages: [],
        energyPackages: [],
        mileagePackages: [],
        product: null,
        productId: "product-1",
        vehiclePackages: []
      });
      expect(version?.priceRules).toEqual([
        expect.objectContaining({
          id: "rule-legacy",
          monthlyFeeRate: 0,
          overMileageFeeAmount: 0
        })
      ]);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("lists products with active versions from product-list includes", async () => {
    const now = new Date("2026-05-30T00:00:00.000Z");
    const service = new ProductService({} as never, {
      product: {
        findMany: vi.fn().mockResolvedValue([
          {
            createdAt: now,
            createdBy: "user-1",
            deletedAt: null,
            description: null,
            id: "product-1",
            name: "Standard subscription",
            productNo: "PRD2026053000001",
            productType: "SUBSCRIPTION",
            status: ProductStatus.ACTIVE,
            updatedAt: now,
            updatedBy: "user-1",
            versions: [
              {
                approvedAt: now,
                approvedBy: "user-1",
                approver: { id: "user-1", name: "Admin", username: "admin" },
                createdAt: now,
                createdBy: "user-1",
                deletedAt: null,
                effectiveFrom: now,
                effectiveTo: null,
                id: "version-1",
                priceRules: [
                  {
                    baseMileageKm: 1500,
                    createdAt: now,
                    createdBy: "user-1",
                    deletedAt: null,
                    energyLimitCount: 10,
                    energyLimitKwh: 300,
                    id: "rule-1",
                    maxPeriodMonths: 36,
                    minPeriodMonths: 12,
                    monthlyFeeRate: new Prisma.Decimal("0.035"),
                    overMileageFeeAmount: BigInt(100),
                    productVersionId: "version-1",
                    status: RecordStatus.ACTIVE,
                    updatedAt: now,
                    updatedBy: "user-1",
                    vehicleModel: "ET5"
                  }
                ],
                productId: "product-1",
                status: ProductVersionStatus.ACTIVE,
                updatedAt: now,
                updatedBy: "user-1",
                versionNo: "V1.0"
              }
            ]
          }
        ])
      }
    } as never);

    const products = await service.listProducts();

    expect(products[0]?.versions).toHaveLength(1);
    expect(products[0]?.activeVersion).toMatchObject({
      id: "version-1",
      product: null,
      versionNo: "V1.0"
    });
  });
});
