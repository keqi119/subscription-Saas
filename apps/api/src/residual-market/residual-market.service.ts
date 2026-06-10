import { createHash } from "node:crypto";

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  AuditAction,
  MarketPriceImportStatus,
  MarketPriceObservationStatus,
  MarketPriceSource,
  MarketPriceType,
  MarketSellerType,
  Prisma,
  VehicleBatteryUsageType,
  VehicleMarketPriceObservation,
  VehicleResidualCurve,
  VehicleResidualCurveMethod,
  VehicleResidualCurvePoint,
  VehicleResidualCurveStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import { parseCsvRecords } from "./csv-parser";
import {
  ActivateResidualCurveDto,
  ArchiveResidualCurveDto,
  CreateMarketPriceObservationDto,
  GenerateResidualCurveDto,
  ImportMarketPriceCsvDto,
  MarketPriceImportBatchesQueryDto,
  MarketPriceObservationsQueryDto,
  ResidualCurveQueryDto,
  VoidMarketPriceObservationDto
} from "./dto/residual-market.dto";

type CsvImportAction = "FAILED" | "IMPORTED" | "SKIPPED_DUPLICATE";

type CsvImportItem = {
  action: CsvImportAction;
  observationId?: string;
  reason: string;
  rowNumber: number;
};

type ObservationInput = {
  accidentFlag?: boolean | null | string;
  batteryCapacityKwh?: number | null | string;
  batteryHealthPercent?: number | null | string;
  batteryUsageType?: VehicleBatteryUsageType | null | string;
  brand?: string | null;
  city?: string | null;
  conditionGrade?: string | null;
  listingDays?: number | null | string;
  listingPriceAmount?: number | null | string;
  mileageKm?: number | null | string;
  model?: string | null;
  modelYear?: number | null | string;
  observedAt?: string | null;
  priceAmount?: number | null | string;
  priceType?: MarketPriceType | null | string;
  province?: string | null;
  registrationDate?: string | null;
  remark?: string | null;
  sellerType?: MarketSellerType | null | string;
  series?: string | null;
  source?: MarketPriceSource | null | string;
  sourceListingId?: string | null;
  sourceUrl?: string | null;
  sourceUrlHash?: string | null;
  transactionPriceAmount?: number | null | string;
  trim?: string | null;
  vehicleAgeMonths?: number | null | string;
};

type ObservationFields = {
  accidentFlag: boolean | null;
  batteryCapacityKwh: Prisma.Decimal | null;
  batteryHealthPercent: Prisma.Decimal | null;
  batteryUsageType: VehicleBatteryUsageType | null;
  brand: string;
  city: string | null;
  conditionGrade: string | null;
  listingDays: number | null;
  listingPriceAmount: bigint | null;
  mileageKm: number | null;
  model: string;
  modelYear: number | null;
  observedAt: Date;
  priceAmount: bigint;
  priceType: MarketPriceType;
  province: string | null;
  registrationDate: Date | null;
  remark: string | null;
  sellerType: MarketSellerType | null;
  series: string | null;
  source: MarketPriceSource;
  sourceListingId: string | null;
  sourceUrlHash: string | null;
  transactionPriceAmount: bigint | null;
  trim: string | null;
  vehicleAgeMonths: number | null;
};

type BuiltObservation = {
  data: Omit<Prisma.VehicleMarketPriceObservationUncheckedCreateInput, "createdBy" | "observationNo" | "updatedBy">;
  fields: ObservationFields;
};

type CurveGenerationInput = {
  batteryCapacityKwh: Prisma.Decimal | null;
  batteryUsageType: VehicleBatteryUsageType | null;
  brand: string;
  curveName: string | null;
  curveVersion: string | null;
  dryRun: boolean;
  minSamplePerPoint: number;
  model: string;
  modelYear: number | null;
  priceTypes: MarketPriceType[];
  referencePriceAmount: bigint | null;
  remark: string | null;
  sampleEndDate: Date | null;
  sampleStartDate: Date | null;
  series: string | null;
  trim: string | null;
};

type BuiltResidualCurvePoint = {
  ageMonth: number;
  averagePriceAmount: bigint;
  confidenceScore: number;
  lowerBoundAmount: bigint;
  maxPriceAmount: bigint;
  medianPriceAmount: bigint;
  mileageBucketEndKm: null;
  mileageBucketStartKm: null;
  minPriceAmount: bigint;
  p25PriceAmount: bigint;
  p75PriceAmount: bigint;
  pointSnapshot: Prisma.InputJsonObject;
  predictedResidualAmount: bigint;
  predictedResidualRateBps: number | null;
  sampleCount: number;
  upperBoundAmount: bigint;
};

type BuiltResidualCurve = {
  batteryCapacityKwh: Prisma.Decimal | null;
  batteryUsageType: VehicleBatteryUsageType | null;
  brand: string;
  confidenceScore: number | null;
  curveMethod: VehicleResidualCurveMethod;
  curveName: string | null;
  curveStatus: VehicleResidualCurveStatus;
  curveVersion: string | null;
  metrics: Prisma.InputJsonObject;
  model: string;
  modelYear: number | null;
  pointCount: number;
  priceTypes: Prisma.InputJsonArray;
  referencePriceAmount: bigint | null;
  remark: string | null;
  sampleCount: number;
  sampleEndDate: Date | null;
  sampleFilterSnapshot: Prisma.InputJsonObject;
  sampleStartDate: Date | null;
  series: string | null;
  snapshot: Prisma.InputJsonObject;
  trim: string | null;
};

type BuiltResidualCurvePreview = {
  curve: BuiltResidualCurve;
  pointCount: number;
  points: BuiltResidualCurvePoint[];
  sampleCount: number;
  skippedReasons: Prisma.InputJsonObject[];
  skippedSampleCount: number;
};

const OBSERVATION_ENTITY_TYPE = "vehicle_market_price_observation";
const BATCH_ENTITY_TYPE = "market_price_import_batch";
const CURVE_ENTITY_TYPE = "vehicle_residual_curve";
const RESIDUAL_MARKET_MODULE = "residual_market";
const DUPLICATE_MESSAGE = "该市场价格样本已存在，不能重复创建。";

const DEFAULT_CURVE_PRICE_TYPES = [
  MarketPriceType.TRANSACTION,
  MarketPriceType.AUCTION,
  MarketPriceType.DEALER_QUOTE,
  MarketPriceType.INTERNAL_SALE,
  MarketPriceType.LISTING
];

@Injectable()
export class ResidualMarketService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService
  ) {}

  async listObservations(query: MarketPriceObservationsQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = buildObservationWhere(query);

    const [total, observations] = await Promise.all([
      this.prisma.vehicleMarketPriceObservation.count({ where }),
      this.prisma.vehicleMarketPriceObservation.findMany({
        orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        where
      })
    ]);

    return {
      items: observations.map(toObservationView),
      page,
      pageSize,
      total
    };
  }

  async getObservation(id: string) {
    const observation = await this.prisma.vehicleMarketPriceObservation.findFirst({
      where: { deletedAt: null, id }
    });

    if (!observation) {
      throw new NotFoundException("市场价格样本不存在。");
    }

    return toObservationView(observation);
  }

  async createObservation(
    dto: CreateMarketPriceObservationDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const built = buildObservationData(dto, "fen");
    const duplicate = await this.findActiveDuplicate(built.data.dedupeKey);

    if (duplicate) {
      throw new BadRequestException(DUPLICATE_MESSAGE);
    }

    try {
      const observation = await withUniqueBusinessNoRetry(() =>
        this.prisma.vehicleMarketPriceObservation.create({
          data: {
            ...built.data,
            createdBy: user.id,
            observationNo: createBusinessNo("MPO"),
            updatedBy: user.id
          }
        })
      );

      await this.writeObservationAudit(
        AuditAction.CREATE,
        observation.id,
        undefined,
        toObservationView(observation),
        user,
        context,
        auditPayload(observation, { remark: dto.remark })
      );

      return toObservationView(observation);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new BadRequestException(DUPLICATE_MESSAGE);
      }
      throw error;
    }
  }

  async importCsv(dto: ImportMarketPriceCsvDto, user: RequestUser, context: RequestContext) {
    const source = parseEnumValue(MarketPriceSource, dto.source, "source");
    const records = parseCsvRecords(dto.csvText);
    const fileName = normalizeOptionalText(dto.fileName);
    const remark = normalizeOptionalText(dto.remark);
    const batch = await withUniqueBusinessNoRetry(() =>
      this.prisma.marketPriceImportBatch.create({
        data: {
          batchNo: createBusinessNo("MPB"),
          fileName,
          importedBy: user.id,
          remark,
          source,
          snapshot: {
            amountUnit: "yuan",
            fileName,
            importedBy: user.id,
            remark,
            source
          }
        }
      })
    );

    const items: CsvImportItem[] = [];
    const seenDedupeKeys = new Set<string>();

    for (const record of records) {
      try {
        const input = { ...record.values, source };
        const built = buildObservationData(input, "yuan", record.values);

        if (seenDedupeKeys.has(built.data.dedupeKey)) {
          items.push({
            action: "SKIPPED_DUPLICATE",
            reason: "重复样本，已跳过。",
            rowNumber: record.rowNumber
          });
          continue;
        }

        const duplicate = await this.findActiveDuplicate(built.data.dedupeKey);
        if (duplicate) {
          seenDedupeKeys.add(built.data.dedupeKey);
          items.push({
            action: "SKIPPED_DUPLICATE",
            observationId: duplicate.id,
            reason: "重复样本，已跳过。",
            rowNumber: record.rowNumber
          });
          continue;
        }

        const observation = await withUniqueBusinessNoRetry(() =>
          this.prisma.vehicleMarketPriceObservation.create({
            data: {
              ...built.data,
              batchId: batch.id,
              createdBy: user.id,
              observationNo: createBusinessNo("MPO"),
              updatedBy: user.id
            }
          })
        );

        seenDedupeKeys.add(built.data.dedupeKey);
        items.push({
          action: "IMPORTED",
          observationId: observation.id,
          reason: "-",
          rowNumber: record.rowNumber
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          items.push({
            action: "SKIPPED_DUPLICATE",
            reason: "重复样本，已跳过。",
            rowNumber: record.rowNumber
          });
          continue;
        }

        items.push({
          action: "FAILED",
          reason: error instanceof Error ? error.message : "导入失败。",
          rowNumber: record.rowNumber
        });
      }
    }

    const importedRows = items.filter((item) => item.action === "IMPORTED").length;
    const skippedRows = items.filter((item) => item.action === "SKIPPED_DUPLICATE").length;
    const failedRows = items.filter((item) => item.action === "FAILED").length;
    const importStatus = getImportStatus(importedRows, skippedRows, failedRows);
    const updatedBatch = await this.prisma.marketPriceImportBatch.update({
      data: {
        errorSnapshot:
          failedRows > 0
            ? {
                failedItems: items.filter((item) => item.action === "FAILED").slice(0, 50)
              }
            : Prisma.JsonNull,
        failedRows,
        importedRows,
        importStatus,
        skippedRows,
        totalRows: records.length
      },
      where: { id: batch.id }
    });

    await this.writeBatchAudit(
      AuditAction.CREATE,
      updatedBatch.id,
      undefined,
      {
        batch: toBatchView(updatedBatch),
        importedRows,
        sampleItems: items.slice(0, 20),
        skippedRows,
        totalRows: records.length
      },
      user,
      context
    );

    return {
      batch: toBatchView(updatedBatch),
      failedRows,
      importedRows,
      items,
      skippedRows,
      totalRows: records.length
    };
  }

  async voidObservation(
    id: string,
    dto: VoidMarketPriceObservationDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.prisma.vehicleMarketPriceObservation.findFirst({
      where: { deletedAt: null, id }
    });

    if (!before) {
      throw new NotFoundException("市场价格样本不存在。");
    }

    if (before.observationStatus === MarketPriceObservationStatus.VOIDED) {
      throw new BadRequestException("该市场价格样本已作废，不能重复作废。");
    }

    const observation = await this.prisma.vehicleMarketPriceObservation.update({
      data: {
        observationStatus: MarketPriceObservationStatus.VOIDED,
        remark: mergeRemark(before.remark, dto.remark),
        updatedBy: user.id
      },
      where: { id }
    });

    await this.writeObservationAudit(
      AuditAction.UPDATE,
      id,
      toObservationView(before),
      toObservationView(observation),
      user,
      context,
      auditPayload(observation, { remark: dto.remark })
    );

    return toObservationView(observation);
  }

  async listImportBatches(query: MarketPriceImportBatchesQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = buildBatchWhere(query);

    const [total, batches] = await Promise.all([
      this.prisma.marketPriceImportBatch.count({ where }),
      this.prisma.marketPriceImportBatch.findMany({
        orderBy: [{ createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        where
      })
    ]);

    return {
      items: batches.map(toBatchView),
      page,
      pageSize,
      total
    };
  }

  async getImportBatch(id: string) {
    const [batch, observationCount] = await Promise.all([
      this.prisma.marketPriceImportBatch.findFirst({
        where: { deletedAt: null, id }
      }),
      this.prisma.vehicleMarketPriceObservation.count({
        where: { batchId: id, deletedAt: null }
      })
    ]);

    if (!batch) {
      throw new NotFoundException("市场价格导入批次不存在。");
    }

    return toBatchView(batch, observationCount);
  }

  async generateCurve(dto: GenerateResidualCurveDto, user: RequestUser, context: RequestContext) {
    const input = buildCurveGenerationInput(dto);
    const observations = await this.prisma.vehicleMarketPriceObservation.findMany({
      orderBy: [{ observedAt: "asc" }, { createdAt: "asc" }],
      where: buildCurveObservationWhere(input)
    });
    const preview = buildResidualCurvePreview(input, observations);

    if (preview.pointCount === 0) {
      throw new BadRequestException("符合条件的样本不足，无法生成残值曲线。");
    }

    if (input.dryRun) {
      return curveGenerationResponse(true, toCurvePreviewView(preview.curve), preview.points, preview);
    }

    const curve = await withUniqueBusinessNoRetry(() =>
      this.prisma.vehicleResidualCurve.create({
        data: {
          batteryCapacityKwh: preview.curve.batteryCapacityKwh,
          batteryUsageType: preview.curve.batteryUsageType,
          brand: preview.curve.brand,
          confidenceScore: preview.curve.confidenceScore,
          createdBy: user.id,
          curveMethod: preview.curve.curveMethod,
          curveName: preview.curve.curveName,
          curveNo: createBusinessNo("RVC"),
          curveStatus: VehicleResidualCurveStatus.DRAFT,
          curveVersion: preview.curve.curveVersion,
          metrics: preview.curve.metrics,
          model: preview.curve.model,
          modelYear: preview.curve.modelYear,
          pointCount: preview.curve.pointCount,
          points: { create: preview.points.map(toCurvePointCreateInput) },
          priceTypes: preview.curve.priceTypes,
          referencePriceAmount: preview.curve.referencePriceAmount,
          remark: preview.curve.remark,
          sampleCount: preview.curve.sampleCount,
          sampleEndDate: preview.curve.sampleEndDate,
          sampleFilterSnapshot: preview.curve.sampleFilterSnapshot,
          sampleStartDate: preview.curve.sampleStartDate,
          series: preview.curve.series,
          snapshot: preview.curve.snapshot,
          trim: preview.curve.trim,
          updatedBy: user.id
        },
        include: {
          points: { orderBy: { ageMonth: "asc" } }
        }
      })
    );

    await this.writeCurveAudit(
      AuditAction.CREATE,
      curve.id,
      undefined,
      toCurveView(curve),
      user,
      context,
      curveAuditPayload(curve, { remark: dto.remark })
    );

    return curveGenerationResponse(false, toCurveView(curve), curve.points, preview);
  }

  async listCurves(query: ResidualCurveQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = buildCurveWhere(query);

    const [total, curves] = await Promise.all([
      this.prisma.vehicleResidualCurve.count({ where }),
      this.prisma.vehicleResidualCurve.findMany({
        orderBy: [{ generatedAt: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        where
      })
    ]);

    return {
      items: curves.map(toCurveView),
      page,
      pageSize,
      total
    };
  }

  async getCurve(id: string) {
    const curve = await this.prisma.vehicleResidualCurve.findFirst({
      include: {
        points: { orderBy: { ageMonth: "asc" } }
      },
      where: { deletedAt: null, id }
    });

    if (!curve) {
      throw new NotFoundException("残值曲线不存在。");
    }

    return toCurveView(curve);
  }

  async activateCurve(
    id: string,
    dto: ActivateResidualCurveDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.prisma.vehicleResidualCurve.findFirst({
      where: { deletedAt: null, id }
    });

    if (!before) {
      throw new NotFoundException("残值曲线不存在。");
    }

    if (before.curveStatus === VehicleResidualCurveStatus.ARCHIVED) {
      throw new BadRequestException("已归档的残值曲线不能启用。");
    }

    const effectiveFrom = parseDateOnly(dto.effectiveFrom, "effectiveFrom");
    const curve = await this.prisma.$transaction(async (tx) => {
      await tx.vehicleResidualCurve.updateMany({
        data: {
          curveStatus: VehicleResidualCurveStatus.SUPERSEDED,
          updatedBy: user.id
        },
        where: {
          ...sameCurveDimensionWhere(before),
          curveStatus: VehicleResidualCurveStatus.ACTIVE,
          id: { not: id }
        }
      });

      return tx.vehicleResidualCurve.update({
        data: {
          curveStatus: VehicleResidualCurveStatus.ACTIVE,
          effectiveFrom,
          remark: mergeOperationRemark(before.remark, dto.remark),
          updatedBy: user.id
        },
        include: {
          points: { orderBy: { ageMonth: "asc" } }
        },
        where: { id }
      });
    });

    await this.writeCurveAudit(
      AuditAction.UPDATE,
      curve.id,
      toCurveView(before),
      toCurveView(curve),
      user,
      context,
      curveAuditPayload(curve, { remark: dto.remark })
    );

    return toCurveView(curve);
  }

  async archiveCurve(
    id: string,
    dto: ArchiveResidualCurveDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.prisma.vehicleResidualCurve.findFirst({
      where: { deletedAt: null, id }
    });

    if (!before) {
      throw new NotFoundException("残值曲线不存在。");
    }

    if (before.curveStatus === VehicleResidualCurveStatus.ARCHIVED) {
      throw new BadRequestException("该残值曲线已归档，不能重复归档。");
    }

    const curve = await this.prisma.vehicleResidualCurve.update({
      data: {
        curveStatus: VehicleResidualCurveStatus.ARCHIVED,
        effectiveTo: todayDateOnly(),
        remark: mergeOperationRemark(before.remark, dto.remark),
        updatedBy: user.id
      },
      include: {
        points: { orderBy: { ageMonth: "asc" } }
      },
      where: { id }
    });

    await this.writeCurveAudit(
      AuditAction.UPDATE,
      curve.id,
      toCurveView(before),
      toCurveView(curve),
      user,
      context,
      curveAuditPayload(curve, { remark: dto.remark })
    );

    return toCurveView(curve);
  }

  private findActiveDuplicate(dedupeKey: string) {
    return this.prisma.vehicleMarketPriceObservation.findFirst({
      where: {
        dedupeKey,
        deletedAt: null,
        observationStatus: MarketPriceObservationStatus.ACTIVE
      }
    });
  }

  private async writeObservationAudit(
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
      entityType: OBSERVATION_ENTITY_TYPE,
      ipAddress: context.ipAddress,
      module: RESIDUAL_MARKET_MODULE,
      operatorId: user.id,
      userAgent: context.userAgent
    });
  }

  private async writeBatchAudit(
    action: AuditAction,
    entityId: string,
    before: unknown,
    after: unknown,
    user: RequestUser,
    context: RequestContext
  ) {
    await this.auditService.write({
      action,
      after,
      before,
      entityId,
      entityType: BATCH_ENTITY_TYPE,
      ipAddress: context.ipAddress,
      module: RESIDUAL_MARKET_MODULE,
      operatorId: user.id,
      userAgent: context.userAgent
    });
  }

  private async writeCurveAudit(
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
      entityType: CURVE_ENTITY_TYPE,
      ipAddress: context.ipAddress,
      module: RESIDUAL_MARKET_MODULE,
      operatorId: user.id,
      userAgent: context.userAgent
    });
  }
}

function buildObservationData(
  input: ObservationInput,
  amountUnit: "fen" | "yuan",
  rawRecord?: Record<string, string>
): BuiltObservation {
  const source = parseEnumValue(MarketPriceSource, input.source, "source");
  const sourceListingId = normalizeOptionalText(input.sourceListingId);
  const observedAt = parseDateOnly(input.observedAt, "observedAt");
  const brand = requiredText(input.brand, "brand");
  const model = requiredText(input.model, "model");
  const fields: ObservationFields = {
    accidentFlag: parseOptionalBoolean(input.accidentFlag, "accidentFlag"),
    batteryCapacityKwh: optionalDecimal(input.batteryCapacityKwh, "batteryCapacityKwh", 0),
    batteryHealthPercent: optionalDecimal(input.batteryHealthPercent, "batteryHealthPercent", 0, 100),
    batteryUsageType: parseOptionalEnumValue(VehicleBatteryUsageType, input.batteryUsageType, "batteryUsageType"),
    brand,
    city: normalizeOptionalText(input.city),
    conditionGrade: normalizeOptionalText(input.conditionGrade),
    listingDays: optionalInteger(input.listingDays, "listingDays", 0),
    listingPriceAmount:
      amountUnit === "yuan"
        ? optionalYuanAmountToFen(input.listingPriceAmount, "listingPriceAmount")
        : optionalFenAmount(input.listingPriceAmount, "listingPriceAmount"),
    mileageKm: optionalInteger(input.mileageKm, "mileageKm", 0),
    model,
    modelYear: optionalInteger(input.modelYear, "modelYear", 0),
    observedAt,
    priceAmount:
      amountUnit === "yuan"
        ? requiredYuanAmountToFen(input.priceAmount, "priceAmount")
        : requiredFenAmount(input.priceAmount, "priceAmount"),
    priceType: parseEnumValue(MarketPriceType, input.priceType, "priceType"),
    province: normalizeOptionalText(input.province),
    registrationDate: parseOptionalDateOnly(input.registrationDate, "registrationDate"),
    remark: normalizeOptionalText(input.remark),
    sellerType: parseOptionalEnumValue(MarketSellerType, input.sellerType, "sellerType"),
    series: normalizeOptionalText(input.series),
    source,
    sourceListingId,
    sourceUrlHash: normalizeOptionalText(input.sourceUrlHash) ?? hashOptionalText(input.sourceUrl),
    transactionPriceAmount:
      amountUnit === "yuan"
        ? optionalYuanAmountToFen(input.transactionPriceAmount, "transactionPriceAmount")
        : optionalFenAmount(input.transactionPriceAmount, "transactionPriceAmount"),
    trim: normalizeOptionalText(input.trim),
    vehicleAgeMonths: optionalInteger(input.vehicleAgeMonths, "vehicleAgeMonths", 0)
  };

  const dedupeKey = buildDedupeKey(fields);
  const confidenceScore = calculateConfidenceScore(fields);

  return {
    data: {
      ...fields,
      confidenceScore,
      dedupeKey,
      observationStatus: MarketPriceObservationStatus.ACTIVE,
      rawSnapshot: buildRawSnapshot(fields, amountUnit, rawRecord, input.sourceUrl)
    },
    fields
  };
}

function buildObservationWhere(query: MarketPriceObservationsQueryDto): Prisma.VehicleMarketPriceObservationWhereInput {
  const observedAt: Prisma.DateTimeFilter = {};
  assignDateFilter(observedAt, "gte", query.startDate);
  assignDateFilter(observedAt, "lte", query.endDate);
  const mileageKm: Prisma.IntNullableFilter = {};
  assignNumberFilter(mileageKm, "gte", query.minMileageKm);
  assignNumberFilter(mileageKm, "lte", query.maxMileageKm);
  const priceAmount: Prisma.BigIntFilter = {};
  assignBigIntFilter(priceAmount, "gte", query.minPriceAmount);
  assignBigIntFilter(priceAmount, "lte", query.maxPriceAmount);

  return {
    brand: query.brand ? { contains: query.brand, mode: "insensitive" } : undefined,
    city: query.city ? { contains: query.city, mode: "insensitive" } : undefined,
    deletedAt: null,
    mileageKm: hasFilter(mileageKm) ? mileageKm : undefined,
    model: query.model ? { contains: query.model, mode: "insensitive" } : undefined,
    modelYear: query.modelYear,
    observationStatus: query.observationStatus,
    observedAt: hasFilter(observedAt) ? observedAt : undefined,
    priceAmount: hasFilter(priceAmount) ? priceAmount : undefined,
    priceType: query.priceType,
    series: query.series ? { contains: query.series, mode: "insensitive" } : undefined,
    source: query.source
  };
}

function buildBatchWhere(query: MarketPriceImportBatchesQueryDto): Prisma.MarketPriceImportBatchWhereInput {
  const createdAt: Prisma.DateTimeFilter = {};
  if (query.startDate) {
    createdAt.gte = parseDateOnly(query.startDate, "startDate");
  }
  if (query.endDate) {
    createdAt.lte = endOfDateOnly(parseDateOnly(query.endDate, "endDate"));
  }

  return {
    createdAt: hasFilter(createdAt) ? createdAt : undefined,
    deletedAt: null,
    importStatus: query.importStatus,
    source: query.source
  };
}

function buildCurveGenerationInput(dto: GenerateResidualCurveDto): CurveGenerationInput {
  const priceTypes = (dto.priceTypes && dto.priceTypes.length > 0 ? dto.priceTypes : DEFAULT_CURVE_PRICE_TYPES).map(
    (priceType) => parseEnumValue(MarketPriceType, priceType, "priceTypes")
  );
  const sampleStartDate = parseOptionalDateOnly(dto.sampleStartDate, "sampleStartDate");
  const sampleEndDate = parseOptionalDateOnly(dto.sampleEndDate, "sampleEndDate");

  if (sampleStartDate && sampleEndDate && sampleStartDate > sampleEndDate) {
    throw new BadRequestException("sampleStartDate 不能晚于 sampleEndDate。");
  }

  const referencePriceAmount = optionalFenAmount(dto.referencePriceAmount, "referencePriceAmount");
  if (referencePriceAmount !== null && referencePriceAmount <= 0n) {
    throw new BadRequestException("referencePriceAmount 必须大于 0。");
  }

  return {
    batteryCapacityKwh: optionalDecimal(dto.batteryCapacityKwh, "batteryCapacityKwh", 0),
    batteryUsageType: parseOptionalEnumValue(VehicleBatteryUsageType, dto.batteryUsageType, "batteryUsageType"),
    brand: requiredText(dto.brand, "brand"),
    curveName: normalizeOptionalText(dto.curveName),
    curveVersion: normalizeOptionalText(dto.curveVersion),
    dryRun: dto.dryRun ?? false,
    minSamplePerPoint: optionalInteger(dto.minSamplePerPoint, "minSamplePerPoint", 1) ?? 3,
    model: requiredText(dto.model, "model"),
    modelYear: optionalInteger(dto.modelYear, "modelYear", 0),
    priceTypes,
    referencePriceAmount,
    remark: normalizeOptionalText(dto.remark),
    sampleEndDate,
    sampleStartDate,
    series: normalizeOptionalText(dto.series),
    trim: normalizeOptionalText(dto.trim)
  };
}

function buildCurveObservationWhere(input: CurveGenerationInput): Prisma.VehicleMarketPriceObservationWhereInput {
  const observedAt: Prisma.DateTimeFilter = {};
  if (input.sampleStartDate) {
    observedAt.gte = input.sampleStartDate;
  }
  if (input.sampleEndDate) {
    observedAt.lte = input.sampleEndDate;
  }

  return {
    batteryCapacityKwh: input.batteryCapacityKwh ?? undefined,
    batteryUsageType: input.batteryUsageType ?? undefined,
    brand: exactTextFilter(input.brand),
    deletedAt: null,
    model: exactTextFilter(input.model),
    modelYear: input.modelYear ?? undefined,
    observationStatus: MarketPriceObservationStatus.ACTIVE,
    observedAt: hasFilter(observedAt) ? observedAt : undefined,
    priceType: { in: input.priceTypes },
    series: input.series ? exactTextFilter(input.series) : undefined,
    trim: input.trim ? exactTextFilter(input.trim) : undefined
  };
}

function buildCurveWhere(query: ResidualCurveQueryDto): Prisma.VehicleResidualCurveWhereInput {
  return {
    batteryUsageType: query.batteryUsageType,
    brand: query.brand ? { contains: query.brand, mode: "insensitive" } : undefined,
    curveMethod: query.curveMethod,
    curveStatus: query.curveStatus,
    deletedAt: null,
    model: query.model ? { contains: query.model, mode: "insensitive" } : undefined,
    modelYear: query.modelYear,
    series: query.series ? { contains: query.series, mode: "insensitive" } : undefined
  };
}

function buildResidualCurvePreview(
  input: CurveGenerationInput,
  observations: VehicleMarketPriceObservation[]
): BuiltResidualCurvePreview {
  const groups = new Map<number, VehicleMarketPriceObservation[]>();
  const skippedReasons: Prisma.InputJsonObject[] = [];
  let skippedSampleCount = 0;
  let missingAgeCount = 0;

  for (const observation of observations) {
    const ageMonth = resolveAgeMonth(observation);

    if (ageMonth === null) {
      missingAgeCount += 1;
      skippedSampleCount += 1;
      continue;
    }

    const group = groups.get(ageMonth) ?? [];
    group.push(observation);
    groups.set(ageMonth, group);
  }

  if (missingAgeCount > 0) {
    skippedReasons.push({
      count: missingAgeCount,
      reason: "AGE_MONTH_MISSING"
    });
  }

  const points: BuiltResidualCurvePoint[] = [];

  for (const [ageMonth, samples] of [...groups.entries()].sort(([left], [right]) => left - right)) {
    if (samples.length < input.minSamplePerPoint) {
      skippedSampleCount += samples.length;
      skippedReasons.push({
        ageMonth,
        count: samples.length,
        minSamplePerPoint: input.minSamplePerPoint,
        reason: "MIN_SAMPLE_PER_POINT"
      });
      continue;
    }

    points.push(buildResidualCurvePoint(ageMonth, samples, input.referencePriceAmount));
  }

  const confidenceScore = points.length > 0
    ? Math.round(points.reduce((sum, point) => sum + point.confidenceScore, 0) / points.length)
    : null;
  const sampleFilterSnapshot = curveFilterSnapshot(input);
  const curve: BuiltResidualCurve = {
    batteryCapacityKwh: input.batteryCapacityKwh,
    batteryUsageType: input.batteryUsageType,
    brand: input.brand,
    confidenceScore,
    curveMethod: VehicleResidualCurveMethod.STATISTICAL_MEDIAN,
    curveName: input.curveName ?? defaultCurveName(input),
    curveStatus: VehicleResidualCurveStatus.DRAFT,
    curveVersion: input.curveVersion,
    metrics: {
      ageMonthPointCount: points.length,
      amountUnit: "fen",
      method: VehicleResidualCurveMethod.STATISTICAL_MEDIAN,
      minSamplePerPoint: input.minSamplePerPoint,
      residualRateUnit: "bps",
      skippedReasons,
      skippedSampleCount
    },
    model: input.model,
    modelYear: input.modelYear,
    pointCount: points.length,
    priceTypes: input.priceTypes,
    referencePriceAmount: input.referencePriceAmount,
    remark: input.remark,
    sampleCount: observations.length,
    sampleEndDate: input.sampleEndDate,
    sampleFilterSnapshot,
    sampleStartDate: input.sampleStartDate,
    series: input.series,
    snapshot: {
      curveBasis: "VehicleMarketPriceObservation ACTIVE observations",
      firstVersionScope: "ageMonth aggregation without mileage buckets",
      sampleFilterSnapshot,
      statisticFields: ["medianPriceAmount", "p25PriceAmount", "p75PriceAmount", "averagePriceAmount"]
    },
    trim: input.trim
  };

  return {
    curve,
    pointCount: points.length,
    points,
    sampleCount: observations.length,
    skippedReasons,
    skippedSampleCount
  };
}

function buildResidualCurvePoint(
  ageMonth: number,
  samples: VehicleMarketPriceObservation[],
  referencePriceAmount: bigint | null
): BuiltResidualCurvePoint {
  const prices = samples.map((sample) => Number(sample.priceAmount)).sort((left, right) => left - right);
  const medianPriceAmount = BigInt(percentile(prices, 0.5));
  const p25PriceAmount = BigInt(percentile(prices, 0.25));
  const p75PriceAmount = BigInt(percentile(prices, 0.75));
  const averagePriceAmount = BigInt(Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length));
  const minPriceAmount = BigInt(prices[0] ?? 0);
  const maxPriceAmount = BigInt(prices[prices.length - 1] ?? 0);
  const predictedResidualRateBps =
    referencePriceAmount && referencePriceAmount > 0n
      ? Math.round(Number(medianPriceAmount) / Number(referencePriceAmount) * 10000)
      : null;
  const averageObservationConfidence =
    samples.reduce((sum, sample) => sum + (sample.confidenceScore ?? 50), 0) / samples.length;
  const confidenceScore = Math.min(
    100,
    Math.round(averageObservationConfidence * 0.6 + Math.min(samples.length * 5, 40))
  );

  return {
    ageMonth,
    averagePriceAmount,
    confidenceScore,
    lowerBoundAmount: p25PriceAmount,
    maxPriceAmount,
    medianPriceAmount,
    mileageBucketEndKm: null,
    mileageBucketStartKm: null,
    minPriceAmount,
    p25PriceAmount,
    p75PriceAmount,
    pointSnapshot: {
      mileageStats: mileageStats(samples),
      sampleObservationIds: samples.map((sample) => sample.id),
      sourcePriceAmounts: prices
    },
    predictedResidualAmount: medianPriceAmount,
    predictedResidualRateBps,
    sampleCount: samples.length,
    upperBoundAmount: p75PriceAmount
  };
}

function resolveAgeMonth(observation: VehicleMarketPriceObservation) {
  if (observation.vehicleAgeMonths !== null && observation.vehicleAgeMonths !== undefined) {
    return observation.vehicleAgeMonths >= 0 ? observation.vehicleAgeMonths : null;
  }

  if (!observation.registrationDate || !observation.observedAt) {
    return null;
  }

  const ageMonth =
    (observation.observedAt.getUTCFullYear() - observation.registrationDate.getUTCFullYear()) * 12 +
    (observation.observedAt.getUTCMonth() - observation.registrationDate.getUTCMonth());

  return ageMonth >= 0 ? ageMonth : null;
}

function percentile(sortedValues: number[], ratio: number) {
  if (sortedValues.length === 0) {
    return 0;
  }
  if (sortedValues.length === 1) {
    return sortedValues[0] ?? 0;
  }

  const index = (sortedValues.length - 1) * ratio;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = sortedValues[lowerIndex] ?? 0;
  const upper = sortedValues[upperIndex] ?? lower;

  if (lowerIndex === upperIndex) {
    return lower;
  }

  return Math.round(lower + (upper - lower) * (index - lowerIndex));
}

function mileageStats(samples: VehicleMarketPriceObservation[]) {
  const mileages = samples
    .map((sample) => sample.mileageKm)
    .filter((mileage): mileage is number => mileage !== null && mileage !== undefined);

  if (mileages.length === 0) {
    return {
      averageMileageKm: null,
      maxMileageKm: null,
      minMileageKm: null,
      sampleCount: 0
    };
  }

  return {
    averageMileageKm: Math.round(mileages.reduce((sum, mileage) => sum + mileage, 0) / mileages.length),
    maxMileageKm: Math.max(...mileages),
    minMileageKm: Math.min(...mileages),
    sampleCount: mileages.length
  };
}

function curveFilterSnapshot(input: CurveGenerationInput): Prisma.InputJsonObject {
  return {
    batteryCapacityKwh: decimalToNumber(input.batteryCapacityKwh),
    batteryUsageType: input.batteryUsageType,
    brand: input.brand,
    model: input.model,
    modelYear: input.modelYear,
    priceTypes: input.priceTypes,
    referencePriceAmount: numberOrNull(input.referencePriceAmount),
    sampleEndDate: input.sampleEndDate ? formatDateOnly(input.sampleEndDate) : null,
    sampleStartDate: input.sampleStartDate ? formatDateOnly(input.sampleStartDate) : null,
    series: input.series,
    trim: input.trim
  };
}

function defaultCurveName(input: CurveGenerationInput) {
  return [input.brand, input.series, input.model, input.modelYear, decimalToNumber(input.batteryCapacityKwh), input.batteryUsageType]
    .filter((part) => part !== null && part !== undefined && part !== "")
    .join(" ");
}

function exactTextFilter(value: string): Prisma.StringFilter {
  return { equals: value, mode: "insensitive" };
}

function sameCurveDimensionWhere(curve: Pick<
  VehicleResidualCurve,
  "batteryCapacityKwh" | "batteryUsageType" | "brand" | "model" | "modelYear" | "series" | "trim"
>): Prisma.VehicleResidualCurveWhereInput {
  return {
    batteryCapacityKwh: curve.batteryCapacityKwh,
    batteryUsageType: curve.batteryUsageType,
    brand: curve.brand,
    deletedAt: null,
    model: curve.model,
    modelYear: curve.modelYear,
    series: curve.series,
    trim: curve.trim
  };
}

function todayDateOnly() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function assignDateFilter(filter: Prisma.DateTimeFilter, key: "gte" | "lte", value: string | undefined) {
  if (value) {
    filter[key] = parseDateOnly(value, key === "gte" ? "startDate" : "endDate");
  }
}

function assignNumberFilter(filter: Prisma.IntNullableFilter, key: "gte" | "lte", value: number | undefined) {
  if (value !== undefined) {
    filter[key] = value;
  }
}

function assignBigIntFilter(filter: Prisma.BigIntFilter, key: "gte" | "lte", value: number | undefined) {
  if (value !== undefined) {
    filter[key] = BigInt(value);
  }
}

function hasFilter(filter: object) {
  return Object.keys(filter).length > 0;
}

function getImportStatus(importedRows: number, skippedRows: number, failedRows: number) {
  if (failedRows === 0) {
    return MarketPriceImportStatus.COMPLETED;
  }

  return importedRows > 0 || skippedRows > 0
    ? MarketPriceImportStatus.PARTIAL_FAILED
    : MarketPriceImportStatus.FAILED;
}

function buildDedupeKey(fields: ObservationFields) {
  if (fields.sourceListingId) {
    return `${fields.source}:${normalizeKeyPart(fields.sourceListingId)}`;
  }

  return [
    fields.source,
    formatDateOnly(fields.observedAt),
    fields.brand,
    fields.series,
    fields.model,
    fields.modelYear,
    fields.mileageKm,
    fields.city,
    fields.priceType,
    fields.priceAmount.toString()
  ]
    .map(normalizeKeyPart)
    .join(":");
}

export function calculateConfidenceScore(fields: {
  batteryCapacityKwh?: Prisma.Decimal | null;
  brand?: string | null;
  city?: string | null;
  mileageKm?: number | null;
  model?: string | null;
  observedAt?: Date | null;
  priceAmount?: bigint | null;
  registrationDate?: Date | null;
  vehicleAgeMonths?: number | null;
}) {
  let score = 40;

  if (fields.brand && fields.model) {
    score += 10;
  }
  if (fields.observedAt) {
    score += 10;
  }
  if (fields.priceAmount && fields.priceAmount > 0n) {
    score += 10;
  }
  if (fields.mileageKm !== null && fields.mileageKm !== undefined) {
    score += 10;
  }
  if (fields.registrationDate || fields.vehicleAgeMonths !== null && fields.vehicleAgeMonths !== undefined) {
    score += 10;
  }
  if (fields.batteryCapacityKwh) {
    score += 5;
  }
  if (fields.city) {
    score += 5;
  }

  return Math.min(score, 100);
}

function buildRawSnapshot(
  fields: ObservationFields,
  amountUnit: "fen" | "yuan",
  rawRecord?: Record<string, string>,
  sourceUrl?: string | null
): Prisma.InputJsonObject {
  return {
    amountUnit,
    normalized: observationSnapshot(fields),
    rawRecord: rawRecord ?? null,
    sourceUrl: normalizeOptionalText(sourceUrl)
  };
}

function observationSnapshot(fields: ObservationFields): Prisma.InputJsonObject {
  return {
    accidentFlag: fields.accidentFlag,
    batteryCapacityKwh: decimalToNumber(fields.batteryCapacityKwh),
    batteryHealthPercent: decimalToNumber(fields.batteryHealthPercent),
    batteryUsageType: fields.batteryUsageType,
    brand: fields.brand,
    city: fields.city,
    conditionGrade: fields.conditionGrade,
    listingDays: fields.listingDays,
    listingPriceAmount: numberOrNull(fields.listingPriceAmount),
    mileageKm: fields.mileageKm,
    model: fields.model,
    modelYear: fields.modelYear,
    observedAt: formatDateOnly(fields.observedAt),
    priceAmount: Number(fields.priceAmount),
    priceType: fields.priceType,
    province: fields.province,
    registrationDate: fields.registrationDate ? formatDateOnly(fields.registrationDate) : null,
    remark: fields.remark,
    sellerType: fields.sellerType,
    series: fields.series,
    source: fields.source,
    sourceListingId: fields.sourceListingId,
    sourceUrlHash: fields.sourceUrlHash,
    transactionPriceAmount: numberOrNull(fields.transactionPriceAmount),
    trim: fields.trim,
    vehicleAgeMonths: fields.vehicleAgeMonths
  };
}

function auditPayload(
  observation: Pick<
    VehicleMarketPriceObservation,
    "batchId" | "brand" | "id" | "model" | "priceAmount" | "source"
  >,
  extra: { remark?: string | null }
) {
  return {
    batchId: observation.batchId,
    brand: observation.brand,
    model: observation.model,
    observationId: observation.id,
    priceAmount: Number(observation.priceAmount),
    remark: extra.remark ?? null,
    source: observation.source
  };
}

function toObservationView(observation: VehicleMarketPriceObservation) {
  return {
    accidentFlag: observation.accidentFlag,
    batchId: observation.batchId,
    batteryCapacityKwh: decimalToNumber(observation.batteryCapacityKwh),
    batteryHealthPercent: decimalToNumber(observation.batteryHealthPercent),
    batteryUsageType: observation.batteryUsageType,
    brand: observation.brand,
    city: observation.city,
    conditionGrade: observation.conditionGrade,
    confidenceScore: observation.confidenceScore,
    createdAt: observation.createdAt.toISOString(),
    createdBy: observation.createdBy,
    dedupeKey: observation.dedupeKey,
    id: observation.id,
    listingDays: observation.listingDays,
    listingPriceAmount: numberOrNull(observation.listingPriceAmount),
    mileageKm: observation.mileageKm,
    model: observation.model,
    modelYear: observation.modelYear,
    observationNo: observation.observationNo,
    observationStatus: observation.observationStatus,
    observedAt: formatDateOnly(observation.observedAt),
    priceAmount: Number(observation.priceAmount),
    priceType: observation.priceType,
    province: observation.province,
    rawSnapshot: observation.rawSnapshot,
    registrationDate: observation.registrationDate ? formatDateOnly(observation.registrationDate) : null,
    remark: observation.remark,
    sellerType: observation.sellerType,
    series: observation.series,
    source: observation.source,
    sourceListingId: observation.sourceListingId,
    sourceUrlHash: observation.sourceUrlHash,
    transactionPriceAmount: numberOrNull(observation.transactionPriceAmount),
    trim: observation.trim,
    updatedAt: observation.updatedAt.toISOString(),
    updatedBy: observation.updatedBy,
    vehicleAgeMonths: observation.vehicleAgeMonths
  };
}

function toBatchView(
  batch: {
    batchNo: string;
    createdAt: Date;
    deletedAt: Date | null;
    errorSnapshot: Prisma.JsonValue | null;
    failedRows: number;
    fileName: string | null;
    id: string;
    importedBy: string | null;
    importedRows: number;
    importStatus: MarketPriceImportStatus;
    remark: string | null;
    skippedRows: number;
    snapshot: Prisma.JsonValue | null;
    source: MarketPriceSource;
    totalRows: number;
    updatedAt: Date;
  },
  observationCount?: number
) {
  return {
    batchNo: batch.batchNo,
    createdAt: batch.createdAt.toISOString(),
    errorSnapshot: batch.errorSnapshot,
    failedRows: batch.failedRows,
    fileName: batch.fileName,
    id: batch.id,
    importedBy: batch.importedBy,
    importedRows: batch.importedRows,
    importStatus: batch.importStatus,
    observationCount,
    remark: batch.remark,
    skippedRows: batch.skippedRows,
    snapshot: batch.snapshot,
    source: batch.source,
    totalRows: batch.totalRows,
    updatedAt: batch.updatedAt.toISOString()
  };
}

function toCurvePointCreateInput(point: BuiltResidualCurvePoint) {
  return {
    ageMonth: point.ageMonth,
    averagePriceAmount: point.averagePriceAmount,
    confidenceScore: point.confidenceScore,
    lowerBoundAmount: point.lowerBoundAmount,
    maxPriceAmount: point.maxPriceAmount,
    medianPriceAmount: point.medianPriceAmount,
    mileageBucketEndKm: point.mileageBucketEndKm,
    mileageBucketStartKm: point.mileageBucketStartKm,
    minPriceAmount: point.minPriceAmount,
    p25PriceAmount: point.p25PriceAmount,
    p75PriceAmount: point.p75PriceAmount,
    pointSnapshot: point.pointSnapshot,
    predictedResidualAmount: point.predictedResidualAmount,
    predictedResidualRateBps: point.predictedResidualRateBps,
    sampleCount: point.sampleCount,
    upperBoundAmount: point.upperBoundAmount
  };
}

function curveGenerationResponse(
  dryRun: boolean,
  curve: ReturnType<typeof toCurvePreviewView> | ReturnType<typeof toCurveView>,
  points: BuiltResidualCurvePoint[] | VehicleResidualCurvePoint[],
  preview: BuiltResidualCurvePreview
) {
  return {
    curve,
    dryRun,
    pointCount: preview.pointCount,
    points: points.map((point) => ("id" in point ? toCurvePointView(point) : toBuiltCurvePointView(point))),
    sampleCount: preview.sampleCount,
    skippedReasons: preview.skippedReasons,
    skippedSampleCount: preview.skippedSampleCount
  };
}

function toCurvePreviewView(curve: BuiltResidualCurve) {
  return {
    batteryCapacityKwh: decimalToNumber(curve.batteryCapacityKwh),
    batteryUsageType: curve.batteryUsageType,
    brand: curve.brand,
    confidenceScore: curve.confidenceScore,
    curveMethod: curve.curveMethod,
    curveName: curve.curveName,
    curveNo: null,
    curveStatus: curve.curveStatus,
    curveVersion: curve.curveVersion,
    effectiveFrom: null,
    effectiveTo: null,
    generatedAt: null,
    id: null,
    metrics: curve.metrics,
    model: curve.model,
    modelYear: curve.modelYear,
    pointCount: curve.pointCount,
    priceTypes: curve.priceTypes,
    referencePriceAmount: numberOrNull(curve.referencePriceAmount),
    remark: curve.remark,
    sampleCount: curve.sampleCount,
    sampleEndDate: curve.sampleEndDate ? formatDateOnly(curve.sampleEndDate) : null,
    sampleFilterSnapshot: curve.sampleFilterSnapshot,
    sampleStartDate: curve.sampleStartDate ? formatDateOnly(curve.sampleStartDate) : null,
    series: curve.series,
    snapshot: curve.snapshot,
    trim: curve.trim
  };
}

function toCurveView(curve: VehicleResidualCurve & { points?: VehicleResidualCurvePoint[] }) {
  return {
    batteryCapacityKwh: decimalToNumber(curve.batteryCapacityKwh),
    batteryUsageType: curve.batteryUsageType,
    brand: curve.brand,
    confidenceScore: curve.confidenceScore,
    createdAt: curve.createdAt.toISOString(),
    createdBy: curve.createdBy,
    curveMethod: curve.curveMethod,
    curveName: curve.curveName,
    curveNo: curve.curveNo,
    curveStatus: curve.curveStatus,
    curveVersion: curve.curveVersion,
    effectiveFrom: curve.effectiveFrom ? formatDateOnly(curve.effectiveFrom) : null,
    effectiveTo: curve.effectiveTo ? formatDateOnly(curve.effectiveTo) : null,
    generatedAt: curve.generatedAt.toISOString(),
    id: curve.id,
    metrics: curve.metrics,
    model: curve.model,
    modelYear: curve.modelYear,
    pointCount: curve.pointCount,
    points: curve.points?.map(toCurvePointView),
    priceTypes: curve.priceTypes,
    referencePriceAmount: numberOrNull(curve.referencePriceAmount),
    remark: curve.remark,
    sampleCount: curve.sampleCount,
    sampleEndDate: curve.sampleEndDate ? formatDateOnly(curve.sampleEndDate) : null,
    sampleFilterSnapshot: curve.sampleFilterSnapshot,
    sampleStartDate: curve.sampleStartDate ? formatDateOnly(curve.sampleStartDate) : null,
    series: curve.series,
    snapshot: curve.snapshot,
    trim: curve.trim,
    updatedAt: curve.updatedAt.toISOString(),
    updatedBy: curve.updatedBy
  };
}

function toBuiltCurvePointView(point: BuiltResidualCurvePoint) {
  return {
    ageMonth: point.ageMonth,
    averagePriceAmount: Number(point.averagePriceAmount),
    confidenceScore: point.confidenceScore,
    curveId: null,
    id: null,
    lowerBoundAmount: Number(point.lowerBoundAmount),
    maxPriceAmount: Number(point.maxPriceAmount),
    medianPriceAmount: Number(point.medianPriceAmount),
    mileageBucketEndKm: point.mileageBucketEndKm,
    mileageBucketStartKm: point.mileageBucketStartKm,
    minPriceAmount: Number(point.minPriceAmount),
    p25PriceAmount: Number(point.p25PriceAmount),
    p75PriceAmount: Number(point.p75PriceAmount),
    pointSnapshot: point.pointSnapshot,
    predictedResidualAmount: Number(point.predictedResidualAmount),
    predictedResidualRateBps: point.predictedResidualRateBps,
    sampleCount: point.sampleCount,
    upperBoundAmount: Number(point.upperBoundAmount)
  };
}

function toCurvePointView(point: VehicleResidualCurvePoint) {
  return {
    ageMonth: point.ageMonth,
    averagePriceAmount: numberOrNull(point.averagePriceAmount),
    confidenceScore: point.confidenceScore,
    createdAt: point.createdAt.toISOString(),
    curveId: point.curveId,
    id: point.id,
    lowerBoundAmount: numberOrNull(point.lowerBoundAmount),
    maxPriceAmount: numberOrNull(point.maxPriceAmount),
    medianPriceAmount: numberOrNull(point.medianPriceAmount),
    mileageBucketEndKm: point.mileageBucketEndKm,
    mileageBucketStartKm: point.mileageBucketStartKm,
    minPriceAmount: numberOrNull(point.minPriceAmount),
    p25PriceAmount: numberOrNull(point.p25PriceAmount),
    p75PriceAmount: numberOrNull(point.p75PriceAmount),
    pointSnapshot: point.pointSnapshot,
    predictedResidualAmount: numberOrNull(point.predictedResidualAmount),
    predictedResidualRateBps: point.predictedResidualRateBps,
    sampleCount: point.sampleCount,
    updatedAt: point.updatedAt.toISOString(),
    upperBoundAmount: numberOrNull(point.upperBoundAmount)
  };
}

function curveAuditPayload(
  curve: Pick<
    VehicleResidualCurve,
    | "batteryCapacityKwh"
    | "batteryUsageType"
    | "brand"
    | "curveNo"
    | "id"
    | "model"
    | "modelYear"
    | "pointCount"
    | "sampleCount"
    | "series"
  >,
  extra: { remark?: string | null }
) {
  return {
    batteryCapacityKwh: decimalToNumber(curve.batteryCapacityKwh),
    batteryUsageType: curve.batteryUsageType,
    brand: curve.brand,
    curveId: curve.id,
    curveNo: curve.curveNo,
    model: curve.model,
    modelYear: curve.modelYear,
    pointCount: curve.pointCount,
    remark: extra.remark ?? null,
    sampleCount: curve.sampleCount,
    series: curve.series
  };
}

function requiredText(value: string | null | undefined, fieldName: string) {
  const text = normalizeOptionalText(value);
  if (!text) {
    throw new BadRequestException(`${fieldName} 必填。`);
  }
  return text;
}

function normalizeOptionalText(value: string | null | undefined) {
  const text = typeof value === "string" ? value.trim() : null;
  return text ? text : null;
}

function normalizeKeyPart(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  return String(value).trim().toLowerCase() || "-";
}

function parseEnumValue<T extends Record<string, string>>(
  enumObject: T,
  value: string | null | undefined,
  fieldName: string
): T[keyof T] {
  const text = requiredText(value, fieldName).toUpperCase();
  if (Object.values(enumObject).includes(text)) {
    return text as T[keyof T];
  }
  throw new BadRequestException(`${fieldName} 枚举值无效。`);
}

function parseOptionalEnumValue<T extends Record<string, string>>(
  enumObject: T,
  value: string | null | undefined,
  fieldName: string
): T[keyof T] | null {
  const text = normalizeOptionalText(value);
  if (!text) {
    return null;
  }
  return parseEnumValue(enumObject, text, fieldName);
}

function parseDateOnly(value: string | null | undefined, fieldName: string) {
  const text = requiredText(value, fieldName);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new BadRequestException(`${fieldName} 必须是 YYYY-MM-DD。`);
  }

  const date = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || formatDateOnly(date) !== text) {
    throw new BadRequestException(`${fieldName} 日期无效。`);
  }
  return date;
}

function parseOptionalDateOnly(value: string | null | undefined, fieldName: string) {
  const text = normalizeOptionalText(value);
  return text ? parseDateOnly(text, fieldName) : null;
}

function endOfDateOnly(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
}

function formatDateOnly(date: Date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function optionalInteger(value: number | string | null | undefined, fieldName: string, min: number) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min) {
    throw new BadRequestException(`${fieldName} 必须是大于等于 ${min} 的整数。`);
  }
  return numeric;
}

function requiredFenAmount(value: number | string | null | undefined, fieldName: string) {
  const amount = optionalFenAmount(value, fieldName);
  if (amount === null || amount <= 0n) {
    throw new BadRequestException(`${fieldName} 必须大于 0。`);
  }
  return amount;
}

function optionalFenAmount(value: number | string | null | undefined, fieldName: string) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new BadRequestException(`${fieldName} 必须是大于等于 0 的整数分。`);
  }
  return BigInt(numeric);
}

function requiredYuanAmountToFen(value: number | string | null | undefined, fieldName: string) {
  const amount = optionalYuanAmountToFen(value, fieldName);
  if (amount === null || amount <= 0n) {
    throw new BadRequestException(`${fieldName} 必须大于 0。`);
  }
  return amount;
}

function optionalYuanAmountToFen(value: number | string | null | undefined, fieldName: string) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new BadRequestException(`${fieldName} 必须是大于等于 0 的金额。`);
  }
  return BigInt(Math.round(numeric * 100));
}

function optionalDecimal(
  value: number | string | null | undefined,
  fieldName: string,
  min: number,
  max?: number
) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min || (max !== undefined && numeric > max)) {
    throw new BadRequestException(
      max === undefined
        ? `${fieldName} 必须大于等于 ${min}。`
        : `${fieldName} 必须在 ${min} 到 ${max} 之间。`
    );
  }
  return new Prisma.Decimal(numeric);
}

function parseOptionalBoolean(value: boolean | string | null | undefined, fieldName: string) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "是"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "否"].includes(normalized)) {
    return false;
  }
  throw new BadRequestException(`${fieldName} 必须是布尔值。`);
}

function hashOptionalText(value: string | null | undefined) {
  const text = normalizeOptionalText(value);
  return text ? createHash("sha256").update(text).digest("hex") : null;
}

function decimalToNumber(value: Prisma.Decimal | null) {
  return value ? value.toNumber() : null;
}

function numberOrNull(value: bigint | null) {
  return value === null ? null : Number(value);
}

function mergeRemark(before: string | null, remark: string | null | undefined) {
  const nextRemark = normalizeOptionalText(remark);
  if (!nextRemark) {
    return before;
  }
  return before ? `${before}\n作废备注：${nextRemark}` : nextRemark;
}

function mergeOperationRemark(before: string | null, remark: string | null | undefined) {
  const nextRemark = normalizeOptionalText(remark);
  if (!nextRemark) {
    return before;
  }
  return before ? `${before}\n${nextRemark}` : nextRemark;
}

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
