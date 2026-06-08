import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  AuditAction,
  Prisma,
  SalePriceStatus,
  Vehicle,
  VehicleAssetCostProfile,
  VehicleAssetCostProfileStatus,
  VehicleBatteryUsageType,
  VehicleDepreciationMethod,
  VehicleSalePriceHistory,
  VehicleSalePriceReviewType,
  VehicleStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import { buildVehicleAssetCostProfilePreview } from "./asset-cost-profile-calculation";
import {
  CreateVehicleDto,
  InitializeSalePriceDto,
  ReviewSalePriceDto,
  UpdateVehicleDto,
  UpdateVehicleStatusDto,
  UpsertVehicleAssetCostProfileDto
} from "./dto/vehicle.dto";

const vehicleInclude = {
  salePriceHistories: {
    orderBy: { createdAt: "desc" as const }
  }
} satisfies Prisma.VehicleInclude;

type VehicleWithHistory = Vehicle & { salePriceHistories?: VehicleSalePriceHistory[] };

const VEHICLE_BATTERY_USAGE_TYPE_LABELS: Record<VehicleBatteryUsageType, string> = {
  BAAS: "BaaS / 电池租用",
  BUYOUT: "电池买断"
};
const VEHICLE_BATTERY_USAGE_TYPES = new Set<string>(Object.values(VehicleBatteryUsageType));

const INITIALIZE_BEFORE_AVAILABLE_MESSAGE = "请先初始化当前车辆销售价后再入池";
const RETURN_REINIT_BEFORE_AVAILABLE_MESSAGE = "退回车辆需重新初始化当前销售价后才能入池";
const RETURN_REINIT_ALLOWED_STATUSES = new Set<VehicleStatus>([
  VehicleStatus.RETURNED,
  VehicleStatus.MAINTENANCE
]);
const OCCUPIED_STATUSES = new Set<VehicleStatus>([
  VehicleStatus.REVIEW_RESERVED,
  VehicleStatus.RESERVED,
  VehicleStatus.LEASED,
  VehicleStatus.RENTED,
  VehicleStatus.RETIRED
]);

@Injectable()
export class VehicleService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService
  ) {}

  async listVehicles() {
    const vehicles = await this.prisma.vehicle.findMany({
      include: vehicleInclude,
      orderBy: { createdAt: "desc" },
      where: { deletedAt: null }
    });

    return vehicles.map((vehicle) => toVehicleView(vehicle));
  }

  async listAvailableVehicles() {
    const vehicles = await this.prisma.vehicle.findMany({
      include: vehicleInclude,
      orderBy: { vehicleNo: "asc" },
      where: {
        currentSalePriceAmount: { gt: 0 },
        deletedAt: null,
        salePriceStatus: SalePriceStatus.EFFECTIVE,
        status: VehicleStatus.AVAILABLE
      }
    });

    return vehicles.map((vehicle) => toVehicleView(vehicle));
  }

  async listDueSalePriceReviews() {
    const today = todayDateOnly();
    const vehicles = await this.prisma.vehicle.findMany({
      include: vehicleInclude,
      orderBy: [{ nextSalePriceReviewAt: "asc" }, { vehicleNo: "asc" }],
      where: {
        deletedAt: null,
        nextSalePriceReviewAt: { lte: today },
        salePriceStatus: { in: [SalePriceStatus.EFFECTIVE, SalePriceStatus.REVIEW_DUE] }
      }
    });

    return vehicles.map((vehicle) => toVehicleView(vehicle, today));
  }

  async createVehicle(dto: CreateVehicleDto, user: RequestUser, context: RequestContext) {
    assertRequiredString(dto.vin, "VIN 必填");
    if (!dto.vehicleModel) {
      throw new BadRequestException("车型代码必填");
    }
    assertPositiveAmount(dto.purchasePriceAmount, "车辆采购价必须大于 0");
    assertBatteryCapacity(dto.batteryCapacityKwh);
    assertBatteryUsageType(dto.batteryUsageType);
    assertCanCreateAsAvailable(dto.status ?? VehicleStatus.DRAFT);

    const vehicle = await createVehicleWithRetry(this.prisma, dto, user.id);

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toVehicleView(vehicle),
      entityId: vehicle.id,
      entityType: "vehicle",
      ipAddress: context.ipAddress,
      module: "vehicle",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toVehicleView(vehicle);
  }

  async getVehicle(id: string) {
    return toVehicleView(await this.findVehicleOrThrow(id));
  }

  async updateVehicle(
    id: string,
    dto: UpdateVehicleDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findVehicleOrThrow(id);
    assertBatteryCapacity(dto.batteryCapacityKwh);
    assertBatteryUsageType(dto.batteryUsageType);
    const data = updateVehicleData(dto, user.id);

    if (dto.status) {
      assertCanEnterAvailable(dto.status, before);
      markSalePriceReinitRequired(data, before.status, dto.status);
    }

    const vehicle = await this.prisma.vehicle.update({
      data,
      include: vehicleInclude,
      where: { id }
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toVehicleView(vehicle),
      before: toVehicleView(before),
      entityId: id,
      entityType: "vehicle",
      ipAddress: context.ipAddress,
      module: "vehicle",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toVehicleView(vehicle);
  }

  async initializeSalePrice(
    id: string,
    dto: InitializeSalePriceDto,
    user: RequestUser,
    context: RequestContext
  ) {
    assertPositiveAmount(dto.currentSalePriceAmount, "当前车辆销售价必须大于 0");

    const before = await this.findVehicleOrThrow(id);
    const reviewType = dto.reviewType ?? VehicleSalePriceReviewType.INITIAL_POOL;

    assertCanInitializeSalePriceForReviewType(before, reviewType);

    if (
      reviewType === VehicleSalePriceReviewType.INITIAL_POOL &&
      isPositiveBigInt(before.currentSalePriceAmount)
    ) {
      throw new BadRequestException("当前车辆销售价已初始化");
    }

    const effectiveFrom = parseDateOnly(dto.effectiveFrom, "effectiveFrom");
    const reviewedAt = new Date();
    const nextSalePriceReviewAt = addMonths(effectiveFrom, 3);

    const result = await this.prisma.$transaction(async (tx) => {
      const vehicle = await tx.vehicle.update({
        data: {
          currentSalePriceAmount: BigInt(dto.currentSalePriceAmount),
          currentSalePriceInitializedAt: reviewedAt,
          currentSalePriceReviewedAt: reviewedAt,
          nextSalePriceReviewAt,
          salePriceReinitRequiredAt:
            reviewType === VehicleSalePriceReviewType.RETURN_REINIT ? null : before.salePriceReinitRequiredAt,
          salePriceStatus: SalePriceStatus.EFFECTIVE,
          updatedBy: user.id
        },
        where: { id }
      });

      const history = await tx.vehicleSalePriceHistory.create({
        data: {
          afterSalePriceAmount: BigInt(dto.currentSalePriceAmount),
          beforeSalePriceAmount: before.currentSalePriceAmount,
          createdBy: user.id,
          effectiveFrom,
          reason: dto.reason,
          remark: dto.remark,
          reviewQuarter: toReviewQuarter(effectiveFrom),
          reviewType,
          vehicleId: id
        }
      });

      return { history, vehicle };
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toVehicleView(result.vehicle),
      before: toVehicleView(before),
      entityId: id,
      entityType: "vehicle",
      ipAddress: context.ipAddress,
      module: "vehicle",
      operatorId: user.id,
      userAgent: context.userAgent
    });
    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toSalePriceHistoryView(result.history),
      entityId: result.history.id,
      entityType: "vehicle_sale_price_history",
      ipAddress: context.ipAddress,
      module: "vehicle",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toVehicleView({
      ...result.vehicle,
      salePriceHistories: [result.history, ...(before.salePriceHistories ?? [])]
    });
  }

  async reviewSalePrice(
    id: string,
    dto: ReviewSalePriceDto,
    user: RequestUser,
    context: RequestContext
  ) {
    assertPositiveAmount(dto.newSalePriceAmount, "新销售价必须大于 0");
    assertReviewQuarter(dto.reviewQuarter);

    const before = await this.findVehicleOrThrow(id);

    if (!isPositiveBigInt(before.currentSalePriceAmount)) {
      throw new BadRequestException("请先初始化当前车辆销售价后再复核");
    }

    const effectiveFrom = parseDateOnly(dto.effectiveFrom, "effectiveFrom");
    const reviewedAt = new Date();
    const nextSalePriceReviewAt = addMonths(effectiveFrom, 3);

    const result = await this.prisma.$transaction(async (tx) => {
      const vehicle = await tx.vehicle.update({
        data: {
          currentSalePriceAmount: BigInt(dto.newSalePriceAmount),
          currentSalePriceReviewedAt: reviewedAt,
          nextSalePriceReviewAt,
          salePriceStatus: SalePriceStatus.EFFECTIVE,
          updatedBy: user.id
        },
        where: { id }
      });

      const history = await tx.vehicleSalePriceHistory.create({
        data: {
          afterSalePriceAmount: BigInt(dto.newSalePriceAmount),
          beforeSalePriceAmount: before.currentSalePriceAmount,
          createdBy: user.id,
          effectiveFrom,
          reason: dto.reason,
          remark: dto.remark,
          reviewQuarter: dto.reviewQuarter,
          reviewType: VehicleSalePriceReviewType.QUARTERLY_REVIEW,
          vehicleId: id
        }
      });

      return { history, vehicle };
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toVehicleView(result.vehicle),
      before: toVehicleView(before),
      entityId: id,
      entityType: "vehicle",
      ipAddress: context.ipAddress,
      module: "vehicle",
      operatorId: user.id,
      userAgent: context.userAgent
    });
    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toSalePriceHistoryView(result.history),
      entityId: result.history.id,
      entityType: "vehicle_sale_price_history",
      ipAddress: context.ipAddress,
      module: "vehicle",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toVehicleView({
      ...result.vehicle,
      salePriceHistories: [result.history, ...(before.salePriceHistories ?? [])]
    });
  }

  async updateStatus(
    id: string,
    dto: UpdateVehicleStatusDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findVehicleOrThrow(id);
    assertCanEnterAvailable(dto.status, before);

    const data: Prisma.VehicleUpdateInput = {
      remark: dto.remark ?? undefined,
      status: dto.status,
      updatedBy: user.id
    };
    markSalePriceReinitRequired(data, before.status, dto.status);

    const vehicle = await this.prisma.vehicle.update({
      data,
      include: vehicleInclude,
      where: { id }
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toVehicleView(vehicle),
      before: toVehicleView(before),
      entityId: id,
      entityType: "vehicle",
      ipAddress: context.ipAddress,
      module: "vehicle",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toVehicleView(vehicle);
  }

  async listSalePriceHistory(id: string) {
    await this.findVehicleOrThrow(id);
    const histories = await this.prisma.vehicleSalePriceHistory.findMany({
      orderBy: { createdAt: "desc" },
      where: { vehicleId: id }
    });

    return histories.map(toSalePriceHistoryView);
  }

  async getAssetCostProfile(id: string) {
    await this.findVehicleOrThrow(id);
    const profile = await this.prisma.vehicleAssetCostProfile.findFirst({
      orderBy: { updatedAt: "desc" },
      where: activeAssetCostProfileWhere(id)
    });

    return profile ? toAssetCostProfileView(profile) : null;
  }

  async upsertAssetCostProfile(
    id: string,
    dto: UpsertVehicleAssetCostProfileDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const vehicle = await this.findVehicleOrThrow(id);
    assertAssetCostProfileInput(dto, vehicle);
    const profileFields = buildAssetCostProfileFields(dto, vehicle);

    const result = await this.prisma.$transaction(async (tx) => {
      const before = await tx.vehicleAssetCostProfile.findFirst({
        orderBy: { updatedAt: "desc" },
        where: activeAssetCostProfileWhere(id)
      });

      if (before) {
        const profile = await tx.vehicleAssetCostProfile.update({
          data: {
            ...profileFields,
            updatedBy: user.id
          },
          where: { id: before.id }
        });
        return { action: AuditAction.UPDATE, before, profile };
      }

      const profile = await tx.vehicleAssetCostProfile.create({
        data: {
          ...profileFields,
          createdBy: user.id,
          updatedBy: user.id,
          vehicleId: id
        }
      });
      return { action: AuditAction.CREATE, before: null, profile };
    });

    await this.auditService.write({
      action: result.action,
      after: toAssetCostProfileAuditSnapshot(result.profile, dto.remark),
      before: result.before ? toAssetCostProfileAuditSnapshot(result.before, dto.remark) : undefined,
      entityId: result.profile.id,
      entityType: "vehicle_asset_cost_profile",
      ipAddress: context.ipAddress,
      module: "vehicle",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toAssetCostProfileView(result.profile);
  }

  async getAssetCostProfilePreview(id: string) {
    const vehicle = await this.findVehicleOrThrow(id);
    const profile = await this.prisma.vehicleAssetCostProfile.findFirst({
      orderBy: { updatedAt: "desc" },
      where: activeAssetCostProfileWhere(id)
    });

    if (!profile) {
      return {
        preview: null,
        profile: null
      };
    }

    return {
      preview: buildVehicleAssetCostProfilePreview(vehicle, profile),
      profile: toAssetCostProfileView(profile)
    };
  }

  private async findVehicleOrThrow(id: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      include: vehicleInclude,
      where: { id }
    });

    if (!vehicle || vehicle.deletedAt) {
      throw new NotFoundException("车辆不存在");
    }

    return vehicle;
  }
}

async function createVehicleWithRetry(prisma: PrismaService, dto: CreateVehicleDto, operatorId: string) {
  try {
    return await withUniqueBusinessNoRetry(() => prisma.vehicle.create({
      data: {
        ...createVehicleData(dto),
        createdBy: operatorId,
        updatedBy: operatorId,
        vehicleNo: createBusinessNo("VEH")
      },
      include: vehicleInclude
    }));
  } catch (error) {
    throwVehicleUniqueError(error);
  }
}

function createVehicleData(dto: CreateVehicleDto): Omit<Prisma.VehicleCreateInput, "vehicleNo"> {
  return {
    assetLocation: dto.assetLocation,
    batteryCapacityKwh:
      dto.batteryCapacityKwh === undefined || dto.batteryCapacityKwh === null
        ? undefined
        : new Prisma.Decimal(dto.batteryCapacityKwh),
    batteryUsageType: dto.batteryUsageType ?? VehicleBatteryUsageType.BUYOUT,
    brand: dto.brand,
    currentMileageKm: dto.currentMileageKm ?? 0,
    insuranceEndDate: parseOptionalDateOnly(dto.insuranceEndDate, "insuranceEndDate"),
    insuranceStartDate: parseOptionalDateOnly(dto.insuranceStartDate, "insuranceStartDate"),
    model: dto.model,
    modelYear: dto.modelYear,
    plateNo: dto.plateNo,
    purchaseDate: parseOptionalDateOnly(dto.purchaseDate, "purchaseDate"),
    purchasePriceAmount: BigInt(dto.purchasePriceAmount),
    registrationDate: parseOptionalDateOnly(dto.registrationDate, "registrationDate"),
    remark: dto.remark,
    series: dto.series,
    status: dto.status ?? VehicleStatus.DRAFT,
    vehicleModel: dto.vehicleModel,
    vin: dto.vin
  };
}

function updateVehicleData(dto: UpdateVehicleDto, operatorId: string): Prisma.VehicleUpdateInput {
  const data: Prisma.VehicleUpdateInput = {
    updatedBy: operatorId
  };

  assignIfDefined(data, "assetLocation", dto.assetLocation);
  assignIfDefined(
    data,
    "batteryCapacityKwh",
    dto.batteryCapacityKwh === undefined || dto.batteryCapacityKwh === null
      ? dto.batteryCapacityKwh
      : new Prisma.Decimal(dto.batteryCapacityKwh)
  );
  assignIfDefined(data, "batteryUsageType", dto.batteryUsageType);
  assignIfDefined(data, "brand", dto.brand);
  assignIfDefined(data, "currentMileageKm", dto.currentMileageKm);
  assignIfDefined(data, "insuranceEndDate", parseOptionalDateOnly(dto.insuranceEndDate, "insuranceEndDate"));
  assignIfDefined(data, "insuranceStartDate", parseOptionalDateOnly(dto.insuranceStartDate, "insuranceStartDate"));
  assignIfDefined(data, "model", dto.model);
  assignIfDefined(data, "modelYear", dto.modelYear);
  assignIfDefined(data, "plateNo", dto.plateNo);
  assignIfDefined(data, "purchaseDate", parseOptionalDateOnly(dto.purchaseDate, "purchaseDate"));
  assignIfDefined(
    data,
    "purchasePriceAmount",
    dto.purchasePriceAmount === undefined ? undefined : BigInt(dto.purchasePriceAmount)
  );
  assignIfDefined(data, "registrationDate", parseOptionalDateOnly(dto.registrationDate, "registrationDate"));
  assignIfDefined(data, "remark", dto.remark);
  assignIfDefined(data, "series", dto.series);
  assignIfDefined(data, "status", dto.status);
  assignIfDefined(data, "vehicleModel", dto.vehicleModel);
  assignIfDefined(data, "vin", dto.vin);

  return data;
}

function assignIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined) {
  if (value !== undefined) {
    target[key] = value;
  }
}

function assertRequiredString(value: string | null | undefined, message: string) {
  if (!value?.trim()) {
    throw new BadRequestException(message);
  }
}

function assertCanCreateAsAvailable(status: VehicleStatus) {
  if (status === VehicleStatus.AVAILABLE) {
    throw new BadRequestException(INITIALIZE_BEFORE_AVAILABLE_MESSAGE);
  }
}

function assertCanInitializeSalePriceForReviewType(
  vehicle: VehicleWithHistory,
  reviewType: VehicleSalePriceReviewType
) {
  if (reviewType === VehicleSalePriceReviewType.RETURN_REINIT) {
    if (!RETURN_REINIT_ALLOWED_STATUSES.has(vehicle.status)) {
      throw new BadRequestException("仅退回或维修中的车辆可以执行退车再入池重新定价");
    }
    return;
  }

  if (RETURN_REINIT_ALLOWED_STATUSES.has(vehicle.status)) {
    throw new BadRequestException(RETURN_REINIT_BEFORE_AVAILABLE_MESSAGE);
  }
}

function assertCanEnterAvailable(status: VehicleStatus, vehicle: VehicleWithHistory) {
  if (status !== VehicleStatus.AVAILABLE) {
    return;
  }

  if (OCCUPIED_STATUSES.has(vehicle.status)) {
    throw new BadRequestException("当前车辆状态不允许直接入池");
  }

  if (RETURN_REINIT_ALLOWED_STATUSES.has(vehicle.status) && !hasReturnReinitForCurrentPool(vehicle)) {
    throw new BadRequestException(RETURN_REINIT_BEFORE_AVAILABLE_MESSAGE);
  }

  if (!isPositiveBigInt(vehicle.currentSalePriceAmount) || vehicle.salePriceStatus !== SalePriceStatus.EFFECTIVE) {
    throw new BadRequestException(INITIALIZE_BEFORE_AVAILABLE_MESSAGE);
  }
}

function markSalePriceReinitRequired(
  data: Prisma.VehicleUpdateInput,
  beforeStatus: VehicleStatus,
  nextStatus: VehicleStatus
) {
  if (beforeStatus !== nextStatus && RETURN_REINIT_ALLOWED_STATUSES.has(nextStatus)) {
    data.salePriceReinitRequiredAt = new Date();
  }
}

function hasReturnReinitForCurrentPool(vehicle: VehicleWithHistory) {
  const latestReturnReinit = vehicle.salePriceHistories?.find(
    (history) => history.reviewType === VehicleSalePriceReviewType.RETURN_REINIT
  );

  if (!latestReturnReinit) {
    return false;
  }

  if (!vehicle.salePriceReinitRequiredAt) {
    return true;
  }

  return latestReturnReinit.createdAt.getTime() >= vehicle.salePriceReinitRequiredAt.getTime();
}

function assertReviewQuarter(reviewQuarter: string) {
  if (!/^\d{4}Q[1-4]$/.test(reviewQuarter)) {
    throw new BadRequestException("reviewQuarter 必须是 YYYYQn 格式");
  }
}

function assertPositiveAmount(amount: number, message: string) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new BadRequestException(message);
  }
}

function assertBatteryCapacity(amount: number | null | undefined) {
  if (amount === undefined || amount === null) {
    return;
  }
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 9999.99 ||
    !/^\d+(\.\d{1,2})?$/.test(String(amount))
  ) {
    throw new BadRequestException("电池容量必须大于 0，且最多保留 2 位小数");
  }
}

function assertBatteryUsageType(value: VehicleBatteryUsageType | null | undefined) {
  if (value === undefined) {
    return;
  }
  if (value === null || !VEHICLE_BATTERY_USAGE_TYPES.has(value)) {
    throw new BadRequestException("电池使用方式只能是 BUYOUT 或 BAAS");
  }
}

function isPositiveBigInt(value: bigint | null | undefined) {
  return value !== null && value !== undefined && value > 0n;
}

function throwVehicleUniqueError(error: unknown): never {
  if (!isPrismaUniqueError(error)) {
    throw error;
  }

  const target = Array.isArray(error.meta?.target) ? error.meta.target.join(",") : String(error.meta?.target ?? "");
  if (target.includes("vin")) {
    throw new BadRequestException("VIN 已存在");
  }
  if (target.includes("plate")) {
    throw new BadRequestException("车牌号已存在");
  }
  throw new BadRequestException("车辆编号已存在，请重试");
}

function isPrismaUniqueError(error: unknown): error is { code: string; meta?: { target?: unknown } } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function parseOptionalDateOnly(input: string | null | undefined, fieldName: string) {
  if (input === undefined) {
    return undefined;
  }

  if (input === null || input === "") {
    return null;
  }

  return parseDateOnly(input, fieldName);
}

function parseDateOnly(input: string, fieldName: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);

  if (!match) {
    throw new BadRequestException(`${fieldName} 必须是 YYYY-MM-DD 格式`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
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

function addMonths(date: Date, months: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()));
}

function todayDateOnly() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function toReviewQuarter(date: Date) {
  return `${date.getUTCFullYear()}Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

function toVehicleView(vehicle: VehicleWithHistory, today = todayDateOnly()) {
  return {
    assetLocation: vehicle.assetLocation,
    batteryCapacityKwh: decimalToNumber(vehicle.batteryCapacityKwh),
    batteryUsageType: vehicle.batteryUsageType,
    batteryUsageTypeLabel: VEHICLE_BATTERY_USAGE_TYPE_LABELS[vehicle.batteryUsageType],
    brand: vehicle.brand,
    createdAt: vehicle.createdAt,
    currentMileageKm: vehicle.currentMileageKm,
    currentSalePriceAmount:
      vehicle.currentSalePriceAmount === null ? null : Number(vehicle.currentSalePriceAmount),
    currentSalePriceInitializedAt: vehicle.currentSalePriceInitializedAt,
    currentSalePriceReviewedAt: vehicle.currentSalePriceReviewedAt,
    deletedAt: vehicle.deletedAt,
    id: vehicle.id,
    insuranceEndDate: vehicle.insuranceEndDate,
    insuranceStartDate: vehicle.insuranceStartDate,
    model: vehicle.model,
    modelYear: vehicle.modelYear,
    nextSalePriceReviewAt: vehicle.nextSalePriceReviewAt,
    plateNo: vehicle.plateNo,
    purchaseDate: vehicle.purchaseDate,
    purchasePriceAmount: Number(vehicle.purchasePriceAmount),
    registrationDate: vehicle.registrationDate,
    remark: vehicle.remark,
    salePriceReinitRequiredAt: vehicle.salePriceReinitRequiredAt,
    salePriceHistories: vehicle.salePriceHistories?.map(toSalePriceHistoryView) ?? [],
    salePriceStatus: resolveSalePriceStatus(vehicle.salePriceStatus, vehicle.nextSalePriceReviewAt, today),
    series: vehicle.series,
    status: vehicle.status,
    updatedAt: vehicle.updatedAt,
    vehicleId: vehicle.id,
    vehicleModel: vehicle.vehicleModel,
    vehicleNo: vehicle.vehicleNo,
    vin: vehicle.vin
  };
}

function decimalToNumber(value: Prisma.Decimal | null | undefined) {
  return value === null || value === undefined ? null : value.toNumber();
}

function resolveSalePriceStatus(
  salePriceStatus: SalePriceStatus,
  nextSalePriceReviewAt: Date | null,
  today: Date
) {
  if (
    nextSalePriceReviewAt &&
    (salePriceStatus === SalePriceStatus.EFFECTIVE || salePriceStatus === SalePriceStatus.REVIEW_DUE) &&
    nextSalePriceReviewAt.getTime() <= today.getTime()
  ) {
    return SalePriceStatus.REVIEW_DUE;
  }

  return salePriceStatus;
}

function toSalePriceHistoryView(history: VehicleSalePriceHistory) {
  return {
    afterSalePriceAmount: Number(history.afterSalePriceAmount),
    beforeSalePriceAmount:
      history.beforeSalePriceAmount === null ? null : Number(history.beforeSalePriceAmount),
    createdAt: history.createdAt,
    effectiveFrom: history.effectiveFrom,
    effectiveTo: history.effectiveTo,
    id: history.id,
    reason: history.reason,
    remark: history.remark,
    reviewQuarter: history.reviewQuarter,
    reviewType: history.reviewType,
    vehicleId: history.vehicleId
  };
}

function activeAssetCostProfileWhere(vehicleId: string): Prisma.VehicleAssetCostProfileWhereInput {
  return {
    deletedAt: null,
    profileStatus: VehicleAssetCostProfileStatus.ACTIVE,
    vehicleId
  };
}

function assertAssetCostProfileInput(
  dto: UpsertVehicleAssetCostProfileDto,
  vehicle: Pick<VehicleWithHistory, "purchasePriceAmount">
) {
  if (!isPositiveBigInt(vehicle.purchasePriceAmount)) {
    throw new BadRequestException("车辆采购价缺失，无法设置残值参数。");
  }
  assertPositiveInteger(dto.usefulLifeMonths, "预计使用月数必须大于 0。");
  assertNonNegativeInteger(dto.residualValueAmount, "预计残值必须大于等于 0。");
  if (BigInt(dto.residualValueAmount) > vehicle.purchasePriceAmount) {
    throw new BadRequestException("预计残值不能大于车辆采购价。");
  }
  assertOptionalNonNegativeInteger(dto.capitalCostRateBps, "资金成本率必须大于等于 0。");
  assertOptionalNonNegativeInteger(dto.annualInsuranceCostAmount, "年度保险成本必须大于等于 0。");
  assertOptionalNonNegativeInteger(dto.annualMaintenanceReserveAmount, "年度维修准备金必须大于等于 0。");
  assertOptionalNonNegativeInteger(dto.otherMonthlyCostAmount, "其他月度成本必须大于等于 0。");
}

function buildAssetCostProfileFields(
  dto: UpsertVehicleAssetCostProfileDto,
  vehicle: VehicleWithHistory
) {
  const depreciationStartDate =
    dto.depreciationStartDate === undefined
      ? defaultDepreciationStartDate(vehicle)
      : parseDateOnly(dto.depreciationStartDate, "depreciationStartDate");
  const profileFields = {
    annualInsuranceCostAmount: optionalBigInt(dto.annualInsuranceCostAmount),
    annualMaintenanceReserveAmount: optionalBigInt(dto.annualMaintenanceReserveAmount),
    capitalCostRateBps: optionalInteger(dto.capitalCostRateBps),
    depreciationMethod: dto.depreciationMethod,
    depreciationStartDate,
    otherMonthlyCostAmount: optionalBigInt(dto.otherMonthlyCostAmount),
    profileStatus: VehicleAssetCostProfileStatus.ACTIVE,
    remark: dto.remark ?? null,
    residualValueAmount: BigInt(dto.residualValueAmount),
    usefulLifeMonths: dto.usefulLifeMonths
  };

  return {
    ...profileFields,
    snapshot: buildAssetCostProfileSnapshot(vehicle, profileFields)
  };
}

function buildAssetCostProfileSnapshot(
  vehicle: VehicleWithHistory,
  profileFields: {
    annualInsuranceCostAmount: bigint | null;
    annualMaintenanceReserveAmount: bigint | null;
    capitalCostRateBps: number | null;
    depreciationMethod: VehicleDepreciationMethod;
    depreciationStartDate: Date;
    otherMonthlyCostAmount: bigint | null;
    residualValueAmount: bigint;
    usefulLifeMonths: number;
  }
): Prisma.InputJsonObject {
  return {
    annualInsuranceCostAmount: numberOrNull(profileFields.annualInsuranceCostAmount),
    annualMaintenanceReserveAmount: numberOrNull(profileFields.annualMaintenanceReserveAmount),
    capitalCostRateBps: profileFields.capitalCostRateBps,
    depreciationMethod: profileFields.depreciationMethod,
    depreciationStartDate: formatDateOnly(profileFields.depreciationStartDate),
    otherMonthlyCostAmount: numberOrNull(profileFields.otherMonthlyCostAmount),
    purchasePriceAmount: Number(vehicle.purchasePriceAmount),
    residualValueAmount: Number(profileFields.residualValueAmount),
    usefulLifeMonths: profileFields.usefulLifeMonths,
    vehicleId: vehicle.id,
    vehicleNo: vehicle.vehicleNo
  };
}

function defaultDepreciationStartDate(vehicle: VehicleWithHistory) {
  const initialPoolDate = vehicle.salePriceHistories
    ?.filter((history) => history.reviewType === VehicleSalePriceReviewType.INITIAL_POOL)
    .map((history) => history.effectiveFrom)
    .sort((left, right) => left.getTime() - right.getTime())[0];

  return dateOnly(initialPoolDate ?? vehicle.purchaseDate ?? vehicle.createdAt);
}

function toAssetCostProfileView(profile: VehicleAssetCostProfile) {
  return {
    annualInsuranceCostAmount: numberOrNull(profile.annualInsuranceCostAmount),
    annualMaintenanceReserveAmount: numberOrNull(profile.annualMaintenanceReserveAmount),
    capitalCostRateBps: profile.capitalCostRateBps,
    createdAt: profile.createdAt,
    createdBy: profile.createdBy,
    deletedAt: profile.deletedAt,
    depreciationMethod: profile.depreciationMethod,
    depreciationStartDate: profile.depreciationStartDate,
    id: profile.id,
    otherMonthlyCostAmount: numberOrNull(profile.otherMonthlyCostAmount),
    profileStatus: profile.profileStatus,
    remark: profile.remark,
    residualValueAmount: Number(profile.residualValueAmount),
    snapshot: profile.snapshot,
    updatedAt: profile.updatedAt,
    updatedBy: profile.updatedBy,
    usefulLifeMonths: profile.usefulLifeMonths,
    vehicleId: profile.vehicleId
  };
}

function toAssetCostProfileAuditSnapshot(
  profile: VehicleAssetCostProfile,
  remark: string | null | undefined
) {
  return {
    profile: toAssetCostProfileView(profile),
    profileId: profile.id,
    remark: remark ?? profile.remark,
    vehicleId: profile.vehicleId
  };
}

function assertPositiveInteger(value: number, message: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BadRequestException(message);
  }
}

function assertNonNegativeInteger(value: number, message: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BadRequestException(message);
  }
}

function assertOptionalNonNegativeInteger(value: number | null | undefined, message: string) {
  if (value === undefined || value === null) {
    return;
  }
  assertNonNegativeInteger(value, message);
}

function optionalBigInt(value: number | null | undefined) {
  return value === undefined || value === null ? null : BigInt(value);
}

function optionalInteger(value: number | null | undefined) {
  return value === undefined || value === null ? null : value;
}

function numberOrNull(value: bigint | number | null | undefined) {
  return value === null || value === undefined ? null : Number(value);
}

function dateOnly(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}
