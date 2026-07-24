import fs from "node:fs";
import path from "node:path";

import {
  AuditAction,
  Prisma,
  SalePriceStatus,
  Vehicle,
  VehicleAcquisitionMode,
  VehicleAssetCostProfile,
  VehicleAssetCostProfileStatus,
  VehicleBatteryUsageType,
  VehicleDepreciationMethod,
  VehicleInsurancePolicyStatus,
  VehicleInsurancePolicyType,
  VehicleSalePriceHistory,
  VehicleSalePriceReviewType,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { VehicleModel } from "./helpers/vehicle-model-codes";

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
        modelDefinitionId: "definition-et5",
        purchasePriceAmount: 16800000,
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
          modelDefinitionId: "definition-et5",
          purchasePriceAmount: 16800000,
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
          modelDefinitionId: "definition-et5",
          purchasePriceAmount: 16800000,
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
          modelDefinitionId: "definition-et5",
          purchasePriceAmount: 16800000,
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

  it("derives current compulsory and commercial coverage from policy records", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T08:00:00.000Z"));
    const { prisma, service } = makeService();
    prisma.vehicle.findMany.mockResolvedValueOnce([
      {
        ...makeVehicle(),
        insurancePolicies: [
          {
            deletedAt: null,
            effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
            effectiveTo: new Date("2027-06-30T00:00:00.000Z"),
            id: "policy-compulsory",
            policyStatus: VehicleInsurancePolicyStatus.ACTIVE,
            policyType: VehicleInsurancePolicyType.COMPULSORY_TRAFFIC
          },
          {
            deletedAt: null,
            effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
            effectiveTo: new Date("2027-06-30T00:00:00.000Z"),
            id: "policy-commercial",
            policyStatus: VehicleInsurancePolicyStatus.ACTIVE,
            policyType: VehicleInsurancePolicyType.COMMERCIAL
          }
        ]
      }
    ]);

    try {
      const result = await service.listVehicles();

      expect(result[0]?.insuranceCoverage).toMatchObject({
        commercial: {
          covered: true,
          effectiveFrom: "2026-07-01",
          effectiveTo: "2027-06-30"
        },
        compulsoryTraffic: {
          covered: true,
          effectiveFrom: "2026-07-01",
          effectiveTo: "2027-06-30"
        },
        covered: true,
        evaluatedAt: "2026-07-24"
      });
    } finally {
      vi.useRealTimers();
    }
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

describe("VehicleService asset cost profile", () => {
  it("returns null when a vehicle has no active asset cost profile", async () => {
    const { prisma, service } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce(makeVehicle());
    prisma.vehicleAssetCostProfile.findFirst.mockResolvedValueOnce(null);

    await expect(service.getAssetCostProfile("vehicle-1")).resolves.toBeNull();
  });

  it("returns null preview when a vehicle has no active asset cost profile", async () => {
    const { prisma, service } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce(makeVehicle());
    prisma.vehicleAssetCostProfile.findFirst.mockResolvedValueOnce(null);

    await expect(service.getAssetCostProfilePreview("vehicle-1")).resolves.toEqual({
      preview: null,
      profile: null
    });
  });

  it("creates an ACTIVE asset cost profile with default depreciation start date and audit log", async () => {
    const { auditService, prisma, service } = makeService();
    const vehicle = makeVehicle({
      salePriceHistories: [
        makeHistory({ effectiveFrom: new Date("2026-06-01T00:00:00.000Z") }),
        makeHistory({ effectiveFrom: new Date("2026-05-20T00:00:00.000Z"), id: "history-0" })
      ]
    });
    const profile = makeAssetCostProfile({
      depreciationStartDate: new Date("2026-05-20T00:00:00.000Z"),
      residualValueAmount: 6000000n
    });

    prisma.vehicle.findUnique.mockResolvedValueOnce(vehicle);
    prisma.vehicleAssetCostProfile.findFirst.mockResolvedValueOnce(null);
    prisma.vehicleAssetCostProfile.create.mockResolvedValueOnce(profile);

    const result = await service.upsertAssetCostProfile(
      "vehicle-1",
      validAssetCostProfileDto({ depreciationStartDate: undefined, residualValueAmount: 6000000 }),
      user,
      context
    );

    expect(prisma.vehicleAssetCostProfile.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        createdBy: user.id,
        depreciationMethod: VehicleDepreciationMethod.STRAIGHT_LINE,
        depreciationStartDate: new Date("2026-05-20T00:00:00.000Z"),
        profileStatus: VehicleAssetCostProfileStatus.ACTIVE,
        residualValueAmount: 6000000n,
        updatedBy: user.id,
        vehicleId: "vehicle-1"
      })
    });
    expect(result.profileStatus).toBe(VehicleAssetCostProfileStatus.ACTIVE);
    expect(result.residualValueAmount).toBe(6000000);
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CREATE,
        entityType: "vehicle_asset_cost_profile"
      })
    );
  });

  it("updates the existing ACTIVE asset cost profile instead of creating another one", async () => {
    const { prisma, service } = makeService();
    const before = makeAssetCostProfile({ residualValueAmount: 3000000n });
    const after = makeAssetCostProfile({ residualValueAmount: 5000000n });

    prisma.vehicle.findUnique.mockResolvedValueOnce(makeVehicle());
    prisma.vehicleAssetCostProfile.findFirst.mockResolvedValueOnce(before);
    prisma.vehicleAssetCostProfile.update.mockResolvedValueOnce(after);

    const result = await service.upsertAssetCostProfile(
      "vehicle-1",
      validAssetCostProfileDto({ residualValueAmount: 5000000 }),
      user,
      context
    );

    expect(prisma.vehicleAssetCostProfile.create).not.toHaveBeenCalled();
    expect(prisma.vehicleAssetCostProfile.update).toHaveBeenCalledWith({
      data: expect.objectContaining({
        residualValueAmount: 5000000n,
        updatedBy: user.id
      }),
      where: { id: before.id }
    });
    expect(result.id).toBe(after.id);
    expect(result.residualValueAmount).toBe(5000000);
  });

  it("rejects usefulLifeMonths <= 0", async () => {
    const { prisma, service } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce(makeVehicle());

    await expect(
      service.upsertAssetCostProfile(
        "vehicle-1",
        validAssetCostProfileDto({ usefulLifeMonths: 0 }),
        user,
        context
      )
    ).rejects.toThrow("预计使用月数必须大于 0");
  });

  it("rejects residualValueAmount greater than purchasePriceAmount", async () => {
    const { prisma, service } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce(makeVehicle({ purchasePriceAmount: 1000000n }));

    await expect(
      service.upsertAssetCostProfile(
        "vehicle-1",
        validAssetCostProfileDto({ residualValueAmount: 1000001 }),
        user,
        context
      )
    ).rejects.toThrow("预计残值不能大于车辆采购价");
  });

  it("rejects missing purchase price when setting residual value", async () => {
    const { prisma, service } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce(makeVehicle({ purchasePriceAmount: 0n }));

    await expect(
      service.upsertAssetCostProfile("vehicle-1", validAssetCostProfileDto(), user, context)
    ).rejects.toThrow("车辆采购价缺失，无法设置残值参数。");
  });

  it.each([
    ["residualValueAmount", { residualValueAmount: -1 }, "预计残值必须大于等于 0"],
    ["annualInsuranceCostAmount", { annualInsuranceCostAmount: -1 }, "年度保险成本必须大于等于 0"],
    [
      "annualMaintenanceReserveAmount",
      { annualMaintenanceReserveAmount: -1 },
      "年度维修准备金必须大于等于 0"
    ],
    ["otherMonthlyCostAmount", { otherMonthlyCostAmount: -1 }, "其他月度成本必须大于等于 0"],
    ["capitalCostRateBps", { capitalCostRateBps: -1 }, "资金成本率必须大于等于 0"]
  ])("rejects negative %s", async (_field, overrides, message) => {
    const { prisma, service } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce(makeVehicle());

    await expect(
      service.upsertAssetCostProfile(
        "vehicle-1",
        validAssetCostProfileDto(overrides),
        user,
        context
      )
    ).rejects.toThrow(message);
  });

  it("calculates STRAIGHT_LINE preview amounts with rounded monthly cost", async () => {
    const { prisma, service } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce(makeVehicle({ purchasePriceAmount: 12000000n }));
    prisma.vehicleAssetCostProfile.findFirst.mockResolvedValueOnce(
      makeAssetCostProfile({
        annualInsuranceCostAmount: 120000n,
        annualMaintenanceReserveAmount: 240000n,
        capitalCostRateBps: 600,
        otherMonthlyCostAmount: 5000n,
        residualValueAmount: 2400000n,
        usefulLifeMonths: 48
      })
    );

    const result = await service.getAssetCostProfilePreview("vehicle-1");

    expect(result.preview).toEqual({
      annualCapitalCostAmount: 720000,
      depreciableAmount: 9600000,
      estimatedMonthlyCostAmount: 295000,
      monthlyCapitalCostAmount: 60000,
      monthlyDepreciationAmount: 200000,
      monthlyInsuranceCostAmount: 10000,
      monthlyMaintenanceReserveAmount: 20000,
      otherMonthlyCostAmount: 5000,
      purchasePriceAmount: 12000000,
      residualValueAmount: 2400000
    });
  });

  it("calculates NONE depreciation as zero", async () => {
    const { prisma, service } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce(makeVehicle({ purchasePriceAmount: 12000000n }));
    prisma.vehicleAssetCostProfile.findFirst.mockResolvedValueOnce(
      makeAssetCostProfile({
        annualInsuranceCostAmount: null,
        annualMaintenanceReserveAmount: null,
        capitalCostRateBps: null,
        depreciationMethod: VehicleDepreciationMethod.NONE,
        otherMonthlyCostAmount: null,
        residualValueAmount: 2400000n
      })
    );

    const result = await service.getAssetCostProfilePreview("vehicle-1");

    expect(result.preview?.monthlyDepreciationAmount).toBe(0);
    expect(result.preview?.estimatedMonthlyCostAmount).toBe(0);
  });

  it("calculates MANUAL depreciation as null and leaves estimated monthly cost null", async () => {
    const { prisma, service } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce(makeVehicle({ purchasePriceAmount: 12000000n }));
    prisma.vehicleAssetCostProfile.findFirst.mockResolvedValueOnce(
      makeAssetCostProfile({
        annualInsuranceCostAmount: 120000n,
        depreciationMethod: VehicleDepreciationMethod.MANUAL,
        residualValueAmount: 2400000n
      })
    );

    const result = await service.getAssetCostProfilePreview("vehicle-1");

    expect(result.preview?.monthlyDepreciationAmount).toBeNull();
    expect(result.preview?.estimatedMonthlyCostAmount).toBeNull();
  });

  it("keeps the database-level partial unique index for one ACTIVE profile per vehicle", () => {
    const migration = fs.readFileSync(
      path.resolve(
        __dirname,
        "../prisma/migrations/20260608120000_vehicle_asset_cost_profile/migration.sql"
      ),
      "utf8"
    );

    expect(migration).toContain("vehicle_asset_cost_profile_active_vehicle_key");
    expect(migration).toContain(
      "WHERE \"deleted_at\" IS NULL AND \"profile_status\" = 'ACTIVE'"
    );
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
  const defaultModelDefinition = {
    brand: "NIO",
    customerDisplayName: "ET5",
    displayName: "ET5",
    enabled: true,
    id: "definition-et5",
    legacyVehicleModel: VehicleModel.ET5,
    modelCode: "ET5",
    modelName: "ET5",
    modelYear: null,
    series: "ET"
  };
  const prisma = {
    $transaction: vi.fn(),
    vehicle: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn()
    },
    vehicleAssetCostProfile: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn()
    },
    vehicleSalePriceHistory: {
      create: vi.fn(),
      findMany: vi.fn()
    },
    vehicleModelDefinition: {
      findFirst: vi.fn(async ({ where }: { where: { deletedAt?: null; id?: string; legacyVehicleModel?: VehicleModel } }) => {
        if (where.deletedAt === null && where.legacyVehicleModel === VehicleModel.ET5) {
          return defaultModelDefinition;
        }
        if (where.deletedAt === null && where.id === defaultModelDefinition.id) {
          return defaultModelDefinition;
        }
        return null;
      })
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
    acquisitionMode: VehicleAcquisitionMode.OWNED_CASH,
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
    model: null,
    modelYear: null,
    nextSalePriceReviewAt: null,
    plateNo: null,
    purchaseDate: null,
    purchasePriceAmount: 16800000n,
    registrationDate: null,
    latestRegistrationDate: null,
    remark: null,
    salePriceHistories: [],
    salePriceReinitRequiredAt: null,
    salePriceStatus: SalePriceStatus.PENDING_INITIALIZE,
    series: null,
    status: VehicleStatus.DRAFT,
    updatedAt: now,
    updatedBy: "user-1",
    modelDefinitionId: null,
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

function validAssetCostProfileDto(
  overrides: Partial<Parameters<VehicleService["upsertAssetCostProfile"]>[1]> = {}
) {
  return {
    annualInsuranceCostAmount: 120000,
    annualMaintenanceReserveAmount: 240000,
    capitalCostRateBps: 600,
    depreciationMethod: VehicleDepreciationMethod.STRAIGHT_LINE,
    depreciationStartDate: "2026-06-01",
    otherMonthlyCostAmount: 5000,
    remark: "asset cost profile",
    residualValueAmount: 2400000,
    usefulLifeMonths: 48,
    ...overrides
  };
}

function makeAssetCostProfile(overrides: Partial<VehicleAssetCostProfile> = {}) {
  const now = new Date("2026-06-02T00:00:00.000Z");

  return {
    annualInsuranceCostAmount: 120000n,
    annualMaintenanceReserveAmount: 240000n,
    capitalCostRateBps: 600,
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    depreciationMethod: VehicleDepreciationMethod.STRAIGHT_LINE,
    depreciationStartDate: new Date("2026-06-01T00:00:00.000Z"),
    id: "asset-cost-profile-1",
    otherMonthlyCostAmount: 5000n,
    profileStatus: VehicleAssetCostProfileStatus.ACTIVE,
    remark: "asset cost profile",
    residualValueAmount: 2400000n,
    snapshot: null,
    updatedAt: now,
    updatedBy: "user-1",
    usefulLifeMonths: 48,
    vehicleId: "vehicle-1",
    ...overrides
  };
}
