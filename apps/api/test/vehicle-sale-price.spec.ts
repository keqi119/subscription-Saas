import fs from "node:fs";
import path from "node:path";

import {
  AuditAction,
  Prisma,
  SalePriceStatus,
  Vehicle,
  VehicleBatteryUsageType,
  VehicleModel,
  VehicleSalePriceHistory,
  VehicleSalePriceReviewType,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { AuditService } from "../src/audit/audit.service";
import { RequestContext, RequestUser } from "../src/auth/auth.types";
import { PrismaService } from "../src/prisma/prisma.service";
import { VehicleService } from "../src/vehicle/vehicle.service";

describe("VehicleService sale price baseline", () => {
  it("creates vehicle and saves purchasePriceAmount as asset cost", async () => {
    const { auditService, prisma, service } = makeService();
    const vehicle = makeVehicle({ purchasePriceAmount: 16800000n });
    prisma.vehicle.create.mockResolvedValueOnce(vehicle);

    const result = await service.createVehicle(
      {
        brand: "NIO",
        batteryCapacityKwh: 75,
        batteryUsageType: VehicleBatteryUsageType.BUYOUT,
        purchasePriceAmount: 16800000,
        vehicleModel: VehicleModel.ET5,
        vin: "TESTVINET50000002"
      },
      user,
      context
    );

    expect(prisma.vehicle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          purchasePriceAmount: 16800000n,
          batteryCapacityKwh: new Prisma.Decimal(75),
          batteryUsageType: VehicleBatteryUsageType.BUYOUT,
          vin: "TESTVINET50000002",
          vehicleNo: expect.stringMatching(/^VEH\d{14}[A-Z0-9]{4}$/)
        })
      })
    );
    expect(result.purchasePriceAmount).toBe(16800000);
    expect(result.batteryCapacityKwh).toBe(75);
    expect(result.batteryUsageType).toBe(VehicleBatteryUsageType.BUYOUT);
    expect(result.batteryUsageTypeLabel).toBe("电池买断");
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.CREATE, entityType: "vehicle" })
    );
  });

  it("rejects invalid battery capacity when creating a vehicle", async () => {
    const { service } = makeService();

    await expect(
      service.createVehicle(
        {
          batteryCapacityKwh: 0,
          batteryUsageType: VehicleBatteryUsageType.BUYOUT,
          brand: "NIO",
          purchasePriceAmount: 16800000,
          vehicleModel: VehicleModel.ET5,
          vin: "TESTVINET50000002"
        },
        user,
        context
      )
    ).rejects.toThrow("电池容量必须大于 0");
  });

  it("rejects invalid battery usage type when creating a vehicle", async () => {
    const { service } = makeService();

    await expect(
      service.createVehicle(
        {
          batteryCapacityKwh: 75,
          batteryUsageType: "LEASED" as VehicleBatteryUsageType,
          brand: "NIO",
          purchasePriceAmount: 16800000,
          vehicleModel: VehicleModel.ET5,
          vin: "TESTVINET50000002"
        },
        user,
        context
      )
    ).rejects.toThrow("电池使用方式只能是 BUYOUT 或 BAAS");
  });

  it("rejects duplicate VIN when creating a vehicle", async () => {
    const { prisma, service } = makeService();
    prisma.vehicle.create.mockRejectedValue({ code: "P2002", meta: { target: ["vin"] } });

    await expect(
      service.createVehicle(
        {
          brand: "NIO",
          purchasePriceAmount: 16800000,
          vehicleModel: VehicleModel.ET5,
          vin: "TESTVINET50000002"
        },
        user,
        context
      )
    ).rejects.toThrow("VIN 已存在");
    expect(prisma.vehicle.create).toHaveBeenCalledTimes(3);
  });

  it("initializes currentSalePriceAmount and writes VehicleSalePriceHistory", async () => {
    const { auditService, prisma, service } = makeService();
    const before = makeVehicle({
      currentSalePriceAmount: null,
      salePriceHistories: [],
      salePriceStatus: SalePriceStatus.PENDING_INITIALIZE
    });
    const after = makeVehicle({
      currentSalePriceAmount: 15000000n,
      currentSalePriceInitializedAt: new Date("2026-06-02T01:00:00.000Z"),
      currentSalePriceReviewedAt: new Date("2026-06-02T01:00:00.000Z"),
      nextSalePriceReviewAt: new Date("2026-09-01T00:00:00.000Z"),
      salePriceStatus: SalePriceStatus.EFFECTIVE
    });
    const history = makeHistory({
      afterSalePriceAmount: 15000000n,
      effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
      reviewQuarter: "2026Q2"
    });

    prisma.vehicle.findUnique.mockResolvedValueOnce(before);
    prisma.vehicle.update.mockResolvedValueOnce(after);
    prisma.vehicleSalePriceHistory.create.mockResolvedValueOnce(history);

    const result = await service.initializeSalePrice(
      "vehicle-1",
      {
        currentSalePriceAmount: 15000000,
        effectiveFrom: "2026-06-01",
        reason: "新入池初始化"
      },
      user,
      context
    );

    expect(prisma.vehicle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentSalePriceAmount: 15000000n,
          nextSalePriceReviewAt: new Date("2026-09-01T00:00:00.000Z"),
          salePriceStatus: SalePriceStatus.EFFECTIVE
        }),
        where: { id: "vehicle-1" }
      })
    );
    expect(prisma.vehicleSalePriceHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        afterSalePriceAmount: 15000000n,
        beforeSalePriceAmount: null,
        effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
        reason: "新入池初始化",
        reviewQuarter: "2026Q2",
        reviewType: VehicleSalePriceReviewType.INITIAL_POOL,
        vehicleId: "vehicle-1"
      })
    });
    expect(result.currentSalePriceAmount).toBe(15000000);
    expect(result.salePriceHistories).toHaveLength(1);
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.CREATE, entityType: "vehicle_sale_price_history" })
    );
  });

  it("returns vehicles that are due for quarterly sale price review", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T08:00:00.000Z"));
    const { prisma, service } = makeService();
    prisma.vehicle.findMany.mockResolvedValueOnce([
      makeVehicle({
        currentSalePriceAmount: 15000000n,
        nextSalePriceReviewAt: new Date("2026-06-01T00:00:00.000Z"),
        salePriceStatus: SalePriceStatus.EFFECTIVE
      })
    ]);

    try {
      const result = await service.listDueSalePriceReviews();

      expect(prisma.vehicle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            deletedAt: null,
            nextSalePriceReviewAt: { lte: new Date("2026-06-02T00:00:00.000Z") },
            salePriceStatus: { in: [SalePriceStatus.EFFECTIVE, SalePriceStatus.REVIEW_DUE] }
          }
        })
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.salePriceStatus).toBe(SalePriceStatus.REVIEW_DUE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reviews quarterly sale price, updates current amount, writes history, and pushes next review by 3 months", async () => {
    const { auditService, prisma, service } = makeService();
    const before = makeVehicle({
      currentSalePriceAmount: 14000000n,
      nextSalePriceReviewAt: new Date("2026-07-01T00:00:00.000Z"),
      salePriceStatus: SalePriceStatus.REVIEW_DUE
    });
    const after = makeVehicle({
      currentSalePriceAmount: 14500000n,
      currentSalePriceReviewedAt: new Date("2026-06-02T01:00:00.000Z"),
      nextSalePriceReviewAt: new Date("2026-10-01T00:00:00.000Z"),
      salePriceStatus: SalePriceStatus.EFFECTIVE
    });
    const history = makeHistory({
      afterSalePriceAmount: 14500000n,
      beforeSalePriceAmount: 14000000n,
      effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
      reason: "季度市场价格复核",
      reviewQuarter: "2026Q3",
      reviewType: VehicleSalePriceReviewType.QUARTERLY_REVIEW
    });

    prisma.vehicle.findUnique.mockResolvedValueOnce(before);
    prisma.vehicle.update.mockResolvedValueOnce(after);
    prisma.vehicleSalePriceHistory.create.mockResolvedValueOnce(history);

    const result = await service.reviewSalePrice(
      "vehicle-1",
      {
        effectiveFrom: "2026-07-01",
        newSalePriceAmount: 14500000,
        reason: "季度市场价格复核",
        reviewQuarter: "2026Q3"
      },
      user,
      context
    );

    expect(prisma.vehicle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentSalePriceAmount: 14500000n,
          nextSalePriceReviewAt: new Date("2026-10-01T00:00:00.000Z"),
          salePriceStatus: SalePriceStatus.EFFECTIVE
        }),
        where: { id: "vehicle-1" }
      })
    );
    expect(prisma.vehicleSalePriceHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        afterSalePriceAmount: 14500000n,
        beforeSalePriceAmount: 14000000n,
        effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
        reason: "季度市场价格复核",
        reviewQuarter: "2026Q3",
        reviewType: VehicleSalePriceReviewType.QUARTERLY_REVIEW,
        vehicleId: "vehicle-1"
      })
    });
    expect(result.currentSalePriceAmount).toBe(14500000);
    expect(result.salePriceHistories[0]?.reviewType).toBe(VehicleSalePriceReviewType.QUARTERLY_REVIEW);
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.CREATE, entityType: "vehicle_sale_price_history" })
    );
  });

  it("blocks AVAILABLE status when currentSalePriceAmount is not initialized", async () => {
    const { prisma, service } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce(
      makeVehicle({
        currentSalePriceAmount: null,
        salePriceStatus: SalePriceStatus.PENDING_INITIALIZE,
        status: VehicleStatus.IN_PREPARATION
      })
    );

    await expect(
      service.updateStatus("vehicle-1", { status: VehicleStatus.AVAILABLE }, user, context)
    ).rejects.toThrow("请先初始化当前车辆销售价后再入池");
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
  });

  it("allows AVAILABLE status after currentSalePriceAmount is effective", async () => {
    const { prisma, service } = makeService();
    const before = makeVehicle({
      currentSalePriceAmount: 15000000n,
      salePriceStatus: SalePriceStatus.EFFECTIVE,
      status: VehicleStatus.IN_PREPARATION
    });
    const after = makeVehicle({
      currentSalePriceAmount: 15000000n,
      salePriceStatus: SalePriceStatus.EFFECTIVE,
      status: VehicleStatus.AVAILABLE
    });

    prisma.vehicle.findUnique.mockResolvedValueOnce(before);
    prisma.vehicle.update.mockResolvedValueOnce(after);

    const result = await service.updateStatus(
      "vehicle-1",
      { status: VehicleStatus.AVAILABLE },
      user,
      context
    );

    expect(prisma.vehicle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: VehicleStatus.AVAILABLE })
      })
    );
    expect(result.status).toBe(VehicleStatus.AVAILABLE);
  });

  it("blocks return vehicles from entering AVAILABLE without RETURN_REINIT history", async () => {
    const { prisma, service } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce(
      makeVehicle({
        currentSalePriceAmount: 15000000n,
        salePriceHistories: [
          makeHistory({
            reviewType: VehicleSalePriceReviewType.INITIAL_POOL
          })
        ],
        salePriceReinitRequiredAt: new Date("2026-08-01T00:00:00.000Z"),
        salePriceStatus: SalePriceStatus.EFFECTIVE,
        status: VehicleStatus.RETURNED
      })
    );

    await expect(
      service.updateStatus("vehicle-1", { status: VehicleStatus.AVAILABLE }, user, context)
    ).rejects.toThrow("退回车辆需重新初始化当前销售价后才能入池");
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
  });

  it("blocks maintenance vehicles from entering AVAILABLE without RETURN_REINIT history", async () => {
    const { prisma, service } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce(
      makeVehicle({
        currentSalePriceAmount: 15000000n,
        salePriceHistories: [makeHistory()],
        salePriceReinitRequiredAt: new Date("2026-08-01T00:00:00.000Z"),
        salePriceStatus: SalePriceStatus.EFFECTIVE,
        status: VehicleStatus.MAINTENANCE
      })
    );

    await expect(
      service.updateStatus("vehicle-1", { status: VehicleStatus.AVAILABLE }, user, context)
    ).rejects.toThrow("退回车辆需重新初始化当前销售价后才能入池");
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
  });

  it("rejects RETURN_REINIT for vehicles that are not returned or under maintenance", async () => {
    const { prisma, service } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce(
      makeVehicle({
        currentSalePriceAmount: 15000000n,
        salePriceStatus: SalePriceStatus.EFFECTIVE,
        status: VehicleStatus.LEASED
      })
    );

    await expect(
      service.initializeSalePrice(
        "vehicle-1",
        {
          currentSalePriceAmount: 13800000,
          effectiveFrom: "2026-08-01",
          reason: "退车整备后重新入池",
          reviewType: VehicleSalePriceReviewType.RETURN_REINIT
        },
        user,
        context
      )
    ).rejects.toThrow("仅退回或维修中的车辆可以执行退车再入池重新定价");
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
    expect(prisma.vehicleSalePriceHistory.create).not.toHaveBeenCalled();
  });

  it("allows RETURN_REINIT sale price initialization before entering AVAILABLE", async () => {
    const { prisma, service } = makeService();
    const requiredAt = new Date("2026-08-01T00:00:00.000Z");
    const before = makeVehicle({
      currentSalePriceAmount: 15000000n,
      salePriceHistories: [makeHistory()],
      salePriceReinitRequiredAt: requiredAt,
      salePriceStatus: SalePriceStatus.EFFECTIVE,
      status: VehicleStatus.RETURNED
    });
    const afterReinit = makeVehicle({
      currentSalePriceAmount: 13800000n,
      currentSalePriceInitializedAt: new Date("2026-08-02T01:00:00.000Z"),
      currentSalePriceReviewedAt: new Date("2026-08-02T01:00:00.000Z"),
      nextSalePriceReviewAt: new Date("2026-11-01T00:00:00.000Z"),
      salePriceReinitRequiredAt: null,
      salePriceStatus: SalePriceStatus.EFFECTIVE,
      status: VehicleStatus.RETURNED
    });
    const returnHistory = makeHistory({
      afterSalePriceAmount: 13800000n,
      beforeSalePriceAmount: 15000000n,
      createdAt: new Date("2026-08-02T01:00:00.000Z"),
      effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
      reason: "合同终止退回后重新入池",
      reviewQuarter: "2026Q3",
      reviewType: VehicleSalePriceReviewType.RETURN_REINIT
    });
    const beforeAvailable = makeVehicle({
      currentSalePriceAmount: 13800000n,
      salePriceHistories: [returnHistory],
      salePriceReinitRequiredAt: null,
      salePriceStatus: SalePriceStatus.EFFECTIVE,
      status: VehicleStatus.RETURNED
    });
    const afterAvailable = makeVehicle({
      currentSalePriceAmount: 13800000n,
      salePriceHistories: [returnHistory],
      salePriceReinitRequiredAt: null,
      salePriceStatus: SalePriceStatus.EFFECTIVE,
      status: VehicleStatus.AVAILABLE
    });

    prisma.vehicle.findUnique.mockResolvedValueOnce(before);
    prisma.vehicle.update.mockResolvedValueOnce(afterReinit);
    prisma.vehicleSalePriceHistory.create.mockResolvedValueOnce(returnHistory);

    const initialized = await service.initializeSalePrice(
      "vehicle-1",
      {
        currentSalePriceAmount: 13800000,
        effectiveFrom: "2026-08-01",
        reason: "合同终止退回后重新入池",
        reviewType: VehicleSalePriceReviewType.RETURN_REINIT
      },
      user,
      context
    );

    expect(prisma.vehicle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentSalePriceAmount: 13800000n,
          nextSalePriceReviewAt: new Date("2026-11-01T00:00:00.000Z"),
          salePriceReinitRequiredAt: null,
          salePriceStatus: SalePriceStatus.EFFECTIVE
        })
      })
    );
    expect(prisma.vehicleSalePriceHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        afterSalePriceAmount: 13800000n,
        beforeSalePriceAmount: 15000000n,
        reviewType: VehicleSalePriceReviewType.RETURN_REINIT
      })
    });
    expect(initialized.currentSalePriceAmount).toBe(13800000);

    prisma.vehicle.findUnique.mockResolvedValueOnce(beforeAvailable);
    prisma.vehicle.update.mockResolvedValueOnce(afterAvailable);

    const available = await service.updateStatus(
      "vehicle-1",
      { status: VehicleStatus.AVAILABLE },
      user,
      context
    );

    expect(available.status).toBe(VehicleStatus.AVAILABLE);
  });

  it("allows MAINTENANCE vehicles to enter AVAILABLE after RETURN_REINIT", async () => {
    const { prisma, service } = makeService();
    const returnHistory = makeHistory({
      afterSalePriceAmount: 13800000n,
      beforeSalePriceAmount: 15000000n,
      createdAt: new Date("2026-08-02T01:00:00.000Z"),
      effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
      reviewType: VehicleSalePriceReviewType.RETURN_REINIT
    });

    prisma.vehicle.findUnique.mockResolvedValueOnce(
      makeVehicle({
        currentSalePriceAmount: 13800000n,
        salePriceHistories: [returnHistory],
        salePriceReinitRequiredAt: null,
        salePriceStatus: SalePriceStatus.EFFECTIVE,
        status: VehicleStatus.MAINTENANCE
      })
    );
    prisma.vehicle.update.mockResolvedValueOnce(
      makeVehicle({
        currentSalePriceAmount: 13800000n,
        salePriceHistories: [returnHistory],
        salePriceReinitRequiredAt: null,
        salePriceStatus: SalePriceStatus.EFFECTIVE,
        status: VehicleStatus.AVAILABLE
      })
    );

    const available = await service.updateStatus(
      "vehicle-1",
      { status: VehicleStatus.AVAILABLE },
      user,
      context
    );

    expect(available.status).toBe(VehicleStatus.AVAILABLE);
  });

  it("blocks occupied or retired vehicles from entering AVAILABLE directly", async () => {
    const { prisma, service } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce(
      makeVehicle({
        currentSalePriceAmount: 15000000n,
        salePriceStatus: SalePriceStatus.EFFECTIVE,
        status: VehicleStatus.LEASED
      })
    );

    await expect(
      service.updateStatus("vehicle-1", { status: VehicleStatus.AVAILABLE }, user, context)
    ).rejects.toThrow("当前车辆状态不允许直接入池");

    prisma.vehicle.findUnique.mockResolvedValueOnce(
      makeVehicle({
        currentSalePriceAmount: 15000000n,
        salePriceStatus: SalePriceStatus.EFFECTIVE,
        status: VehicleStatus.RETIRED
      })
    );

    await expect(
      service.updateStatus("vehicle-1", { status: VehicleStatus.AVAILABLE }, user, context)
    ).rejects.toThrow("当前车辆状态不允许直接入池");
  });

  it("returns only available vehicles with effective current sale price", async () => {
    const { prisma, service } = makeService();
    prisma.vehicle.findMany.mockResolvedValueOnce([
      makeVehicle({
        currentSalePriceAmount: 15000000n,
        salePriceStatus: SalePriceStatus.EFFECTIVE,
        status: VehicleStatus.AVAILABLE
      })
    ]);

    const result = await service.listAvailableVehicles();

    expect(prisma.vehicle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          currentSalePriceAmount: { gt: 0 },
          deletedAt: null,
          salePriceStatus: SalePriceStatus.EFFECTIVE,
          status: VehicleStatus.AVAILABLE
        }
      })
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe(VehicleStatus.AVAILABLE);
    expect(result[0]?.currentSalePriceAmount).toBe(15000000);
    expect(result[0]?.batteryCapacityKwh).toBe(75);
    expect(result[0]?.batteryUsageType).toBe(VehicleBatteryUsageType.BUYOUT);
  });

  it("returns old vehicles without battery capacity", async () => {
    const { prisma, service } = makeService();
    prisma.vehicle.findMany.mockResolvedValueOnce([
      makeVehicle({
        batteryCapacityKwh: null,
        batteryUsageType: VehicleBatteryUsageType.BUYOUT
      })
    ]);

    const result = await service.listVehicles();

    expect(result[0]?.batteryCapacityKwh).toBeNull();
    expect(result[0]?.batteryUsageType).toBe(VehicleBatteryUsageType.BUYOUT);
  });

  it("keeps demo seed vehicles eligible for available vehicle lookup", () => {
    const seedSource = fs.readFileSync(path.resolve(__dirname, "../prisma/seed.mjs"), "utf8");
    const serviceSource = fs.readFileSync(
      path.resolve(__dirname, "../src/vehicle/vehicle.service.ts"),
      "utf8"
    );

    for (const vin of ["TESTVINET50000001", "TESTVINET70000001", "TESTVINES60000001"]) {
      expect(seedSource).toContain(`vin: "${vin}"`);
    }
    for (const vehicleModel of ["ET5", "ET7", "ES6"]) {
      expect(seedSource).toContain(`vehicleModel: "${vehicleModel}"`);
    }
    expect(seedSource).toContain("prisma.vehicle.upsert");
    expect(seedSource).toContain('status: "AVAILABLE"');
    expect(seedSource).toContain('salePriceStatus: "EFFECTIVE"');
    expect(seedSource).toContain("batteryCapacityKwh");
    expect(seedSource).toContain('batteryUsageType: "BUYOUT"');
    expect(seedSource).toContain('reviewType: "INITIAL_POOL"');
    expect(serviceSource).toContain("currentSalePriceAmount: { gt: 0 }");
  });

  it("returns sale price history for a vehicle", async () => {
    const { prisma, service } = makeService();
    const history = makeHistory({
      afterSalePriceAmount: 14500000n,
      beforeSalePriceAmount: 14000000n,
      reviewType: VehicleSalePriceReviewType.QUARTERLY_REVIEW
    });
    prisma.vehicle.findUnique.mockResolvedValueOnce(makeVehicle());
    prisma.vehicleSalePriceHistory.findMany.mockResolvedValueOnce([history]);

    const result = await service.listSalePriceHistory("vehicle-1");

    expect(prisma.vehicleSalePriceHistory.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: "desc" },
      where: { vehicleId: "vehicle-1" }
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.reviewType).toBe(VehicleSalePriceReviewType.QUARTERLY_REVIEW);
    expect(result[0]?.beforeSalePriceAmount).toBe(14000000);
  });

  it("labels RETURN_REINIT sale price history in Chinese", () => {
    const labelsSource = fs.readFileSync(
      path.resolve(__dirname, "../../../apps/web/src/constants/labels.ts"),
      "utf8"
    );

    expect(labelsSource).toContain('RETURN_REINIT: "退车再入池重新定价"');
  });
});

const user: RequestUser = {
  id: "user-1",
  menus: [],
  name: "Admin",
  permissions: [],
  roles: ["ADMIN"],
  username: "admin"
};

const context: RequestContext = {
  ipAddress: "127.0.0.1",
  userAgent: "vitest"
};

function makeService() {
  const prisma = {
    $transaction: vi.fn(),
    vehicle: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn()
    },
    vehicleSalePriceHistory: {
      create: vi.fn(),
      findMany: vi.fn()
    }
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => callback(prisma));
  const auditService = {
    write: vi.fn()
  };

  return {
    auditService,
    prisma,
    service: new VehicleService(
      auditService as unknown as AuditService,
      prisma as unknown as PrismaService
    )
  };
}

type VehicleFixture = Vehicle & { salePriceHistories: VehicleSalePriceHistory[] };

function makeVehicle(overrides: Partial<VehicleFixture> = {}) {
  return {
    ...makeVehicleBase(),
    ...overrides
  };
}

function makeVehicleBase(): VehicleFixture {
  const now = new Date("2026-06-02T00:00:00.000Z");

  return {
    assetLocation: null,
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    createdAt: now,
    createdBy: "user-1",
    currentMileageKm: 0,
    currentSalePriceAmount: null,
    currentSalePriceInitializedAt: null,
    currentSalePriceReviewedAt: null,
    deletedAt: null,
    id: "vehicle-1",
    insuranceEndDate: null,
    insuranceStartDate: null,
    model: null,
    modelYear: null,
    nextSalePriceReviewAt: null,
    plateNo: null,
    purchaseDate: null,
    purchasePriceAmount: 16800000n,
    registrationDate: null,
    remark: null,
    salePriceHistories: [],
    salePriceReinitRequiredAt: null,
    salePriceStatus: SalePriceStatus.PENDING_INITIALIZE,
    series: null,
    status: VehicleStatus.DRAFT,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleModel: VehicleModel.ET5,
    vehicleNo: "VEH20260602000000A1B2",
    vin: null
  };
}

function makeHistory(overrides: Partial<VehicleSalePriceHistory> = {}) {
  return {
    ...makeHistoryBase(),
    ...overrides
  };
}

function makeHistoryBase(): VehicleSalePriceHistory {
  return {
    afterSalePriceAmount: 15000000n,
    beforeSalePriceAmount: null,
    createdAt: new Date("2026-06-02T00:00:00.000Z"),
    createdBy: "user-1",
    effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
    effectiveTo: null,
    id: "history-1",
    reason: "新入池初始化",
    remark: null,
    reviewQuarter: "2026Q2",
    reviewType: VehicleSalePriceReviewType.INITIAL_POOL,
    vehicleId: "vehicle-1"
  };
}
