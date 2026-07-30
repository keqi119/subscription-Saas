import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  AuditAction,
  Prisma,
  SalePriceStatus,
  Vehicle,
  VehicleModelDefinition,
  VehicleResidualForecastPointStatus,
  VehicleSalePriceHistory,
  VehicleSalePriceReviewType,
  VehicleValuationReviewSource,
  VehicleValuationReviewStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import {
  ApproveVehicleValuationReviewDto,
  CancelVehicleValuationReviewDto,
  CreateValuationReviewFromResidualForecastDto,
  RejectVehicleValuationReviewDto,
  VehicleValuationReviewQueryDto
} from "./dto/vehicle-valuation-review.dto";

const REVIEW_ENTITY_TYPE = "vehicle_valuation_review";
const REVIEW_MODULE = "vehicle_valuation_review";
const REVIEW_NO_PREFIX = "VVR";

const modelDefinitionSelect = {
  brand: true,
  customerDisplayName: true,
  displayName: true,
  id: true,
  modelCode: true,
  modelName: true,
  modelYear: true,
  series: true
} satisfies Prisma.VehicleModelDefinitionSelect;

const reviewInclude = {
  forecast: true,
  forecastPoint: true,
  vehicle: {
    include: {
      modelDefinition: { select: modelDefinitionSelect }
    }
  }
} satisfies Prisma.VehicleValuationReviewInclude;

const forecastPointInclude = {
  forecast: {
    include: {
      curve: true,
      vehicle: {
        include: {
          modelDefinition: { select: modelDefinitionSelect }
        }
      }
    }
  }
} satisfies Prisma.VehicleResidualForecastPointInclude;

type ModelDefinitionSummary = Pick<
  VehicleModelDefinition,
  "brand" | "customerDisplayName" | "displayName" | "id" | "modelCode" | "modelName" | "modelYear" | "series"
>;

type VehicleWithModelDefinition = Vehicle & {
  modelDefinition?: ModelDefinitionSummary | null;
};

type ReviewWithRelations = Prisma.VehicleValuationReviewGetPayload<{
  include: typeof reviewInclude;
}>;

type ForecastPointWithRelations = Prisma.VehicleResidualForecastPointGetPayload<{
  include: typeof forecastPointInclude;
}>;

@Injectable()
export class VehicleValuationReviewService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService
  ) {}

  async createFromResidualForecast(
    vehicleId: string,
    dto: CreateValuationReviewFromResidualForecastDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const vehicle = await this.findVehicleOrThrow(vehicleId);
    const point = await this.findForecastPointOrThrow(dto.forecastPointId);

    if (point.forecast.vehicleId !== vehicleId) {
      throw new BadRequestException("该预测点不属于当前车辆，不能发起车辆估值复核。");
    }

    if (point.pointStatus === VehicleResidualForecastPointStatus.UNSUPPORTED) {
      throw new BadRequestException("暂不支持的预测点不能发起车辆估值复核。");
    }

    const defaultRequestedAmount = point.adoptedResidualAmount ?? point.predictedResidualAmount;
    if (defaultRequestedAmount === null) {
      throw new BadRequestException("预测点缺少可用的预测或采用残值金额，不能发起车辆估值复核。");
    }

    if (defaultRequestedAmount <= 0n) {
      throw new BadRequestException("预测点残值金额必须大于 0。");
    }

    const requestedSalePriceAmount =
      dto.requestedSalePriceAmount === undefined || dto.requestedSalePriceAmount === null
        ? defaultRequestedAmount
        : requiredFenAmount(dto.requestedSalePriceAmount, "requestedSalePriceAmount");

    const existingPending = await this.prisma.vehicleValuationReview.findFirst({
      select: { id: true },
      where: {
        deletedAt: null,
        forecastPointId: point.id,
        reviewStatus: VehicleValuationReviewStatus.PENDING,
        vehicleId
      }
    });

    if (existingPending) {
      throw new BadRequestException("该预测点已存在待审核的车辆估值复核，请勿重复发起。");
    }

    const amountSource =
      point.adoptedResidualAmount === null ? "PREDICTED_RESIDUAL" : "ADOPTED_RESIDUAL";
    const requestedAt = new Date();
    const createData: Omit<Prisma.VehicleValuationReviewUncheckedCreateInput, "reviewNo"> = {
      adoptedResidualAmount: point.adoptedResidualAmount,
      beforeSnapshot: toJsonObject(vehicleBeforeSnapshot(vehicle)),
      createdBy: user.id,
      forecastAmountSource: amountSource,
      forecastConfidenceScore: point.confidenceScore,
      forecastHorizonMonth: point.horizonMonth,
      forecastId: point.forecastId,
      forecastPointId: point.id,
      forecastResidualAmount: point.predictedResidualAmount,
      forecastSnapshot: toJsonObject(forecastPointSnapshot(point, amountSource)),
      forecastTargetDate: point.targetDate,
      originalSalePriceAmount: vehicle.currentSalePriceAmount,
      reason: normalizeOptionalText(dto.reason),
      requestedAt,
      requestedBy: user.id,
      requestedSalePriceAmount,
      reviewRemark: normalizeOptionalText(dto.reviewRemark),
      reviewSource: VehicleValuationReviewSource.RESIDUAL_FORECAST,
      reviewStatus: VehicleValuationReviewStatus.PENDING,
      snapshot: toJsonObject({
        adoptedResidualAmount: numberOrNull(point.adoptedResidualAmount),
        amountSource,
        forecastPointId: point.id,
        forecastResidualAmount: numberOrNull(point.predictedResidualAmount),
        originalSalePriceAmount: numberOrNull(vehicle.currentSalePriceAmount),
        requestedSalePriceAmount: Number(requestedSalePriceAmount),
        vehicleId
      }),
      updatedBy: user.id,
      vehicleId
    };

    const review = await withUniqueBusinessNoRetry(async () =>
      this.prisma.vehicleValuationReview.create({
        data: {
          ...createData,
          reviewNo: createBusinessNo(REVIEW_NO_PREFIX)
        },
        include: reviewInclude
      })
    );

    await this.writeReviewAudit(
      AuditAction.CREATE,
      review.id,
      undefined,
      toReviewDetailView(review),
      user,
      context,
      reviewAuditPayload(review)
    );

    return toReviewDetailView(review);
  }

  async listVehicleReviews(vehicleId: string, query: VehicleValuationReviewQueryDto) {
    await this.assertVehicleExists(vehicleId);
    return this.listReviews({ ...query, vehicleId });
  }

  async listReviews(query: VehicleValuationReviewQueryDto) {
    const { page, pageSize, skip, take } = normalizePagination(query);
    const where = buildReviewWhere(query);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.vehicleValuationReview.findMany({
        include: reviewInclude,
        orderBy: [{ requestedAt: "desc" }, { createdAt: "desc" }],
        skip,
        take,
        where
      }),
      this.prisma.vehicleValuationReview.count({ where })
    ]);

    return {
      items: items.map(toReviewListItemView),
      page,
      pageSize,
      total
    };
  }

  async getReview(id: string) {
    const review = await this.findReviewOrThrow(id);
    return toReviewDetailView(review);
  }

  async approveReview(
    id: string,
    dto: ApproveVehicleValuationReviewDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const approvedSalePriceAmount = requiredFenAmount(
      dto.approvedSalePriceAmount,
      "approvedSalePriceAmount"
    );
    const before = await this.findReviewOrThrow(id);
    assertPendingReview(before);

    const approvedAt = new Date();
    const effectiveFrom = dateOnlyFromDate(approvedAt);
    const nextSalePriceReviewAt = addMonths(effectiveFrom, 3);
    const reviewRemark = normalizeOptionalText(dto.reviewRemark) ?? before.reviewRemark;

    const result = await this.prisma.$transaction(async (tx) => {
      const vehicle = await tx.vehicle.update({
        data: {
          currentSalePriceAmount: approvedSalePriceAmount,
          currentSalePriceReviewedAt: approvedAt,
          nextSalePriceReviewAt,
          salePriceStatus: SalePriceStatus.EFFECTIVE,
          updatedBy: user.id
        },
        where: { id: before.vehicleId }
      });

      const history = await tx.vehicleSalePriceHistory.create({
        data: {
          afterSalePriceAmount: approvedSalePriceAmount,
          beforeSalePriceAmount: before.originalSalePriceAmount,
          createdBy: user.id,
          effectiveFrom,
          reason: reviewRemark ?? before.reason ?? "残值预测采用复核通过",
          remark: reviewRemark,
          reviewQuarter: toReviewQuarter(effectiveFrom),
          reviewType: VehicleSalePriceReviewType.RESIDUAL_FORECAST_ADOPTION,
          vehicleId: before.vehicleId
        }
      });

      const approvalSnapshot = approvalReviewSnapshot(before, vehicle, history, approvedAt, reviewRemark);

      const review = await tx.vehicleValuationReview.update({
        data: {
          approvalSnapshot: toJsonObject(approvalSnapshot),
          approvedAt,
          approvedSalePriceAmount,
          reviewedAt: approvedAt,
          reviewedBy: user.id,
          reviewRemark,
          reviewStatus: VehicleValuationReviewStatus.APPROVED,
          updatedBy: user.id
        },
        include: reviewInclude,
        where: { id }
      });

      return { history, review, vehicle };
    });

    await this.writeReviewAudit(
      AuditAction.APPROVE,
      id,
      toReviewDetailView(before),
      toReviewDetailView(result.review),
      user,
      context,
      {
        ...reviewAuditPayload(result.review),
        approvedSalePriceAmount: Number(approvedSalePriceAmount),
        reviewRemark,
        vehicleSalePriceHistoryId: result.history.id
      }
    );
    await this.writeVehicleAudit(before.vehicle, result.vehicle, user, context);
    await this.writeSalePriceHistoryAudit(result.history, user, context);

    return toReviewDetailView(result.review);
  }

  async rejectReview(
    id: string,
    dto: RejectVehicleValuationReviewDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findReviewOrThrow(id);
    assertPendingReview(before);

    const rejectedAt = new Date();
    const rejectReason = requiredText(dto.rejectReason, "rejectReason");
    const review = await this.prisma.vehicleValuationReview.update({
      data: {
        rejectedAt,
        rejectReason,
        reviewedAt: rejectedAt,
        reviewedBy: user.id,
        reviewStatus: VehicleValuationReviewStatus.REJECTED,
        updatedBy: user.id
      },
      include: reviewInclude,
      where: { id }
    });

    await this.writeReviewAudit(
      AuditAction.REJECT,
      id,
      toReviewDetailView(before),
      toReviewDetailView(review),
      user,
      context,
      {
        ...reviewAuditPayload(review),
        rejectReason
      }
    );

    return toReviewDetailView(review);
  }

  async cancelReview(
    id: string,
    dto: CancelVehicleValuationReviewDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findReviewOrThrow(id);
    assertPendingReview(before);

    const cancelledAt = new Date();
    const cancelReason = requiredText(dto.cancelReason, "cancelReason");
    const review = await this.prisma.vehicleValuationReview.update({
      data: {
        cancelReason,
        cancelledAt,
        reviewStatus: VehicleValuationReviewStatus.CANCELLED,
        updatedBy: user.id
      },
      include: reviewInclude,
      where: { id }
    });

    await this.writeReviewAudit(
      AuditAction.UPDATE,
      id,
      toReviewDetailView(before),
      toReviewDetailView(review),
      user,
      context,
      {
        ...reviewAuditPayload(review),
        cancelReason
      }
    );

    return toReviewDetailView(review);
  }

  private async findVehicleOrThrow(id: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      include: {
        modelDefinition: { select: modelDefinitionSelect }
      },
      where: { deletedAt: null, id }
    });

    if (!vehicle) {
      throw new NotFoundException("车辆不存在。");
    }

    return vehicle;
  }

  private async assertVehicleExists(id: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      select: { id: true },
      where: { deletedAt: null, id }
    });

    if (!vehicle) {
      throw new NotFoundException("车辆不存在。");
    }
  }

  private async findForecastPointOrThrow(id: string) {
    const point = await this.prisma.vehicleResidualForecastPoint.findFirst({
      include: forecastPointInclude,
      where: { id }
    });

    if (!point || point.forecast.deletedAt !== null) {
      throw new NotFoundException("车辆残值预测点不存在。");
    }

    return point;
  }

  private async findReviewOrThrow(id: string) {
    const review = await this.prisma.vehicleValuationReview.findFirst({
      include: reviewInclude,
      where: { deletedAt: null, id }
    });

    if (!review) {
      throw new NotFoundException("车辆估值复核不存在。");
    }

    return review;
  }

  private async writeReviewAudit(
    action: AuditAction,
    entityId: string,
    before: unknown,
    after: unknown,
    user: RequestUser,
    context: RequestContext,
    payload: Record<string, unknown>
  ) {
    await this.auditService.write({
      action,
      after: { ...payload, after },
      before: before === undefined ? undefined : { ...payload, before },
      entityId,
      entityType: REVIEW_ENTITY_TYPE,
      ipAddress: context.ipAddress,
      module: REVIEW_MODULE,
      operatorId: user.id,
      userAgent: context.userAgent
    });
  }

  private async writeVehicleAudit(
    before: Vehicle,
    after: Vehicle,
    user: RequestUser,
    context: RequestContext
  ) {
    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toVehicleSummary(after),
      before: toVehicleSummary(before),
      entityId: after.id,
      entityType: "vehicle",
      ipAddress: context.ipAddress,
      module: "vehicle",
      operatorId: user.id,
      userAgent: context.userAgent
    });
  }

  private async writeSalePriceHistoryAudit(
    history: VehicleSalePriceHistory,
    user: RequestUser,
    context: RequestContext
  ) {
    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toSalePriceHistoryView(history),
      entityId: history.id,
      entityType: "vehicle_sale_price_history",
      ipAddress: context.ipAddress,
      module: "vehicle",
      operatorId: user.id,
      userAgent: context.userAgent
    });
  }
}

function buildReviewWhere(query: VehicleValuationReviewQueryDto): Prisma.VehicleValuationReviewWhereInput {
  const where: Prisma.VehicleValuationReviewWhereInput = {
    deletedAt: null,
    reviewSource: query.reviewSource,
    reviewStatus: query.reviewStatus,
    vehicleId: query.vehicleId
  };

  const vehicleWhere: Prisma.VehicleWhereInput = {};
  if (query.vehicleNo) {
    vehicleWhere.vehicleNo = { contains: query.vehicleNo };
  }
  if (query.vin) {
    vehicleWhere.vin = { contains: query.vin };
  }
  if (Object.keys(vehicleWhere).length > 0) {
    where.vehicle = { is: vehicleWhere };
  }

  const requestedAt: Prisma.DateTimeFilter = {};
  if (query.startDate) {
    requestedAt.gte = parseDateOnly(query.startDate, "startDate");
  }
  if (query.endDate) {
    requestedAt.lt = addDaysDateOnly(parseDateOnly(query.endDate, "endDate"), 1);
  }
  if (Object.keys(requestedAt).length > 0) {
    where.requestedAt = requestedAt;
  }

  return where;
}

function normalizePagination(query: Pick<VehicleValuationReviewQueryDto, "page" | "pageSize">) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;

  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    take: pageSize
  };
}

function assertPendingReview(review: ReviewWithRelations) {
  if (review.reviewStatus !== VehicleValuationReviewStatus.PENDING) {
    throw new BadRequestException("只有待审核的车辆估值复核可以执行该操作。");
  }
}

function reviewAuditPayload(review: ReviewWithRelations) {
  return {
    adoptedResidualAmount: numberOrNull(review.adoptedResidualAmount),
    approvedSalePriceAmount: numberOrNull(review.approvedSalePriceAmount),
    forecastId: review.forecastId,
    forecastPointId: review.forecastPointId,
    forecastResidualAmount: numberOrNull(review.forecastResidualAmount),
    originalSalePriceAmount: numberOrNull(review.originalSalePriceAmount),
    requestedSalePriceAmount: Number(review.requestedSalePriceAmount),
    reviewId: review.id,
    reviewNo: review.reviewNo,
    reviewRemark: review.reviewRemark,
    reviewStatus: review.reviewStatus,
    vehicleId: review.vehicleId
  };
}

function approvalReviewSnapshot(
  review: ReviewWithRelations,
  vehicle: Vehicle,
  history: VehicleSalePriceHistory,
  approvedAt: Date,
  reviewRemark: string | null
) {
  return {
    adoptedResidualAmount: numberOrNull(review.adoptedResidualAmount),
    approvedAt: approvedAt.toISOString(),
    approvedSalePriceAmount: Number(history.afterSalePriceAmount),
    beforeVehicle: toVehicleSummary(review.vehicle),
    forecastId: review.forecastId,
    forecastNo: review.forecast?.forecastNo ?? null,
    forecastPointId: review.forecastPointId,
    forecastResidualAmount: numberOrNull(review.forecastResidualAmount),
    originalSalePriceAmount: numberOrNull(review.originalSalePriceAmount),
    requestedSalePriceAmount: Number(review.requestedSalePriceAmount),
    reviewId: review.id,
    reviewNo: review.reviewNo,
    reviewRemark,
    reviewType: VehicleSalePriceReviewType.RESIDUAL_FORECAST_ADOPTION,
    vehicle: toVehicleSummary(vehicle),
    vehicleId: review.vehicleId,
    vehicleSalePriceHistoryId: history.id
  };
}

function vehicleBeforeSnapshot(vehicle: Vehicle) {
  return {
    currentSalePriceAmount: numberOrNull(vehicle.currentSalePriceAmount),
    currentSalePriceReviewedAt: vehicle.currentSalePriceReviewedAt?.toISOString() ?? null,
    nextSalePriceReviewAt: vehicle.nextSalePriceReviewAt ? formatDateOnly(vehicle.nextSalePriceReviewAt) : null,
    salePriceStatus: vehicle.salePriceStatus,
    vehicleId: vehicle.id,
    vehicleNo: vehicle.vehicleNo,
    vin: vehicle.vin
  };
}

function forecastPointSnapshot(point: ForecastPointWithRelations, amountSource: string) {
  return {
    adoptedResidualAmount: numberOrNull(point.adoptedResidualAmount),
    amountSource,
    confidenceScore: point.confidenceScore,
    curveId: point.forecast.curveId,
    curveNo: point.forecast.curve.curveNo,
    forecastId: point.forecastId,
    forecastNo: point.forecast.forecastNo,
    forecastStatus: point.forecast.forecastStatus,
    horizonMonth: point.horizonMonth,
    interpolationMethod: point.interpolationMethod,
    lowerBoundAmount: numberOrNull(point.lowerBoundAmount),
    pointId: point.id,
    pointStatus: point.pointStatus,
    predictedResidualAmount: numberOrNull(point.predictedResidualAmount),
    targetAgeMonth: point.targetAgeMonth,
    targetDate: formatDateOnly(point.targetDate),
    upperBoundAmount: numberOrNull(point.upperBoundAmount),
    vehicleId: point.forecast.vehicleId
  };
}

function toReviewListItemView(review: ReviewWithRelations) {
  return {
    adoptedResidualAmount: numberOrNull(review.adoptedResidualAmount),
    approvedSalePriceAmount: numberOrNull(review.approvedSalePriceAmount),
    forecastResidualAmount: numberOrNull(review.forecastResidualAmount),
    id: review.id,
    originalSalePriceAmount: numberOrNull(review.originalSalePriceAmount),
    reason: review.reason,
    requestedAt: review.requestedAt.toISOString(),
    requestedSalePriceAmount: Number(review.requestedSalePriceAmount),
    reviewNo: review.reviewNo,
    reviewSource: review.reviewSource,
    reviewStatus: review.reviewStatus,
    reviewedAt: review.reviewedAt?.toISOString() ?? null,
    vehicle: toVehicleSummary(review.vehicle),
    vehicleId: review.vehicleId
  };
}

function toReviewDetailView(review: ReviewWithRelations) {
  return {
    ...toReviewListItemView(review),
    approvalSnapshot: review.approvalSnapshot,
    approvedAt: review.approvedAt?.toISOString() ?? null,
    beforeSnapshot: review.beforeSnapshot,
    cancelReason: review.cancelReason,
    cancelledAt: review.cancelledAt?.toISOString() ?? null,
    createdAt: review.createdAt.toISOString(),
    createdBy: review.createdBy,
    forecast: review.forecast
      ? {
          asOfDate: formatDateOnly(review.forecast.asOfDate),
          forecastNo: review.forecast.forecastNo,
          forecastStatus: review.forecast.forecastStatus,
          id: review.forecast.id,
          vehicleId: review.forecast.vehicleId
        }
      : null,
    forecastAmountSource: review.forecastAmountSource,
    forecastConfidenceScore: review.forecastConfidenceScore,
    forecastHorizonMonth: review.forecastHorizonMonth,
    forecastId: review.forecastId,
    forecastPoint: review.forecastPoint
      ? {
          adoptedResidualAmount: numberOrNull(review.forecastPoint.adoptedResidualAmount),
          confidenceScore: review.forecastPoint.confidenceScore,
          horizonMonth: review.forecastPoint.horizonMonth,
          id: review.forecastPoint.id,
          pointStatus: review.forecastPoint.pointStatus,
          predictedResidualAmount: numberOrNull(review.forecastPoint.predictedResidualAmount),
          targetDate: formatDateOnly(review.forecastPoint.targetDate)
        }
      : null,
    forecastPointId: review.forecastPointId,
    forecastSnapshot: review.forecastSnapshot,
    forecastTargetDate: review.forecastTargetDate ? formatDateOnly(review.forecastTargetDate) : null,
    rejectReason: review.rejectReason,
    rejectedAt: review.rejectedAt?.toISOString() ?? null,
    requestedBy: review.requestedBy,
    reviewedBy: review.reviewedBy,
    reviewRemark: review.reviewRemark,
    snapshot: review.snapshot,
    updatedAt: review.updatedAt.toISOString(),
    updatedBy: review.updatedBy
  };
}

function toModelDefinitionSummary(definition?: ModelDefinitionSummary | null) {
  return definition
    ? {
        brand: definition.brand,
        customerDisplayName: definition.customerDisplayName,
        displayName: definition.displayName,
        id: definition.id,
        modelCode: definition.modelCode,
        modelName: definition.modelName,
        modelYear: definition.modelYear,
        series: definition.series
      }
    : null;
}

function modelDisplayName(definition: ModelDefinitionSummary | null | undefined, fallback?: string | null) {
  return definition?.displayName ?? fallback ?? null;
}

function toVehicleSummary(vehicle: VehicleWithModelDefinition) {
  return {
    brand: vehicle.brand,
    currentSalePriceAmount: numberOrNull(vehicle.currentSalePriceAmount),
    currentSalePriceReviewedAt: vehicle.currentSalePriceReviewedAt?.toISOString() ?? null,
    id: vehicle.id,
    model: vehicle.model,
    modelDefinition: toModelDefinitionSummary(vehicle.modelDefinition),
    modelDefinitionId: vehicle.modelDefinitionId,
    modelDisplayName: modelDisplayName(vehicle.modelDefinition, vehicle.model),
    nextSalePriceReviewAt: vehicle.nextSalePriceReviewAt ? formatDateOnly(vehicle.nextSalePriceReviewAt) : null,
    plateNo: vehicle.plateNo,
    salePriceStatus: vehicle.salePriceStatus,
    series: vehicle.series,
    status: vehicle.status,
    vehicleNo: vehicle.vehicleNo,
    vin: vehicle.vin
  };
}

function toSalePriceHistoryView(history: VehicleSalePriceHistory) {
  return {
    afterSalePriceAmount: Number(history.afterSalePriceAmount),
    beforeSalePriceAmount: numberOrNull(history.beforeSalePriceAmount),
    createdAt: history.createdAt.toISOString(),
    effectiveFrom: formatDateOnly(history.effectiveFrom),
    effectiveTo: history.effectiveTo ? formatDateOnly(history.effectiveTo) : null,
    id: history.id,
    reason: history.reason,
    remark: history.remark,
    reviewQuarter: history.reviewQuarter,
    reviewType: history.reviewType,
    vehicleId: history.vehicleId
  };
}

function requiredFenAmount(value: number, fieldName: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BadRequestException(`${fieldName} 必须大于 0`);
  }
  return BigInt(value);
}

function requiredText(value: string | null | undefined, fieldName: string) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new BadRequestException(`${fieldName} 不能为空`);
  }
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined) {
  if (value === undefined || value === null) {
    return null;
  }

  const text = value.trim();
  return text.length === 0 ? null : text;
}

function numberOrNull(value: bigint | null | undefined) {
  return value === null || value === undefined ? null : Number(value);
}

function toJsonObject(value: Record<string, unknown>) {
  return value as Prisma.InputJsonObject;
}

function parseDateOnly(value: string, fieldName: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException(`${fieldName} 必须是 YYYY-MM-DD 格式`);
  }

  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new BadRequestException(`${fieldName} 不是有效日期`);
  }

  return date;
}

function dateOnlyFromDate(date: Date) {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}

function addDaysDateOnly(date: Date, days: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function addMonths(date: Date, months: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()));
}

function toReviewQuarter(date: Date) {
  return `${date.getUTCFullYear()}Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}
