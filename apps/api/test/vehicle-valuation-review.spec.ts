import {
  AuditAction,
  Prisma,
  ResidualForecastInterpolationMethod,
  SalePriceStatus,
  Vehicle,
  VehicleAcquisitionMode,
  VehicleBatteryUsageType,
  VehicleModel,
  VehicleResidualCurve,
  VehicleResidualCurveMethod,
  VehicleResidualCurveStatus,
  VehicleResidualForecast,
  VehicleResidualForecastMethod,
  VehicleResidualForecastPoint,
  VehicleResidualForecastPointStatus,
  VehicleResidualForecastStatus,
  VehicleSalePriceHistory,
  VehicleSalePriceReviewType,
  VehicleStatus,
  VehicleValuationReview,
  VehicleValuationReviewSource,
  VehicleValuationReviewStatus
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuditService } from "../src/audit/audit.service";
import { RequestContext, RequestUser } from "../src/auth/auth.types";
import { PrismaService } from "../src/prisma/prisma.service";
import { VehicleValuationReviewService } from "../src/vehicle-valuation-review/vehicle-valuation-review.service";

describe("VehicleValuationReviewService", () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    harness = makeHarness();
  });

  it("creates a valuation review from a residual forecast point without changing sale price or history", async () => {
    harness.state.forecastPoints[0] = makeForecastPoint({
      adoptedResidualAmount: 11800000n,
      pointStatus: VehicleResidualForecastPointStatus.ADOPTED
    });

    const result = await harness.service.createFromResidualForecast(
      "vehicle-1",
      {
        forecastPointId: "forecast-point-1",
        reason: "采用 12 个月残值预测作为当前估值复核参考",
        reviewRemark: "市场样本覆盖较好"
      },
      user,
      context
    );

    expect(result.reviewNo).toMatch(/^VVR\d{14}[A-Z0-9]{4}$/);
    expect(result.reviewSource).toBe(VehicleValuationReviewSource.RESIDUAL_FORECAST);
    expect(result.reviewStatus).toBe(VehicleValuationReviewStatus.PENDING);
    expect(result.originalSalePriceAmount).toBe(15000000);
    expect(result.forecastResidualAmount).toBe(12000000);
    expect(result.adoptedResidualAmount).toBe(11800000);
    expect(result.requestedSalePriceAmount).toBe(11800000);
    expect(harness.state.vehicles[0]?.currentSalePriceAmount).toBe(15000000n);
    expect(harness.state.histories).toHaveLength(0);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CREATE,
        entityType: "vehicle_valuation_review"
      })
    );
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("rejects forecast points that do not belong to the vehicle", async () => {
    harness.state.forecasts[0] = makeForecast({ vehicleId: "vehicle-2" });

    await expect(
      harness.service.createFromResidualForecast(
        "vehicle-1",
        { forecastPointId: "forecast-point-1" },
        user,
        context
      )
    ).rejects.toThrow("不属于当前车辆");
  });

  it("rejects unsupported points, missing amount points, non-positive requested amounts, and duplicate pending reviews", async () => {
    harness.state.forecastPoints[0] = makeForecastPoint({
      pointStatus: VehicleResidualForecastPointStatus.UNSUPPORTED
    });
    await expect(
      harness.service.createFromResidualForecast(
        "vehicle-1",
        { forecastPointId: "forecast-point-1" },
        user,
        context
      )
    ).rejects.toThrow("暂不支持");

    harness = makeHarness({
      forecastPoints: [makeForecastPoint({ adoptedResidualAmount: null, predictedResidualAmount: null })]
    });
    await expect(
      harness.service.createFromResidualForecast(
        "vehicle-1",
        { forecastPointId: "forecast-point-1" },
        user,
        context
      )
    ).rejects.toThrow("缺少可用");

    harness = makeHarness();
    await expect(
      harness.service.createFromResidualForecast(
        "vehicle-1",
        { forecastPointId: "forecast-point-1", requestedSalePriceAmount: 0 },
        user,
        context
      )
    ).rejects.toThrow("requestedSalePriceAmount");

    harness.state.reviews.push(makeReview());
    await expect(
      harness.service.createFromResidualForecast(
        "vehicle-1",
        { forecastPointId: "forecast-point-1" },
        user,
        context
      )
    ).rejects.toThrow("请勿重复发起");
  });

  it("lists vehicle reviews, global reviews, and review detail", async () => {
    harness.state.reviews.push(
      makeReview({ id: "review-1", reviewNo: "VVR20260601000000A1B2" }),
      makeReview({
        forecastPointId: "forecast-point-2",
        id: "review-2",
        requestedAt: new Date("2026-06-03T00:00:00.000Z"),
        reviewNo: "VVR20260603000000A1B2",
        vehicleId: "vehicle-2"
      })
    );
    harness.state.vehicles.push(makeVehicle({ id: "vehicle-2", vehicleNo: "VH20260602000000A1B2" }));

    const vehicleList = await harness.service.listVehicleReviews("vehicle-1", { page: 1, pageSize: 10 });
    expect(vehicleList.total).toBe(1);
    expect(vehicleList.items[0]?.reviewNo).toBe("VVR20260601000000A1B2");

    const globalList = await harness.service.listReviews({
      page: 1,
      pageSize: 10,
      reviewStatus: VehicleValuationReviewStatus.PENDING,
      vehicleNo: "VH20260602"
    });
    expect(globalList.total).toBe(1);
    expect(globalList.items[0]?.vehicle.vehicleNo).toBe("VH20260602000000A1B2");

    const detail = await harness.service.getReview("review-1");
    expect(detail.forecast?.forecastNo).toBe("VRF20260601000000A1B2");
    expect(detail.forecastPoint?.id).toBe("forecast-point-1");
    expect(detail.beforeSnapshot).toEqual(expect.objectContaining({ vehicleId: "vehicle-1" }));
    expect(() => JSON.stringify(detail)).not.toThrow();
  });

  it("approves a pending review, updates current sale price, writes sale price history, and audits the action", async () => {
    harness.state.reviews.push(makeReview());

    const result = await harness.service.approveReview(
      "review-1",
      {
        approvedSalePriceAmount: 12800000,
        reviewRemark: "审核通过，更新车辆当前销售价"
      },
      user,
      context
    );

    expect(harness.state.vehicles[0]?.currentSalePriceAmount).toBe(12800000n);
    expect(harness.state.vehicles[0]?.currentSalePriceReviewedAt).toBeInstanceOf(Date);
    expect(harness.state.vehicles[0]?.nextSalePriceReviewAt).toBeInstanceOf(Date);
    expect(harness.state.vehicles[0]?.salePriceStatus).toBe(SalePriceStatus.EFFECTIVE);
    expect(harness.state.histories).toHaveLength(1);
    expect(harness.state.histories[0]).toEqual(
      expect.objectContaining({
        afterSalePriceAmount: 12800000n,
        beforeSalePriceAmount: 15000000n,
        reviewType: VehicleSalePriceReviewType.RESIDUAL_FORECAST_ADOPTION,
        vehicleId: "vehicle-1"
      })
    );
    expect(result.reviewStatus).toBe(VehicleValuationReviewStatus.APPROVED);
    expect(result.approvedSalePriceAmount).toBe(12800000);
    expect(result.approvalSnapshot).toEqual(
      expect.objectContaining({ vehicleSalePriceHistoryId: "history-1" })
    );
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.APPROVE,
        after: expect.objectContaining({ vehicleSalePriceHistoryId: "history-1" }),
        entityType: "vehicle_valuation_review"
      })
    );
    expect(() => JSON.stringify(result)).not.toThrow();

    await expect(
      harness.service.approveReview(
        "review-1",
        { approvedSalePriceAmount: 12800000 },
        user,
        context
      )
    ).rejects.toThrow("待审核");
  });

  it("rejects a pending review without changing sale price or writing sale price history", async () => {
    harness.state.reviews.push(makeReview());

    const result = await harness.service.rejectReview(
      "review-1",
      { rejectReason: "样本置信度不足，暂不调整销售价" },
      user,
      context
    );

    expect(result.reviewStatus).toBe(VehicleValuationReviewStatus.REJECTED);
    expect(result.rejectReason).toBe("样本置信度不足，暂不调整销售价");
    expect(harness.state.vehicles[0]?.currentSalePriceAmount).toBe(15000000n);
    expect(harness.state.histories).toHaveLength(0);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.REJECT,
        entityType: "vehicle_valuation_review"
      })
    );
  });

  it("cancels a pending review without changing sale price or writing sale price history", async () => {
    harness.state.reviews.push(makeReview());

    const result = await harness.service.cancelReview(
      "review-1",
      { cancelReason: "误发起，取消" },
      user,
      context
    );

    expect(result.reviewStatus).toBe(VehicleValuationReviewStatus.CANCELLED);
    expect(result.cancelReason).toBe("误发起，取消");
    expect(harness.state.vehicles[0]?.currentSalePriceAmount).toBe(15000000n);
    expect(harness.state.histories).toHaveLength(0);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.UPDATE,
        entityType: "vehicle_valuation_review"
      })
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

type ReviewWithRelations = VehicleValuationReview & {
  forecast?: VehicleResidualForecast | null;
  forecastPoint?: VehicleResidualForecastPoint | null;
  vehicle?: Vehicle | null;
};

type ResidualReviewState = {
  curves: VehicleResidualCurve[];
  forecastPoints: VehicleResidualForecastPoint[];
  forecasts: VehicleResidualForecast[];
  histories: VehicleSalePriceHistory[];
  reviews: VehicleValuationReview[];
  vehicles: Vehicle[];
};

function makeHarness(seed: Partial<ResidualReviewState> = {}) {
  const state: ResidualReviewState = {
    curves: seed.curves ?? [makeCurve()],
    forecastPoints: seed.forecastPoints ?? [makeForecastPoint()],
    forecasts: seed.forecasts ?? [makeForecast()],
    histories: seed.histories ?? [],
    reviews: seed.reviews ?? [],
    vehicles: seed.vehicles ?? [makeVehicle()]
  };

  const prisma = {
    $transaction: vi.fn((input: unknown) => {
      if (Array.isArray(input)) {
        return Promise.all(input);
      }
      return (input as (tx: typeof prisma) => unknown)(prisma);
    }),
    vehicle: {
      findFirst: vi.fn(async (args: { select?: { id?: boolean }; where?: { id?: string; deletedAt?: null } }) => {
        const vehicle =
          state.vehicles.find(
            (candidate) =>
              (args.where?.id === undefined || candidate.id === args.where.id) &&
              (args.where?.deletedAt === undefined || candidate.deletedAt === args.where.deletedAt)
          ) ?? null;
        return args.select?.id && vehicle ? { id: vehicle.id } : vehicle;
      }),
      update: vi.fn(async (args: { data: Partial<Vehicle>; where: { id: string } }) => {
        const index = state.vehicles.findIndex((vehicle) => vehicle.id === args.where.id);
        const vehicle = { ...state.vehicles[index], ...args.data, updatedAt: new Date() } as Vehicle;
        state.vehicles[index] = vehicle;
        return vehicle;
      })
    },
    vehicleResidualForecastPoint: {
      findFirst: vi.fn(async (args: { where?: { id?: string } }) => {
        const point = state.forecastPoints.find((candidate) => candidate.id === args.where?.id) ?? null;
        return attachForecastPoint(point, state);
      })
    },
    vehicleSalePriceHistory: {
      create: vi.fn(async (args: { data: Omit<VehicleSalePriceHistory, "createdAt" | "id"> }) => {
        const history = {
          createdAt: new Date("2026-06-12T00:00:00.000Z"),
          id: `history-${state.histories.length + 1}`,
          ...args.data,
          effectiveTo: args.data.effectiveTo ?? null
        } as VehicleSalePriceHistory;
        state.histories.push(history);
        return history;
      })
    },
    vehicleValuationReview: {
      count: vi.fn(async (args: { where?: Prisma.VehicleValuationReviewWhereInput }) =>
        state.reviews.filter((review) => matchesReviewWhere(review, args.where, state)).length
      ),
      create: vi.fn(async (args: { data: Prisma.VehicleValuationReviewUncheckedCreateInput }) => {
        const now = new Date("2026-06-12T00:00:00.000Z");
        const review = {
          approvalSnapshot: null,
          approvedAt: null,
          approvedSalePriceAmount: null,
          cancelReason: null,
          cancelledAt: null,
          createdAt: now,
          deletedAt: null,
          id: `review-${state.reviews.length + 1}`,
          rejectedAt: null,
          rejectReason: null,
          reviewedAt: null,
          reviewedBy: null,
          updatedAt: now,
          ...args.data
        } as VehicleValuationReview;
        state.reviews.push(review);
        return attachReview(review, state);
      }),
      findFirst: vi.fn(async (args: { where?: Prisma.VehicleValuationReviewWhereInput }) => {
        const review = state.reviews.find((candidate) => matchesReviewWhere(candidate, args.where, state)) ?? null;
        return attachReview(review, state);
      }),
      findMany: vi.fn(async (args: { skip?: number; take?: number; where?: Prisma.VehicleValuationReviewWhereInput }) =>
        state.reviews
          .filter((review) => matchesReviewWhere(review, args.where, state))
          .sort((left, right) => right.requestedAt.getTime() - left.requestedAt.getTime())
          .slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? state.reviews.length))
          .map((review) => attachReview(review, state))
      ),
      update: vi.fn(async (args: { data: Partial<VehicleValuationReview>; where: { id: string } }) => {
        const index = state.reviews.findIndex((review) => review.id === args.where.id);
        const review = { ...state.reviews[index], ...args.data, updatedAt: new Date() } as VehicleValuationReview;
        state.reviews[index] = review;
        return attachReview(review, state);
      })
    }
  };
  const auditService = { write: vi.fn() };

  return {
    auditService,
    prisma,
    service: new VehicleValuationReviewService(
      auditService as unknown as AuditService,
      prisma as unknown as PrismaService
    ),
    state
  };
}

function attachReview(review: VehicleValuationReview | null, state: ResidualReviewState) {
  if (!review) {
    return null;
  }
  return {
    ...review,
    forecast: state.forecasts.find((forecast) => forecast.id === review.forecastId) ?? null,
    forecastPoint: state.forecastPoints.find((point) => point.id === review.forecastPointId) ?? null,
    vehicle: state.vehicles.find((vehicle) => vehicle.id === review.vehicleId) ?? null
  } as ReviewWithRelations;
}

function attachForecastPoint(point: VehicleResidualForecastPoint | null, state: ResidualReviewState) {
  if (!point) {
    return null;
  }
  const forecast = state.forecasts.find((candidate) => candidate.id === point.forecastId);
  return {
    ...point,
    forecast: {
      ...forecast,
      curve: state.curves.find((curve) => curve.id === forecast?.curveId),
      vehicle: state.vehicles.find((vehicle) => vehicle.id === forecast?.vehicleId)
    }
  };
}

function matchesReviewWhere(
  review: VehicleValuationReview,
  where: Prisma.VehicleValuationReviewWhereInput | undefined,
  state: ResidualReviewState
) {
  if (!where) {
    return true;
  }
  if (where.id !== undefined && review.id !== where.id) {
    return false;
  }
  if (where.deletedAt === null && review.deletedAt !== null) {
    return false;
  }
  if (where.vehicleId !== undefined && review.vehicleId !== where.vehicleId) {
    return false;
  }
  if (where.forecastPointId !== undefined && review.forecastPointId !== where.forecastPointId) {
    return false;
  }
  if (where.reviewStatus !== undefined && review.reviewStatus !== where.reviewStatus) {
    return false;
  }
  if (where.reviewSource !== undefined && review.reviewSource !== where.reviewSource) {
    return false;
  }
  if (where.requestedAt && typeof where.requestedAt === "object") {
    const range = where.requestedAt as Prisma.DateTimeFilter;
    if (range.gte && review.requestedAt < range.gte) {
      return false;
    }
    if (range.lt && review.requestedAt >= range.lt) {
      return false;
    }
  }
  if (where.vehicle && typeof where.vehicle === "object" && "is" in where.vehicle) {
    const vehicle = state.vehicles.find((candidate) => candidate.id === review.vehicleId);
    const vehicleWhere = where.vehicle.is as Prisma.VehicleWhereInput;
    if (vehicleWhere.vehicleNo && typeof vehicleWhere.vehicleNo === "object") {
      const contains = (vehicleWhere.vehicleNo as Prisma.StringFilter).contains;
      if (contains && !vehicle?.vehicleNo.includes(contains)) {
        return false;
      }
    }
    if (vehicleWhere.vin && typeof vehicleWhere.vin === "object") {
      const contains = (vehicleWhere.vin as Prisma.StringNullableFilter).contains;
      if (contains && !vehicle?.vin?.includes(contains)) {
        return false;
      }
    }
  }
  return true;
}

function makeReview(overrides: Partial<VehicleValuationReview> = {}): VehicleValuationReview {
  const now = new Date("2026-06-01T00:00:00.000Z");
  return {
    adoptedResidualAmount: null,
    approvalSnapshot: null,
    approvedAt: null,
    approvedSalePriceAmount: null,
    beforeSnapshot: { vehicleId: "vehicle-1" } as Prisma.JsonValue,
    cancelReason: null,
    cancelledAt: null,
    createdAt: now,
    createdBy: user.id,
    deletedAt: null,
    forecastAmountSource: "PREDICTED_RESIDUAL",
    forecastConfidenceScore: 80,
    forecastHorizonMonth: 0,
    forecastId: "forecast-1",
    forecastPointId: "forecast-point-1",
    forecastResidualAmount: 12000000n,
    forecastSnapshot: { forecastPointId: "forecast-point-1" } as Prisma.JsonValue,
    forecastTargetDate: new Date("2026-06-01T00:00:00.000Z"),
    id: "review-1",
    originalSalePriceAmount: 15000000n,
    reason: "residual forecast review",
    rejectedAt: null,
    rejectReason: null,
    requestedAt: now,
    requestedBy: user.id,
    requestedSalePriceAmount: 12000000n,
    reviewedAt: null,
    reviewedBy: null,
    reviewNo: "VVR20260601000000A1B2",
    reviewRemark: "review remark",
    reviewSource: VehicleValuationReviewSource.RESIDUAL_FORECAST,
    reviewStatus: VehicleValuationReviewStatus.PENDING,
    snapshot: null,
    updatedAt: now,
    updatedBy: user.id,
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function makeForecastPoint(overrides: Partial<VehicleResidualForecastPoint> = {}): VehicleResidualForecastPoint {
  return {
    adoptedAt: null,
    adoptedBy: null,
    adoptedResidualAmount: null,
    adoptRemark: null,
    confidenceScore: 80,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    forecastId: "forecast-1",
    horizonMonth: 0,
    id: "forecast-point-1",
    interpolationMethod: ResidualForecastInterpolationMethod.EXACT,
    lowerBoundAmount: 11000000n,
    matchedCurvePointAgeMonth: 24,
    pointSnapshot: null,
    pointStatus: VehicleResidualForecastPointStatus.GENERATED,
    predictedResidualAmount: 12000000n,
    predictedResidualRateBps: 6000,
    targetAgeMonth: 24,
    targetDate: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    upperBoundAmount: 13000000n,
    ...overrides
  };
}

function makeForecast(overrides: Partial<VehicleResidualForecast> = {}): VehicleResidualForecast {
  return {
    asOfDate: new Date("2026-06-01T00:00:00.000Z"),
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    createdBy: user.id,
    curveId: "curve-1",
    curveSnapshot: null,
    currentMileageKm: 25000,
    currentSalePriceAmount: 15000000n,
    deletedAt: null,
    forecastMethod: VehicleResidualForecastMethod.CURVE_STATISTICAL,
    forecastNo: "VRF20260601000000A1B2",
    forecastStatus: VehicleResidualForecastStatus.GENERATED,
    id: "forecast-1",
    inputSnapshot: null,
    metrics: null,
    model: "ET5",
    modelYear: 2024,
    purchasePriceAmount: 20000000n,
    remark: null,
    series: "ET5",
    trim: null,
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedBy: user.id,
    vehicleAgeMonths: 24,
    vehicleId: "vehicle-1",
    vehicleSnapshot: null,
    ...overrides
  };
}

function makeCurve(overrides: Partial<VehicleResidualCurve> = {}): VehicleResidualCurve {
  return {
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    confidenceScore: 80,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    createdBy: user.id,
    curveMethod: VehicleResidualCurveMethod.STATISTICAL_MEDIAN,
    curveName: "NIO ET5 2024",
    curveNo: "RVC20260601000000A1B2",
    curveStatus: VehicleResidualCurveStatus.ACTIVE,
    curveVersion: null,
    deletedAt: null,
    effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
    effectiveTo: null,
    generatedAt: new Date("2026-06-01T00:00:00.000Z"),
    id: "curve-1",
    metrics: null,
    model: "ET5",
    modelYear: 2024,
    pointCount: 1,
    priceTypes: ["TRANSACTION"],
    referencePriceAmount: 12000000n,
    remark: null,
    sampleCount: 3,
    sampleEndDate: null,
    sampleFilterSnapshot: null,
    sampleStartDate: null,
    series: "ET5",
    snapshot: null,
    trim: null,
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedBy: user.id,
    ...overrides
  };
}

function makeVehicle(overrides: Partial<Vehicle> = {}): Vehicle {
  return {
    acquisitionMode: VehicleAcquisitionMode.OWNED_CASH,
    assetLocation: "Shanghai",
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    createdBy: user.id,
    currentMileageKm: 25000,
    currentSalePriceAmount: 15000000n,
    currentSalePriceInitializedAt: new Date("2026-06-01T00:00:00.000Z"),
    currentSalePriceReviewedAt: new Date("2026-06-01T00:00:00.000Z"),
    deletedAt: null,
    id: "vehicle-1",
    insuranceEndDate: null,
    insuranceStartDate: null,
    latestRegistrationDate: null,
    model: "ET5",
    modelYear: 2024,
    nextSalePriceReviewAt: new Date("2026-09-01T00:00:00.000Z"),
    plateNo: "沪A12345",
    purchaseDate: new Date("2024-06-01T00:00:00.000Z"),
    purchasePriceAmount: 20000000n,
    registrationDate: new Date("2024-06-01T00:00:00.000Z"),
    remark: null,
    salePriceReinitRequiredAt: null,
    salePriceStatus: SalePriceStatus.EFFECTIVE,
    series: "ET5",
    status: VehicleStatus.AVAILABLE,
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedBy: user.id,
    vehicleModel: VehicleModel.ET5,
    vehicleNo: "VH20260601000000A1B2",
    vin: "LJ1TEST0000000001",
    ...overrides
  };
}
