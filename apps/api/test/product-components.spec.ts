import {
  BenefitType,
  Prisma,
  ProductStatus,
  ProductType,
  ProductVersionStatus,
  QuoteStatus,
  RecordStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { ProductService } from "../src/product/product.service";

const VehicleModel = {
  EC6: "EC6",
  ES6: "ES6",
  ES8: "ES8",
  ES9: "ES9",
  ET5: "ET5",
  ET5T: "ET5T",
  ET7: "ET7"
} as const;

const now = new Date("2026-06-01T00:00:00.000Z");
const user = {
  id: "user-1",
  menus: [],
  name: "Admin",
  permissions: [],
  roles: ["ADMIN"],
  username: "admin"
};
const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
const product = {
  createdAt: now,
  createdBy: "user-1",
  deletedAt: null,
  description: null,
  id: "product-1",
  name: "Subscription",
  productNo: "PRD2026060100001",
  productType: ProductType.SUBSCRIPTION,
  status: ProductStatus.ACTIVE,
  updatedAt: now,
  updatedBy: "user-1"
};
const version = {
  approvedAt: now,
  approvedBy: "user-1",
  approver: null,
  createdAt: now,
  createdBy: "user-1",
  deletedAt: null,
  effectiveFrom: now,
  effectiveTo: null,
  id: "version-1",
  priceRules: [],
  product,
  productId: "product-1",
  status: ProductVersionStatus.ACTIVE,
  updatedAt: now,
  updatedBy: "user-1",
  versionNo: "V1.0"
};

describe("product component packages", () => {
  it("creates vehicle, mileage, energy and benefit packages", async () => {
    const { audit, prisma, service } = makeService();

    const vehiclePackage = await service.createVehiclePackage(
      {
        maxPeriodMonths: 36,
        maxPurchasePriceAmount: 18000000,
        minPeriodMonths: 12,
        minPurchasePriceAmount: 12000000,
        modelDefinitionId: "model-et5",
        monthlyFeeRate: 0.035,
        packageName: "ET5 standard",
        productId: "product-1",
        productVersionId: "version-1"
      },
      user,
      context
    );
    const mileagePackage = await service.createMileagePackage(
      {
        monthlyMileageKm: 1500,
        overMileageFeeAmount: 100,
        packageName: "1500km",
        priceAmount: 0,
        productId: "product-1",
        productVersionId: "version-1"
      },
      user,
      context
    );
    const energyPackage = await service.createEnergyPackage(
      {
        monthlyEnergyCount: 8,
        monthlyEnergyKwh: 300,
        packageName: "300kWh",
        priceAmount: 0,
        productId: "product-1",
        productVersionId: "version-1"
      },
      user,
      context
    );
    const benefitPackage = await service.createBenefitPackage(
      {
        benefitCount: 4,
        benefitType: BenefitType.WASH_CAR,
        packageName: "Wash x4",
        priceAmount: 0,
        productId: "product-1",
        productVersionId: "version-1"
      },
      user,
      context
    );

    expect(vehiclePackage).toMatchObject({
      packageNo: expect.stringMatching(/^VPK\d{14}[A-Z2-9]{4}$/),
      status: RecordStatus.ACTIVE
    });
    expect(mileagePackage).toMatchObject({
      packageNo: expect.stringMatching(/^MPK\d{14}[A-Z2-9]{4}$/),
      status: RecordStatus.ACTIVE
    });
    expect(energyPackage).toMatchObject({
      packageNo: expect.stringMatching(/^EPK\d{14}[A-Z2-9]{4}$/),
      status: RecordStatus.ACTIVE
    });
    expect(benefitPackage).toMatchObject({
      packageNo: expect.stringMatching(/^BPK\d{14}[A-Z2-9]{4}$/),
      status: RecordStatus.ACTIVE
    });
    expect(prisma.productVersion.findUnique).toHaveBeenCalled();
    expect(audit.write).toHaveBeenCalledTimes(4);
  });

  it("rejects package ownership mismatches", async () => {
    const { prisma, service } = makeService();
    prisma.productVersion.findUnique.mockResolvedValueOnce({ ...version, productId: "product-2" });

    await expect(
      service.createBenefitPackage(
        {
          benefitType: BenefitType.POINTS,
          packageName: "points",
          productId: "product-1",
          productVersionId: "version-1"
        },
        user,
        context
      )
    ).rejects.toThrow();
  });

  it("supports status changes and soft-delete filtering", async () => {
    const activeVehiclePackage = makeVehiclePackage({ status: RecordStatus.ACTIVE });
    const deletedVehiclePackage = makeVehiclePackage({
      deletedAt: new Date("2026-06-01T01:00:00.000Z"),
      id: "vehicle-deleted"
    });
    const { prisma, service } = makeService({
      vehiclePackages: [activeVehiclePackage, deletedVehiclePackage]
    });

    prisma.vehiclePackage.findUnique.mockResolvedValueOnce(makeVehiclePackage({ status: RecordStatus.INACTIVE }));
    prisma.vehiclePackage.update.mockResolvedValueOnce(makeVehiclePackage({ status: RecordStatus.ACTIVE }));
    await expect(
      service.setVehiclePackageStatus("vehicle-1", RecordStatus.ACTIVE, user, context)
    ).resolves.toMatchObject({ status: RecordStatus.ACTIVE });

    prisma.mileagePackage.findUnique.mockResolvedValueOnce(makeMileagePackage({ status: RecordStatus.ACTIVE }));
    prisma.mileagePackage.update.mockResolvedValueOnce(makeMileagePackage({ status: RecordStatus.INACTIVE }));
    await expect(
      service.setMileagePackageStatus("mileage-1", RecordStatus.INACTIVE, user, context)
    ).resolves.toMatchObject({ status: RecordStatus.INACTIVE });

    const list = await service.listVehiclePackages();
    expect(list.map((item) => item.id)).toEqual(["vehicle-1"]);

    prisma.energyPackage.findUnique.mockResolvedValueOnce(
      makeEnergyPackage({ deletedAt: new Date("2026-06-01T01:00:00.000Z") })
    );
    await expect(service.setEnergyPackageStatus("energy-1", RecordStatus.ACTIVE, user, context)).rejects.toThrow(
      "Energy package not found."
    );
  });

  it("lists only active non-deleted packages for a product version", async () => {
    const { service } = makeService({
      benefitPackages: [
        makeBenefitPackage({ id: "benefit-active", status: RecordStatus.ACTIVE }),
        makeBenefitPackage({ id: "benefit-inactive", status: RecordStatus.INACTIVE }),
        makeBenefitPackage({ id: "benefit-other-version", productVersionId: "version-2" }),
        makeBenefitPackage({ deletedAt: new Date("2026-06-01T01:00:00.000Z"), id: "benefit-deleted" })
      ],
      energyPackages: [
        makeEnergyPackage({ id: "energy-active", status: RecordStatus.ACTIVE }),
        makeEnergyPackage({ id: "energy-inactive", status: RecordStatus.INACTIVE })
      ],
      mileagePackages: [
        makeMileagePackage({ id: "mileage-active", status: RecordStatus.ACTIVE }),
        makeMileagePackage({ id: "mileage-other-version", productVersionId: "version-2" })
      ],
      vehiclePackages: [
        makeVehiclePackage({ id: "vehicle-active", status: RecordStatus.ACTIVE }),
        makeVehiclePackage({ deletedAt: new Date("2026-06-01T01:00:00.000Z"), id: "vehicle-deleted" })
      ]
    });

    const packages = await service.listVersionPackages("version-1");

    expect(packages.vehiclePackages.map((item) => item.id)).toEqual(["vehicle-active"]);
    expect(packages.mileagePackages.map((item) => item.id)).toEqual(["mileage-active"]);
    expect(packages.energyPackages.map((item) => item.id)).toEqual(["energy-active"]);
    expect(packages.benefitPackages.map((item) => item.id)).toEqual(["benefit-active"]);
  });
});

describe("product component model definitions", () => {
  it("creates vehicle packages from modelDefinitionId and writes its modelCode", async () => {
    const definition = makeModelDefinition({
      displayName: "ET5 Touring",
      id: "model-et5t",
      legacyVehicleModel: VehicleModel.ET5T,
      modelCode: "NIO_ET5T"
    });
    const { prisma, service } = makeService({ modelDefinitions: [definition] });

    const result = await service.createVehiclePackage(
      {
        maxPeriodMonths: 36,
        minPeriodMonths: 12,
        modelDefinitionId: definition.id,
        monthlyFeeRate: 0.035,
        packageName: "ET5T standard",
        productId: "product-1",
        productVersionId: "version-1"
      },
      user,
      context
    );

    expect(prisma.vehicleModelDefinition.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null, id: definition.id } })
    );
    expect(prisma.vehiclePackage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modelDefinitionId: definition.id,
          vehicleModel: definition.modelCode
        })
      })
    );
    expect(result).toMatchObject({
      modelDefinitionId: definition.id,
      vehicleModel: definition.modelCode
    });
  });

  it("writes MODEL_X_2027 from a model definition without a legacy mapping", async () => {
    const definition = makeModelDefinition({
      displayName: "Model X 2027",
      id: "model-x-2027",
      legacyVehicleModel: null,
      modelCode: "MODEL_X_2027"
    });
    const { prisma, service } = makeService({ modelDefinitions: [definition] });

    await service.createVehiclePackage(
      {
        maxPeriodMonths: 36,
        minPeriodMonths: 12,
        modelDefinitionId: definition.id,
        monthlyFeeRate: 0.035,
        packageName: "Model X 2027 standard",
        productId: "product-1",
        productVersionId: "version-1"
      },
      user,
      context
    );

    expect(prisma.vehiclePackage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modelDefinitionId: definition.id,
          vehicleModel: "MODEL_X_2027"
        })
      })
    );
  });

  it("rejects legacy-only vehicle package creation even when a model definition mapping exists", async () => {
    const definition = makeModelDefinition({
      displayName: "ES6",
      id: "model-es6",
      legacyVehicleModel: VehicleModel.ES6,
      modelCode: "NIO_ES6"
    });
    const { prisma, service } = makeService({ modelDefinitions: [definition] });

    await expect(
      service.createVehiclePackage(
        {
          maxPeriodMonths: 36,
          minPeriodMonths: 12,
          monthlyFeeRate: 0.035,
          packageName: "ES6 standard",
          productId: "product-1",
          productVersionId: "version-1",
          vehicleModel: VehicleModel.ES6
        },
        user,
        context
      )
    ).rejects.toThrow();
    expect(prisma.vehiclePackage.create).not.toHaveBeenCalled();
  });

  it("rejects vehicle package creation when legacy vehicleModel has no model definition mapping", async () => {
    const { prisma, service } = makeService({ modelDefinitions: [] });

    await expect(
      service.createVehiclePackage(
        {
          maxPeriodMonths: 36,
          minPeriodMonths: 12,
          monthlyFeeRate: 0.035,
          packageName: "ES6 standard",
          productId: "product-1",
          productVersionId: "version-1",
          vehicleModel: VehicleModel.ES6
        },
        user,
        context
      )
    ).rejects.toThrow();
    expect(prisma.vehiclePackage.create).not.toHaveBeenCalled();
  });

  it("creates price rules from modelDefinitionId and rejects mismatched compatibility codes", async () => {
    const definition = makeModelDefinition({
      displayName: "ES8",
      id: "model-es8",
      legacyVehicleModel: VehicleModel.ES8,
      modelCode: "NIO_ES8"
    });
    const { prisma, service } = makeService({ modelDefinitions: [definition] });

    await expect(
      service.createPriceRule(
        "version-1",
        {
          baseMileageKm: 1500,
          maxPeriodMonths: 36,
          minPeriodMonths: 12,
          modelDefinitionId: definition.id,
          monthlyFeeRate: 0.04,
          overMileageFeeAmount: 100
        },
        user,
        context
      )
    ).resolves.toMatchObject({
      modelDefinitionId: definition.id,
      vehicleModel: definition.modelCode
    });
    expect(prisma.productPriceRule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modelDefinitionId: definition.id,
          vehicleModel: definition.modelCode
        })
      })
    );

    await expect(
      service.createPriceRule(
        "version-1",
        {
          baseMileageKm: 1500,
          maxPeriodMonths: 36,
          minPeriodMonths: 12,
          modelDefinitionId: definition.id,
          overMileageFeeAmount: 100,
          vehicleModel: VehicleModel.ET5
        },
        user,
        context
      )
    ).rejects.toThrow();
  });

  it("rejects clearing vehicle package modelDefinitionId", async () => {
    const definition = makeModelDefinition({
      displayName: "ES9",
      id: "model-es9",
      legacyVehicleModel: VehicleModel.ES9,
      modelCode: "NIO_ES9"
    });
    const { prisma, service } = makeService({
      vehiclePackages: [
        makeVehiclePackage({
          modelDefinition: definition,
          modelDefinitionId: definition.id,
          vehicleModel: VehicleModel.ES9
        })
      ]
    });

    await expect(
      service.updateVehiclePackage("vehicle-1", { modelDefinitionId: null }, user, context)
    ).rejects.toThrow();
    expect(prisma.vehiclePackage.update).not.toHaveBeenCalled();
  });

  it("rejects legacy-only vehicle package updates", async () => {
    const definition = makeModelDefinition({
      displayName: "ET7",
      id: "model-et7",
      legacyVehicleModel: VehicleModel.ET7,
      modelCode: "NIO_ET7"
    });
    const { prisma, service } = makeService({
      modelDefinitions: [definition],
      vehiclePackages: [makeVehiclePackage({ modelDefinition: null, modelDefinitionId: null })]
    });

    await expect(
      service.updateVehiclePackage("vehicle-1", { vehicleModel: VehicleModel.ET7 }, user, context)
    ).rejects.toThrow();
    expect(prisma.vehiclePackage.update).not.toHaveBeenCalled();
  });

  it("rejects legacy-only product price rule creation", async () => {
    const definition = makeModelDefinition({
      displayName: "EC6",
      id: "model-ec6",
      legacyVehicleModel: VehicleModel.EC6,
      modelCode: "NIO_EC6"
    });
    const { prisma, service } = makeService({ modelDefinitions: [definition] });

    await expect(
      service.createPriceRule(
        "version-1",
        {
          baseMileageKm: 1500,
          maxPeriodMonths: 36,
          minPeriodMonths: 12,
          overMileageFeeAmount: 100,
          vehicleModel: VehicleModel.EC6
        },
        user,
        context
      )
    ).rejects.toThrow();
    expect(prisma.productPriceRule.create).not.toHaveBeenCalled();
  });

  it("rejects product price rules without a vehicle model scope", async () => {
    const { prisma, service } = makeService();

    await expect(
      service.createPriceRule(
        "version-1",
        {
          baseMileageKm: 1500,
          maxPeriodMonths: 36,
          minPeriodMonths: 12,
          overMileageFeeAmount: 100
        },
        user,
        context
      )
    ).rejects.toThrow();
    expect(prisma.productPriceRule.create).not.toHaveBeenCalled();
  });

  it("rejects clearing product price rule modelDefinitionId", async () => {
    const definition = makeModelDefinition({
      displayName: "ES8",
      id: "model-es8",
      legacyVehicleModel: VehicleModel.ES8,
      modelCode: "NIO_ES8"
    });
    const { prisma, service } = makeService({
      priceRules: [makePriceRule({ modelDefinition: definition, modelDefinitionId: definition.id, vehicleModel: VehicleModel.ES8 })]
    });

    await expect(service.updatePriceRule("rule-1", { modelDefinitionId: null }, user, context)).rejects.toThrow();
    expect(prisma.productPriceRule.update).not.toHaveBeenCalled();
  });

  it("rejects legacy-only product price rule updates", async () => {
    const definition = makeModelDefinition({
      displayName: "EC6",
      id: "model-ec6",
      legacyVehicleModel: VehicleModel.EC6,
      modelCode: "NIO_EC6"
    });
    const { prisma, service } = makeService({
      modelDefinitions: [definition],
      priceRules: [makePriceRule({ modelDefinition: null, modelDefinitionId: null })]
    });

    await expect(service.updatePriceRule("rule-1", { vehicleModel: VehicleModel.EC6 }, user, context)).rejects.toThrow();
    expect(prisma.productPriceRule.update).not.toHaveBeenCalled();
  });
});

describe("quote compatibility with component fields", () => {
  it("lists and reads old quotes when component fields are empty", async () => {
    const oldQuote = makeQuote({
      benefitPackageId: null,
      energyPackageId: null,
      mileagePackageId: null,
      packageSnapshot: null,
      vehiclePackageId: null
    });
    const { prisma, service } = makeService({ quotes: [oldQuote] });
    prisma.subscriptionQuote.findUnique.mockResolvedValueOnce(oldQuote);

    await expect(service.listQuotes(user)).resolves.toMatchObject([
      { id: "quote-1", packageSnapshot: null, vehiclePackageId: null }
    ]);
    await expect(service.getQuote("quote-1", user)).resolves.toMatchObject({
      id: "quote-1",
      packageSnapshot: null
    });
  });

  it("confirms old draft quotes without component package data", async () => {
    const oldQuote = makeQuote({ status: QuoteStatus.DRAFT });
    const confirmedQuote = makeQuote({ confirmedAt: now, confirmedBy: "user-1", status: QuoteStatus.CONFIRMED });
    const { prisma, service } = makeService();
    prisma.subscriptionQuote.findUnique.mockResolvedValueOnce(oldQuote);
    prisma.subscriptionQuote.update.mockResolvedValueOnce(confirmedQuote);

    await expect(service.confirmQuote("quote-1", user, context)).resolves.toMatchObject({
      id: "quote-1",
      status: QuoteStatus.CONFIRMED
    });
  });
});

function makeService(seed: Partial<MockSeed> = {}) {
  const audit = { write: vi.fn().mockResolvedValue(undefined) };
  const prisma = {
    $transaction: vi.fn(),
    benefitPackage: makePackageDelegate(seed.benefitPackages ?? [makeBenefitPackage()], makeBenefitPackage),
    energyPackage: makePackageDelegate(seed.energyPackages ?? [makeEnergyPackage()], makeEnergyPackage),
    mileagePackage: makePackageDelegate(seed.mileagePackages ?? [makeMileagePackage()], makeMileagePackage),
    product: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(product)
    },
    productPriceRule: makePackageDelegate(seed.priceRules ?? [makePriceRule()], makePriceRule),
    productVersion: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(version),
      update: vi.fn(),
      updateMany: vi.fn()
    },
    subscriptionQuote: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue(seed.quotes ?? []),
      findUnique: vi.fn().mockResolvedValue(seed.quotes?.[0] ?? makeQuote()),
      update: vi.fn().mockResolvedValue(makeQuote({ status: QuoteStatus.CONFIRMED }))
    },
    vehicle: {
      findUnique: vi.fn(),
      update: vi.fn()
    },
    vehicleModelDefinition: {
      findFirst: vi.fn().mockImplementation(({ where }) =>
        Promise.resolve(
          (seed.modelDefinitions ?? [makeModelDefinition()]).find(
            (definition) =>
              (where.id === undefined || definition.id === where.id) &&
              (where.legacyVehicleModel === undefined || definition.legacyVehicleModel === where.legacyVehicleModel) &&
              (where.deletedAt !== null || definition.deletedAt === null)
          ) ?? null
        )
      )
    },
    vehiclePackage: makePackageDelegate(seed.vehiclePackages ?? [makeVehiclePackage()], makeVehiclePackage)
  };
  prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => unknown) => callback(prisma));

  return { audit, prisma, service: new ProductService(audit as never, prisma as never) };
}

function makePackageDelegate<T extends { deletedAt?: Date | null; id: string; productVersionId?: string; status?: RecordStatus }>(
  rows: T[],
  factory: (overrides?: Record<string, unknown>) => T
) {
  return {
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation(({ data }) => Promise.resolve(factory(data))),
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockImplementation(({ where }) => Promise.resolve(filterRows(rows, where))),
    findUnique: vi.fn().mockResolvedValue(rows[0] ?? factory()),
    update: vi.fn().mockImplementation(({ data, where }) =>
      Promise.resolve(factory({ ...(rows.find((row) => row.id === where.id) ?? rows[0]), ...data }))
    )
  };
}

function filterRows<T extends { deletedAt?: Date | null; productVersionId?: string; status?: RecordStatus }>(
  rows: T[],
  where: { deletedAt?: null; productVersionId?: string; status?: RecordStatus }
) {
  return rows.filter((row) => {
    if (where.deletedAt === null && row.deletedAt) {
      return false;
    }
    if (where.productVersionId && row.productVersionId !== where.productVersionId) {
      return false;
    }
    if (where.status && row.status !== where.status) {
      return false;
    }
    return true;
  });
}

function makeVehiclePackage(overrides: Record<string, unknown> = {}) {
  return {
    brand: null,
    configName: null,
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    id: "vehicle-1",
    maxPeriodMonths: 36,
    maxPurchasePriceAmount: BigInt(18000000),
    minPeriodMonths: 12,
    minPurchasePriceAmount: BigInt(12000000),
    monthlyFeeRate: new Prisma.Decimal("0.035"),
    modelDefinition: null,
    modelDefinitionId: null,
    packageName: "ET5 standard",
    packageNo: "VPK2026060100001",
    product,
    productId: "product-1",
    productVersion: version,
    productVersionId: "version-1",
    remark: null,
    series: null,
    status: RecordStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleModel: VehicleModel.ET5,
    vehicleModelName: null,
    ...overrides
  };
}

function makePriceRule(overrides: Record<string, unknown> = {}) {
  return {
    baseMileageKm: 1500,
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    energyLimitCount: 8,
    energyLimitKwh: 300,
    id: "rule-1",
    maxPeriodMonths: 36,
    minPeriodMonths: 12,
    modelDefinition: null,
    modelDefinitionId: null,
    monthlyFeeRate: new Prisma.Decimal("0.035"),
    overMileageFeeAmount: BigInt(100),
    productVersion: version,
    productVersionId: "version-1",
    status: RecordStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleModel: VehicleModel.ET5,
    ...overrides
  };
}

function makeModelDefinition(overrides: Record<string, unknown> = {}) {
  return {
    brand: "NIO",
    createdAt: now,
    createdBy: "user-1",
    customerDisplayName: null,
    deletedAt: null,
    displayName: "ET5",
    enabled: true,
    id: "model-et5",
    legacyVehicleModel: VehicleModel.ET5,
    modelCode: "NIO_ET5",
    modelName: "ET5",
    portalVisible: true,
    series: "ET",
    sortOrder: 0,
    updatedAt: now,
    updatedBy: "user-1",
    ...overrides
  };
}

function makeMileagePackage(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    id: "mileage-1",
    monthlyMileageKm: 1500,
    overMileageFeeAmount: BigInt(100),
    packageName: "1500km",
    packageNo: "MPK2026060100001",
    priceAmount: BigInt(0),
    product,
    productId: "product-1",
    productVersion: version,
    productVersionId: "version-1",
    remark: null,
    status: RecordStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "user-1",
    ...overrides
  };
}

function makeEnergyPackage(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    id: "energy-1",
    monthlyEnergyCount: 8,
    monthlyEnergyKwh: 300,
    packageName: "300kWh",
    packageNo: "EPK2026060100001",
    priceAmount: BigInt(0),
    product,
    productId: "product-1",
    productVersion: version,
    productVersionId: "version-1",
    remark: null,
    serviceDescription: null,
    stationScope: null,
    status: RecordStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "user-1",
    ...overrides
  };
}

function makeBenefitPackage(overrides: Record<string, unknown> = {}) {
  return {
    benefitCount: 4,
    benefitType: BenefitType.WASH_CAR,
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    description: null,
    id: "benefit-1",
    packageName: "Wash x4",
    packageNo: "BPK2026060100001",
    priceAmount: BigInt(0),
    product,
    productId: "product-1",
    productVersion: version,
    productVersionId: "version-1",
    remark: null,
    status: RecordStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "user-1",
    ...overrides
  };
}

function makeQuote(overrides: Record<string, unknown> = {}) {
  return {
    application: { applicationNo: "APP2026060100001", id: "application-1", salesUserId: "user-1", status: "APPROVED" },
    applicationId: "application-1",
    benefitPackage: null,
    benefitPackageId: null,
    cancelledAt: null,
    confirmedAt: null,
    confirmedBy: null,
    confirmer: null,
    createdAt: now,
    createdBy: "user-1",
    customer: { grade: "A", id: "customer-1", mobile: "13800000000", name: "Customer" },
    customerId: "customer-1",
    deletedAt: null,
    depositAmount: BigInt(500000),
    energyLimitCount: 8,
    energyLimitKwh: 300,
    energyPackage: null,
    energyPackageId: null,
    expiredAt: null,
    id: "quote-1",
    mileageLimitKm: 1500,
    mileagePackage: null,
    mileagePackageId: null,
    monthlyFeeAmount: BigInt(420000),
    monthlyFeeRate: new Prisma.Decimal("0.035"),
    order: null,
    overMileageFeeAmount: BigInt(100),
    packageSnapshot: null,
    periodMonths: 12,
    productId: "product-1",
    productVersion: version,
    productVersionId: "version-1",
    quoteNo: "QUO2026060100001",
    riskResult: { id: "risk-1" },
    riskResultId: "risk-1",
    status: QuoteStatus.DRAFT,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleModel: VehicleModel.ET5,
    vehiclePackage: null,
    vehiclePackageId: null,
    vehiclePurchasePriceAmount: BigInt(12000000),
    ...overrides
  };
}

interface MockSeed {
  benefitPackages: ReturnType<typeof makeBenefitPackage>[];
  energyPackages: ReturnType<typeof makeEnergyPackage>[];
  mileagePackages: ReturnType<typeof makeMileagePackage>[];
  modelDefinitions: ReturnType<typeof makeModelDefinition>[];
  priceRules: ReturnType<typeof makePriceRule>[];
  quotes: ReturnType<typeof makeQuote>[];
  vehiclePackages: ReturnType<typeof makeVehiclePackage>[];
}
