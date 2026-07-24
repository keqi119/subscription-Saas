import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  AuditAction,
  FinancingAllocationStatus,
  FinancingInstrument,
  Prisma,
  SalePriceStatus,
  VehicleAcquisitionMode,
  VehicleAssetCostProfile,
  VehicleAssetCostProfileStatus,
  VehicleBatteryUsageType,
  VehicleCapitalEventStatus,
  VehicleCapitalEventType,
  VehicleDepreciationMethod,
  VehicleModel,
  VehicleSalePriceHistory,
  VehicleSalePriceReviewType,
  VehicleStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import {
  type PolicyTypeCoverage,
  resolveVehicleInsuranceCoverage
} from "../common/vehicle-insurance-coverage";
import { PrismaService } from "../prisma/prisma.service";
import { buildVehicleAssetCostProfilePreview } from "./asset-cost-profile-calculation";
import {
  CancelVehicleCapitalEventDto,
  CreateVehicleCapitalEventDto,
  CreateVehicleDto,
  InitializeSalePriceDto,
  ReviewSalePriceDto,
  UpdateVehicleDto,
  UpdateVehicleCapitalEventDto,
  UpdateVehicleStatusDto,
  UpsertVehicleAssetCostProfileDto
} from "./dto/vehicle.dto";

const vehicleModelDefinitionSelect = {
  brand: true,
  customerDisplayName: true,
  displayName: true,
  enabled: true,
  id: true,
  legacyVehicleModel: true,
  modelCode: true,
  modelName: true,
  modelYear: true,
  series: true
} satisfies Prisma.VehicleModelDefinitionSelect;

const vehicleInclude = {
  insurancePolicies: {
    select: {
      deletedAt: true,
      effectiveFrom: true,
      effectiveTo: true,
      id: true,
      policyStatus: true,
      policyType: true
    },
    where: { deletedAt: null }
  },
  modelDefinition: {
    select: vehicleModelDefinitionSelect
  },
  salePriceHistories: {
    orderBy: { createdAt: "desc" as const }
  }
} satisfies Prisma.VehicleInclude;

type VehicleWithHistory = Prisma.VehicleGetPayload<{ include: typeof vehicleInclude }>;
type VehicleModelDefinitionForVehicle = Prisma.VehicleModelDefinitionGetPayload<{
  select: typeof vehicleModelDefinitionSelect;
}>;

const capitalEventInclude = {
  financingInstrument: true
} satisfies Prisma.VehicleCapitalEventInclude;

const financingAllocationInclude = {
  instrument: true
} satisfies Prisma.FinancingInstrumentVehicleInclude;

type VehicleCapitalEventWithInstrument = Prisma.VehicleCapitalEventGetPayload<{
  include: typeof capitalEventInclude;
}>;
type FinancingAllocationWithInstrument = Prisma.FinancingInstrumentVehicleGetPayload<{
  include: typeof financingAllocationInclude;
}>;

const VEHICLE_BATTERY_USAGE_TYPE_LABELS: Record<VehicleBatteryUsageType, string> = {
  BAAS: "BaaS / 电池租用",
  BUYOUT: "电池买断"
};
const VEHICLE_BATTERY_USAGE_TYPES = new Set<string>(Object.values(VehicleBatteryUsageType));
const VEHICLE_ACQUISITION_MODES = new Set<string>(Object.values(VehicleAcquisitionMode));
const FINANCING_CAPITAL_EVENT_TYPES = new Set<VehicleCapitalEventType>([
  VehicleCapitalEventType.ADD_DEBT_FINANCING,
  VehicleCapitalEventType.REFINANCE,
  VehicleCapitalEventType.EARLY_SETTLEMENT,
  VehicleCapitalEventType.FINANCING_RELEASE
]);

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

  async listVehicleModelDefinitionOptions() {
    const items = await this.prisma.vehicleModelDefinition.findMany({
      orderBy: [{ sortOrder: "asc" }, { modelCode: "asc" }],
      select: vehicleModelDefinitionSelect,
      where: {
        deletedAt: null,
        enabled: true,
        legacyVehicleModel: { not: null }
      }
    });

    return {
      items: items.map(toVehicleModelDefinitionView),
      page: 1,
      pageSize: items.length,
      total: items.length
    };
  }

  async createVehicle(dto: CreateVehicleDto, user: RequestUser, context: RequestContext) {
    assertRequiredString(dto.vin, "VIN 必填");
    const modelContext = await this.resolveModelContextForCreate(dto.modelDefinitionId, dto.vehicleModel);
    assertPositiveAmount(dto.purchasePriceAmount, "车辆采购价必须大于 0");
    assertBatteryCapacity(dto.batteryCapacityKwh);
    assertBatteryUsageType(dto.batteryUsageType);
    assertAcquisitionMode(dto.acquisitionMode);
    assertCanCreateAsAvailable(dto.status ?? VehicleStatus.DRAFT);

    const vehicle = await createVehicleWithRetry(this.prisma, dto, user.id, modelContext);

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
    assertAcquisitionMode(dto.acquisitionMode);
    const modelContext = await this.resolveModelContextForUpdate(
      dto.modelDefinitionId,
      dto.vehicleModel,
      Object.prototype.hasOwnProperty.call(dto, "vehicleModel")
    );
    const data = updateVehicleData(dto, user.id, {
      modelDefinition: modelContext.modelDefinition,
      modelDefinitionProvided: dto.modelDefinitionId !== undefined,
      vehicleModel: modelContext.vehicleModel
    });

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
        include: vehicleInclude,
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
        include: vehicleInclude,
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

  async listCapitalEvents(id: string) {
    await this.findVehicleOrThrow(id);
    const events = await this.prisma.vehicleCapitalEvent.findMany({
      include: capitalEventInclude,
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
      where: { deletedAt: null, vehicleId: id }
    });

    return events.map(toCapitalEventView);
  }

  async createCapitalEvent(
    id: string,
    dto: CreateVehicleCapitalEventDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const vehicle = await this.findVehicleOrThrow(id);
    assertCapitalEventInput(dto);

    const financingInstrument = await this.resolveCapitalEventFinancingInstrument(dto.financingInstrumentId);
    const data = buildCapitalEventData(dto, vehicle, financingInstrument);
    await this.assertNoDuplicateActiveCapitalEvent(id, data);
    const event = await withUniqueBusinessNoRetry(() =>
      this.prisma.vehicleCapitalEvent.create({
        data: {
          ...data,
          createdBy: user.id,
          eventNo: createBusinessNo("VCE"),
          updatedBy: user.id,
          vehicleId: id
        },
        include: capitalEventInclude
      })
    );

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toCapitalEventAuditSnapshot(event, dto.remark),
      entityId: event.id,
      entityType: "vehicle_capital_event",
      ipAddress: context.ipAddress,
      module: "vehicle",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toCapitalEventView(event);
  }

  async updateCapitalEvent(
    id: string,
    eventId: string,
    dto: UpdateVehicleCapitalEventDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const vehicle = await this.findVehicleOrThrow(id);
    const before = await this.findCapitalEventOrThrow(id, eventId);
    if (before.eventStatus === VehicleCapitalEventStatus.CANCELLED) {
      throw new BadRequestException("已作废的资本事件不能编辑");
    }

    const nextDto = mergeCapitalEventUpdateInput(dto, before);
    assertCapitalEventInput(nextDto);
    const financingInstrument = await this.resolveCapitalEventFinancingInstrument(nextDto.financingInstrumentId);
    const data = buildCapitalEventData(nextDto, vehicle, financingInstrument, before.eventStatus);
    await this.assertNoDuplicateActiveCapitalEvent(id, data, eventId);
    const event = await this.prisma.vehicleCapitalEvent.update({
      data: {
        ...data,
        updatedBy: user.id
      },
      include: capitalEventInclude,
      where: { id: eventId }
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toCapitalEventAuditSnapshot(event, dto.remark),
      before: toCapitalEventAuditSnapshot(before, dto.remark),
      entityId: event.id,
      entityType: "vehicle_capital_event",
      ipAddress: context.ipAddress,
      module: "vehicle",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toCapitalEventView(event);
  }

  async cancelCapitalEvent(
    id: string,
    eventId: string,
    dto: CancelVehicleCapitalEventDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const vehicle = await this.findVehicleOrThrow(id);
    const before = await this.findCapitalEventOrThrow(id, eventId);
    if (before.eventStatus === VehicleCapitalEventStatus.CANCELLED) {
      throw new BadRequestException("资本事件已作废，不能重复作废");
    }

    const remark = dto.remark ?? before.remark;
    const snapshotFields = capitalEventSnapshotFieldsFromRecord(before, {
      eventStatus: VehicleCapitalEventStatus.CANCELLED,
      remark
    });
    const event = await this.prisma.vehicleCapitalEvent.update({
      data: {
        eventStatus: VehicleCapitalEventStatus.CANCELLED,
        remark,
        snapshot: buildCapitalEventSnapshot(vehicle, snapshotFields, before.financingInstrument),
        updatedBy: user.id
      },
      include: capitalEventInclude,
      where: { id: eventId }
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toCapitalEventAuditSnapshot(event, dto.remark),
      before: toCapitalEventAuditSnapshot(before, dto.remark),
      entityId: event.id,
      entityType: "vehicle_capital_event",
      ipAddress: context.ipAddress,
      module: "vehicle",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toCapitalEventView(event);
  }

  async getCapitalStructure(id: string) {
    const vehicle = await this.findVehicleOrThrow(id);
    const today = todayDateOnly();
    const [capitalEvents, financingAllocations] = await Promise.all([
      this.prisma.vehicleCapitalEvent.findMany({
        include: capitalEventInclude,
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
        where: activeCapitalEventWhere(id, today)
      }),
      this.prisma.financingInstrumentVehicle.findMany({
        include: financingAllocationInclude,
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
        where: activeFinancingAllocationWhere(id, today)
      })
    ]);

    return buildCapitalStructurePreview(vehicle, capitalEvents, financingAllocations);
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

  private async findCapitalEventOrThrow(vehicleId: string, eventId: string) {
    const event = await this.prisma.vehicleCapitalEvent.findFirst({
      include: capitalEventInclude,
      where: {
        deletedAt: null,
        id: eventId,
        vehicleId
      }
    });

    if (!event) {
      throw new NotFoundException("资本事件不存在");
    }

    return event;
  }

  private async assertNoDuplicateActiveCapitalEvent(
    vehicleId: string,
    data: Omit<Prisma.VehicleCapitalEventUncheckedCreateInput, "createdBy" | "eventNo" | "updatedBy" | "vehicleId">,
    excludeEventId?: string
  ) {
    const duplicate = await this.prisma.vehicleCapitalEvent.findFirst({
      where: {
        acquisitionMode: data.acquisitionMode ?? null,
        debtPrincipalAmount: data.debtPrincipalAmount ?? null,
        deletedAt: null,
        effectiveFrom: data.effectiveFrom,
        effectiveTo: data.effectiveTo ?? null,
        equityCapitalAmount: data.equityCapitalAmount ?? null,
        eventStatus: VehicleCapitalEventStatus.ACTIVE,
        eventType: data.eventType,
        externalOwnerName: data.externalOwnerName ?? null,
        financingInstrumentId: data.financingInstrumentId ?? null,
        id: excludeEventId ? { not: excludeEventId } : undefined,
        lessorName: data.lessorName ?? null,
        managedOwnerName: data.managedOwnerName ?? null,
        vehicleId
      }
    });

    if (duplicate) {
      throw new BadRequestException("已存在相同融资工具、事件类型、事件时间和金额的生效资本事件，请勿重复补录。");
    }
  }

  private async resolveCapitalEventFinancingInstrument(financingInstrumentId: string | null | undefined) {
    if (!financingInstrumentId) {
      return null;
    }

    const financingInstrument = await this.prisma.financingInstrument.findUnique({
      where: { id: financingInstrumentId }
    });

    if (!financingInstrument || financingInstrument.deletedAt) {
      throw new NotFoundException("融资工具不存在");
    }

    return financingInstrument;
  }

  private async resolveModelDefinitionForVehicle(modelDefinitionId: string | null | undefined) {
    if (modelDefinitionId === undefined || modelDefinitionId === null) {
      return null;
    }

    const definition = await this.prisma.vehicleModelDefinition.findFirst({
      select: vehicleModelDefinitionSelect,
      where: {
        deletedAt: null,
        id: modelDefinitionId
      }
    });

    if (!definition) {
      throw new BadRequestException("车型主数据不存在");
    }
    if (!definition.enabled) {
      throw new BadRequestException("车型主数据已停用");
    }
    if (!definition.legacyVehicleModel) {
      throw new BadRequestException("车型主数据未映射 legacy 车型，当前阶段不能用于车辆创建");
    }

    return definition;
  }

  private async resolveModelContextForCreate(
    modelDefinitionId: string | null | undefined,
    vehicleModel: VehicleModel | null | undefined
  ) {
    if (modelDefinitionId) {
      const modelDefinition = await this.resolveModelDefinitionForVehicle(modelDefinitionId);
      return {
        modelDefinition,
        vehicleModel: resolveVehicleModelForWrite(vehicleModel, modelDefinition)
      };
    }

    void vehicleModel;
    throw new BadRequestException("新增车辆必须选择车型主数据，请传入 modelDefinitionId。");
  }

  private async resolveModelContextForUpdate(
    modelDefinitionId: string | null | undefined,
    vehicleModel: VehicleModel | null | undefined,
    vehicleModelProvided: boolean
  ) {
    if (modelDefinitionId === null) {
      throw new BadRequestException("车型代码主数据已启用，不能清除车型代码。");
    }

    if (modelDefinitionId) {
      const modelDefinition = await this.resolveModelDefinitionForVehicle(modelDefinitionId);
      return {
        modelDefinition,
        vehicleModel: resolveVehicleModelForWrite(vehicleModel, modelDefinition)
      };
    }

    if (vehicleModelProvided) {
      void vehicleModel;
      throw new BadRequestException("修改车辆车型必须选择车型主数据，请传入 modelDefinitionId。");
    }

    return {
      modelDefinition: null,
      vehicleModel: undefined
    };
  }
}

async function createVehicleWithRetry(
  prisma: PrismaService,
  dto: CreateVehicleDto,
  operatorId: string,
  modelContext: {
    modelDefinition: VehicleModelDefinitionForVehicle | null;
    vehicleModel: VehicleModel;
  }
) {
  try {
    return await withUniqueBusinessNoRetry(() => prisma.vehicle.create({
      data: {
        ...createVehicleData(dto, modelContext),
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

function createVehicleData(
  dto: CreateVehicleDto,
  modelContext: {
    modelDefinition: VehicleModelDefinitionForVehicle | null;
    vehicleModel: VehicleModel;
  }
): Omit<Prisma.VehicleCreateInput, "vehicleNo"> {
  return {
    assetLocation: dto.assetLocation,
    batteryCapacityKwh:
      dto.batteryCapacityKwh === undefined || dto.batteryCapacityKwh === null
        ? undefined
        : new Prisma.Decimal(dto.batteryCapacityKwh),
    batteryUsageType: dto.batteryUsageType ?? VehicleBatteryUsageType.BUYOUT,
    acquisitionMode: dto.acquisitionMode ?? VehicleAcquisitionMode.OWNED_CASH,
    brand: dto.brand,
    currentMileageKm: dto.currentMileageKm ?? 0,
    latestRegistrationDate: parseOptionalDateOnly(dto.latestRegistrationDate, "latestRegistrationDate"),
    model: dto.model,
    modelYear: dto.modelYear,
    plateNo: dto.plateNo,
    purchaseDate: parseOptionalDateOnly(dto.purchaseDate, "purchaseDate"),
    purchasePriceAmount: BigInt(dto.purchasePriceAmount),
    registrationDate: parseOptionalDateOnly(dto.registrationDate, "registrationDate"),
    remark: dto.remark,
    series: dto.series,
    status: dto.status ?? VehicleStatus.DRAFT,
    vehicleModel: modelContext.vehicleModel,
    ...(modelContext.modelDefinition
      ? { modelDefinition: { connect: { id: modelContext.modelDefinition.id } } }
      : {}),
    vin: dto.vin
  };
}

function updateVehicleData(
  dto: UpdateVehicleDto,
  operatorId: string,
  modelContext: {
    modelDefinition: VehicleModelDefinitionForVehicle | null;
    modelDefinitionProvided: boolean;
    vehicleModel?: VehicleModel | null;
  }
): Prisma.VehicleUpdateInput {
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
  assignIfDefined(data, "acquisitionMode", dto.acquisitionMode);
  assignIfDefined(data, "brand", dto.brand);
  assignIfDefined(data, "currentMileageKm", dto.currentMileageKm);
  assignIfDefined(data, "latestRegistrationDate", parseOptionalDateOnly(dto.latestRegistrationDate, "latestRegistrationDate"));
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
  assignIfDefined(data, "vehicleModel", modelContext.vehicleModel);
  if (modelContext.modelDefinition) {
    data.modelDefinition = { connect: { id: modelContext.modelDefinition.id } };
  } else if (modelContext.modelDefinitionProvided) {
    data.modelDefinition = { disconnect: true };
  }
  assignIfDefined(data, "vin", dto.vin);

  return data;
}

function assignIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined) {
  if (value !== undefined) {
    target[key] = value;
  }
}

function resolveVehicleModelForWrite(
  vehicleModel: VehicleModel | null | undefined,
  modelDefinition: VehicleModelDefinitionForVehicle | null
) {
  if (modelDefinition) {
    if (vehicleModel && vehicleModel !== modelDefinition.legacyVehicleModel) {
      throw new BadRequestException("车型主数据与 legacy 车型不一致");
    }
    return modelDefinition.legacyVehicleModel as VehicleModel;
  }

  if (!vehicleModel) {
    throw new BadRequestException("车型代码必填");
  }

  return vehicleModel;
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

function assertAcquisitionMode(value: VehicleAcquisitionMode | null | undefined) {
  if (value === undefined) {
    return;
  }
  if (value === null || !VEHICLE_ACQUISITION_MODES.has(value)) {
    throw new BadRequestException("车辆取得方式不合法");
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
  const resolvedInsuranceCoverage = resolveVehicleInsuranceCoverage(
    vehicle.insurancePolicies ?? [],
    today
  );

  return {
    acquisitionMode: vehicle.acquisitionMode,
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
    insuranceCoverage: {
      commercial: toPolicyTypeCoverageView(resolvedInsuranceCoverage.commercial),
      compulsoryTraffic: toPolicyTypeCoverageView(resolvedInsuranceCoverage.compulsoryTraffic),
      covered: resolvedInsuranceCoverage.covered,
      evaluatedAt: formatDateOnly(resolvedInsuranceCoverage.evaluationDate)
    },
    latestRegistrationDate: vehicle.latestRegistrationDate,
    model: vehicle.model,
    modelDefinition: vehicle.modelDefinition ? toVehicleModelDefinitionView(vehicle.modelDefinition) : null,
    modelDefinitionId: vehicle.modelDefinitionId ?? null,
    modelDisplayName: vehicle.modelDefinition?.displayName ?? vehicle.vehicleModel,
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

function toPolicyTypeCoverageView(coverage: PolicyTypeCoverage) {
  return {
    covered: coverage.covered,
    effectiveFrom: coverage.effectiveFrom ? formatDateOnly(coverage.effectiveFrom) : null,
    effectiveTo: coverage.effectiveTo ? formatDateOnly(coverage.effectiveTo) : null
  };
}

function toVehicleModelDefinitionView(definition: VehicleModelDefinitionForVehicle) {
  return {
    brand: definition.brand,
    customerDisplayName: definition.customerDisplayName,
    displayName: definition.displayName,
    enabled: definition.enabled,
    id: definition.id,
    legacyVehicleModel: definition.legacyVehicleModel,
    modelCode: definition.modelCode,
    modelName: definition.modelName,
    modelYear: definition.modelYear,
    series: definition.series
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

function activeCapitalEventWhere(vehicleId: string, today: Date): Prisma.VehicleCapitalEventWhereInput {
  return {
    deletedAt: null,
    effectiveFrom: { lte: today },
    eventStatus: VehicleCapitalEventStatus.ACTIVE,
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
    vehicleId
  };
}

function activeFinancingAllocationWhere(
  vehicleId: string,
  today: Date
): Prisma.FinancingInstrumentVehicleWhereInput {
  return {
    allocationStatus: FinancingAllocationStatus.ACTIVE,
    deletedAt: null,
    effectiveFrom: { lte: today },
    instrument: { deletedAt: null },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
    vehicleId
  };
}

function assertCapitalEventInput(dto: CreateVehicleCapitalEventDto) {
  if (FINANCING_CAPITAL_EVENT_TYPES.has(dto.eventType) && !dto.financingInstrumentId) {
    throw new BadRequestException("融资类资本事件必须关联融资工具");
  }

  assertOptionalNonNegativeInteger(dto.equityCapitalAmount, "自有资金金额必须大于等于 0");
  assertOptionalNonNegativeInteger(dto.debtPrincipalAmount, "债务本金金额必须大于等于 0");
  if (dto.acquisitionMode !== null) {
    assertAcquisitionMode(dto.acquisitionMode);
  }
}

function mergeCapitalEventUpdateInput(
  dto: UpdateVehicleCapitalEventDto,
  before: VehicleCapitalEventWithInstrument
): CreateVehicleCapitalEventDto {
  return {
    acquisitionMode: valueOrExisting(dto.acquisitionMode, before.acquisitionMode),
    debtPrincipalAmount: valueOrExisting(dto.debtPrincipalAmount, numberOrNull(before.debtPrincipalAmount)),
    effectiveFrom: dto.effectiveFrom ?? formatDateOnly(before.effectiveFrom),
    effectiveTo:
      dto.effectiveTo === undefined
        ? before.effectiveTo
          ? formatDateOnly(before.effectiveTo)
          : null
        : dto.effectiveTo,
    equityCapitalAmount: valueOrExisting(dto.equityCapitalAmount, numberOrNull(before.equityCapitalAmount)),
    eventType: dto.eventType ?? before.eventType,
    externalOwnerName: valueOrExisting(dto.externalOwnerName, before.externalOwnerName),
    financingInstrumentId: valueOrExisting(dto.financingInstrumentId, before.financingInstrumentId),
    lessorName: valueOrExisting(dto.lessorName, before.lessorName),
    managedOwnerName: valueOrExisting(dto.managedOwnerName, before.managedOwnerName),
    remark: valueOrExisting(dto.remark, before.remark)
  };
}

function buildCapitalEventData(
  dto: CreateVehicleCapitalEventDto,
  vehicle: VehicleWithHistory,
  financingInstrument: FinancingInstrument | null,
  eventStatus: VehicleCapitalEventStatus = VehicleCapitalEventStatus.ACTIVE
): Omit<Prisma.VehicleCapitalEventUncheckedCreateInput, "createdBy" | "eventNo" | "updatedBy" | "vehicleId"> {
  const effectiveFrom = parseDateOnly(dto.effectiveFrom, "effectiveFrom");
  const effectiveTo = parseOptionalDateOnly(dto.effectiveTo, "effectiveTo") ?? null;

  if (effectiveTo && effectiveTo.getTime() < effectiveFrom.getTime()) {
    throw new BadRequestException("effectiveTo 不能早于 effectiveFrom");
  }

  const fields = {
    acquisitionMode: dto.acquisitionMode ?? null,
    debtPrincipalAmount: optionalBigInt(dto.debtPrincipalAmount),
    effectiveFrom,
    effectiveTo,
    equityCapitalAmount: optionalBigInt(dto.equityCapitalAmount),
    eventStatus,
    eventType: dto.eventType,
    externalOwnerName: dto.externalOwnerName ?? null,
    financingInstrumentId: financingInstrument?.id ?? null,
    lessorName: dto.lessorName ?? null,
    managedOwnerName: dto.managedOwnerName ?? null,
    remark: dto.remark ?? null
  };

  return {
    ...fields,
    snapshot: buildCapitalEventSnapshot(vehicle, fields, financingInstrument)
  };
}

function capitalEventSnapshotFieldsFromRecord(
  event: VehicleCapitalEventWithInstrument,
  overrides: Partial<{
    eventStatus: VehicleCapitalEventStatus;
    remark: string | null;
  }> = {}
) {
  return {
    acquisitionMode: event.acquisitionMode,
    debtPrincipalAmount: event.debtPrincipalAmount,
    effectiveFrom: event.effectiveFrom,
    effectiveTo: event.effectiveTo,
    equityCapitalAmount: event.equityCapitalAmount,
    eventStatus: overrides.eventStatus ?? event.eventStatus,
    eventType: event.eventType,
    externalOwnerName: event.externalOwnerName,
    financingInstrumentId: event.financingInstrumentId,
    lessorName: event.lessorName,
    managedOwnerName: event.managedOwnerName,
    remark: overrides.remark ?? event.remark
  };
}

function buildCapitalEventSnapshot(
  vehicle: VehicleWithHistory,
  fields: {
    acquisitionMode: VehicleAcquisitionMode | null;
    debtPrincipalAmount: bigint | null;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    equityCapitalAmount: bigint | null;
    eventStatus: VehicleCapitalEventStatus;
    eventType: VehicleCapitalEventType;
    externalOwnerName: string | null;
    financingInstrumentId: string | null;
    lessorName: string | null;
    managedOwnerName: string | null;
    remark: string | null;
  },
  financingInstrument: FinancingInstrument | null
): Prisma.InputJsonObject {
  return {
    acquisitionMode: fields.acquisitionMode,
    debtPrincipalAmount: numberOrNull(fields.debtPrincipalAmount),
    effectiveFrom: formatDateOnly(fields.effectiveFrom),
    effectiveTo: fields.effectiveTo ? formatDateOnly(fields.effectiveTo) : null,
    equityCapitalAmount: numberOrNull(fields.equityCapitalAmount),
    eventStatus: fields.eventStatus,
    eventType: fields.eventType,
    externalOwnerName: fields.externalOwnerName,
    financingInstrumentId: fields.financingInstrumentId,
    financingInstrumentNo: financingInstrument?.instrumentNo ?? null,
    lessorName: fields.lessorName,
    managedOwnerName: fields.managedOwnerName,
    purchasePriceAmount: Number(vehicle.purchasePriceAmount),
    remark: fields.remark,
    vehicleId: vehicle.id,
    vehicleNo: vehicle.vehicleNo
  };
}

function buildCapitalStructurePreview(
  vehicle: VehicleWithHistory,
  capitalEvents: VehicleCapitalEventWithInstrument[],
  financingAllocations: FinancingAllocationWithInstrument[]
) {
  const debtPrincipalAmount = sumBigInt(
    financingAllocations.map((allocation) => allocation.allocatedPrincipalAmount)
  );
  const capitalEventEquityAmount = sumBigInt(
    capitalEvents.map((event) => event.equityCapitalAmount ?? 0n)
  );
  const hasCapitalEvents = capitalEvents.length > 0;
  const fallbackOwnedCashEquityAmount =
    !hasCapitalEvents &&
    debtPrincipalAmount === 0n &&
    vehicle.acquisitionMode === VehicleAcquisitionMode.OWNED_CASH &&
    vehicle.purchasePriceAmount > 0n
      ? vehicle.purchasePriceAmount
      : 0n;
  const equityCapitalAmount = capitalEventEquityAmount + fallbackOwnedCashEquityAmount;
  const capitalCoverageAmount = equityCapitalAmount + debtPrincipalAmount;
  const purchasePriceAmount = vehicle.purchasePriceAmount;
  const annualDebtInterestAmount = sumBigInt(
    financingAllocations.map((allocation) =>
      calculateInterestAmount(allocation.allocatedPrincipalAmount, allocation.instrument?.annualRateBps ?? 0)
    )
  );
  const missingReasons = buildCapitalStructureMissingReasons(
    vehicle,
    hasCapitalEvents,
    capitalCoverageAmount,
    financingAllocations
  );

  return {
    acquisitionMode: vehicle.acquisitionMode,
    activeCapitalEvents: capitalEvents.map(toCapitalEventView),
    activeFinancingAllocations: financingAllocations.map(toFinancingAllocationView),
    annualDebtInterestAmount: Number(annualDebtInterestAmount),
    capitalCoverageAmount: Number(capitalCoverageAmount),
    capitalCoverageIncomplete: purchasePriceAmount > 0n && capitalCoverageAmount < purchasePriceAmount,
    capitalCoverageRatio: ratioOrNull(capitalCoverageAmount, purchasePriceAmount),
    debtPrincipalAmount: Number(debtPrincipalAmount),
    debtRatio: ratioOrNull(debtPrincipalAmount, purchasePriceAmount),
    equityCapitalAmount: Number(equityCapitalAmount),
    equityRatio: ratioOrNull(equityCapitalAmount, purchasePriceAmount),
    financingInstruments: uniqueFinancingInstruments(financingAllocations),
    missingReasons,
    monthlyDebtInterestAmount: Number(annualDebtInterestAmount / 12n),
    purchasePriceAmount: Number(purchasePriceAmount),
    roeDataReady: missingReasons.length === 0,
    vehicleId: vehicle.id,
    vehicleNo: vehicle.vehicleNo
  };
}

function buildCapitalStructureMissingReasons(
  vehicle: VehicleWithHistory,
  hasCapitalEvents: boolean,
  capitalCoverageAmount: bigint,
  financingAllocations: FinancingAllocationWithInstrument[]
) {
  const missingReasons: string[] = [];

  if (!isPositiveBigInt(vehicle.purchasePriceAmount)) {
    missingReasons.push("车辆采购价缺失。");
  }

  if (!hasCapitalEvents) {
    missingReasons.push("尚未录入资本事件。");
  }

  if (vehicle.purchasePriceAmount > 0n && capitalCoverageAmount < vehicle.purchasePriceAmount) {
    missingReasons.push("资本覆盖金额小于车辆采购价。");
  }

  if (financingAllocations.some((allocation) => allocation.instrument?.annualRateBps === null)) {
    missingReasons.push("存在缺少年化利率的融资工具。");
  }

  if (vehicle.acquisitionMode === VehicleAcquisitionMode.LONG_TERM_LEASED) {
    missingReasons.push("外部长租固定成本模型待补充。");
  }

  if (vehicle.acquisitionMode === VehicleAcquisitionMode.MANAGED_REVENUE_SHARE) {
    missingReasons.push("托管分润模型待补充。");
  }

  return missingReasons;
}

function toCapitalEventView(event: VehicleCapitalEventWithInstrument) {
  return {
    acquisitionMode: event.acquisitionMode,
    createdAt: event.createdAt,
    createdBy: event.createdBy,
    debtPrincipalAmount: numberOrNull(event.debtPrincipalAmount),
    deletedAt: event.deletedAt,
    effectiveFrom: event.effectiveFrom,
    effectiveTo: event.effectiveTo,
    equityCapitalAmount: numberOrNull(event.equityCapitalAmount),
    eventNo: event.eventNo,
    eventStatus: event.eventStatus,
    eventType: event.eventType,
    externalOwnerName: event.externalOwnerName,
    financingInstrument: event.financingInstrument ? toFinancingInstrumentSummaryView(event.financingInstrument) : null,
    financingInstrumentId: event.financingInstrumentId,
    id: event.id,
    lessorName: event.lessorName,
    managedOwnerName: event.managedOwnerName,
    remark: event.remark,
    snapshot: event.snapshot,
    updatedAt: event.updatedAt,
    updatedBy: event.updatedBy,
    vehicleId: event.vehicleId
  };
}

function toCapitalEventAuditSnapshot(event: VehicleCapitalEventWithInstrument, remark: string | null | undefined) {
  return {
    event: toCapitalEventView(event),
    eventId: event.id,
    financingInstrumentId: event.financingInstrumentId,
    remark: remark ?? event.remark,
    vehicleId: event.vehicleId
  };
}

function toFinancingAllocationView(allocation: FinancingAllocationWithInstrument) {
  return {
    allocatedPrincipalAmount: Number(allocation.allocatedPrincipalAmount),
    allocationNo: allocation.allocationNo,
    allocationRatioBps: allocation.allocationRatioBps,
    allocationStatus: allocation.allocationStatus,
    createdAt: allocation.createdAt,
    deletedAt: allocation.deletedAt,
    effectiveFrom: allocation.effectiveFrom,
    effectiveTo: allocation.effectiveTo,
    financingInstrument: toFinancingInstrumentSummaryView(allocation.instrument),
    id: allocation.id,
    instrumentId: allocation.instrumentId,
    remark: allocation.remark,
    snapshot: allocation.snapshot,
    updatedAt: allocation.updatedAt,
    vehicleId: allocation.vehicleId
  };
}

function toFinancingInstrumentSummaryView(instrument: FinancingInstrument) {
  return {
    annualRateBps: instrument.annualRateBps,
    collateralType: instrument.collateralType,
    contractNo: instrument.contractNo,
    id: instrument.id,
    instrumentNo: instrument.instrumentNo,
    instrumentStatus: instrument.instrumentStatus,
    instrumentType: instrument.instrumentType,
    lenderName: instrument.lenderName,
    principalAmount: Number(instrument.principalAmount),
    repaymentMethod: instrument.repaymentMethod,
    startDate: instrument.startDate,
    termMonths: instrument.termMonths
  };
}

function uniqueFinancingInstruments(financingAllocations: FinancingAllocationWithInstrument[]) {
  const instruments = new Map<string, ReturnType<typeof toFinancingInstrumentSummaryView>>();

  for (const allocation of financingAllocations) {
    instruments.set(allocation.instrument.id, toFinancingInstrumentSummaryView(allocation.instrument));
  }

  return Array.from(instruments.values());
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

function sumBigInt(values: bigint[]) {
  return values.reduce((total, value) => total + value, 0n);
}

function calculateInterestAmount(amount: bigint, annualRateBps: number) {
  return (amount * BigInt(annualRateBps)) / 10000n;
}

function ratioOrNull(numerator: bigint, denominator: bigint) {
  return denominator > 0n ? Number(numerator) / Number(denominator) : null;
}

function numberOrNull(value: bigint | number | null | undefined) {
  return value === null || value === undefined ? null : Number(value);
}

function valueOrExisting<T>(value: T | undefined, existing: T) {
  return value === undefined ? existing : value;
}

function dateOnly(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}
