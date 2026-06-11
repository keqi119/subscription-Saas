import { createHash } from "node:crypto";

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";
import {
  AuditAction,
  MarketPriceImportStatus,
  MarketPriceObservationStatus,
  MarketPriceSource,
  MarketPriceType,
  MarketSellerType,
  Prisma,
  ResidualModelAlgorithm,
  ResidualModelRun,
  ResidualModelRunOutput,
  ResidualModelRunOutputStatus,
  ResidualModelRunOutputType,
  ResidualModelRunStatus,
  ResidualModelRunType,
  ResidualModelTargetType,
  ResidualForecastInterpolationMethod,
  Vehicle,
  VehicleBatteryUsageType,
  VehicleMarketPriceObservation,
  VehicleResidualCurve,
  VehicleResidualCurveMethod,
  VehicleResidualCurvePoint,
  VehicleResidualCurveStatus,
  VehicleResidualForecast,
  VehicleResidualForecastMethod,
  VehicleResidualForecastPoint,
  VehicleResidualForecastPointStatus,
  VehicleResidualForecastStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import { parseCsvRecords } from "./csv-parser";
import {
  ActivateResidualCurveDto,
  AdoptVehicleResidualForecastPointDto,
  ArchiveResidualCurveDto,
  CancelResidualModelRunDto,
  CompleteResidualModelRunDto,
  CompleteResidualModelRunOutputDto,
  CreateResidualModelRunDto,
  CreateMarketPriceObservationDto,
  FailResidualModelRunDto,
  GenerateResidualCurveDto,
  GenerateVehicleResidualForecastDto,
  ImportMarketPriceCsvDto,
  MarketPriceImportBatchesQueryDto,
  MarketPriceObservationsQueryDto,
  ResidualModelRunQueryDto,
  ResidualCurveQueryDto,
  VehicleResidualForecastQueryDto,
  VoidVehicleResidualForecastDto,
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
  artifactUri: string | null;
  autoCreateModelRun: boolean;
  minSamplePerPoint: number;
  model: string;
  modelProvider: string | null;
  modelRunId: string | null;
  modelRunName: string | null;
  modelVersion: string | null;
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

type ForecastCurve = VehicleResidualCurve & { points: VehicleResidualCurvePoint[] };

type ForecastGenerationInput = {
  asOfDate: Date;
  curveId: string | null;
  dryRun: boolean;
  horizonMonths: number[];
  remark: string | null;
};

type CurveSelection = {
  candidateSummaries: Prisma.InputJsonArray;
  curve: ForecastCurve;
  matchedFields: string[];
  score: number;
};

type BuiltVehicleResidualForecastPoint = {
  confidenceScore: number | null;
  horizonMonth: number;
  interpolationMethod: ResidualForecastInterpolationMethod;
  lowerBoundAmount: bigint | null;
  matchedCurvePointAgeMonth: number | null;
  pointSnapshot: Prisma.InputJsonObject;
  pointStatus: VehicleResidualForecastPointStatus;
  predictedResidualAmount: bigint | null;
  predictedResidualRateBps: number | null;
  targetAgeMonth: number;
  targetDate: Date;
  upperBoundAmount: bigint | null;
};

type BuiltVehicleResidualForecast = {
  asOfDate: Date;
  batteryCapacityKwh: Prisma.Decimal | null;
  batteryUsageType: VehicleBatteryUsageType | null;
  brand: string | null;
  curveId: string;
  curveSnapshot: Prisma.InputJsonObject;
  currentMileageKm: number | null;
  currentSalePriceAmount: bigint | null;
  forecastMethod: VehicleResidualForecastMethod;
  forecastStatus: VehicleResidualForecastStatus;
  inputSnapshot: Prisma.InputJsonObject;
  metrics: Prisma.InputJsonObject;
  model: string | null;
  modelYear: number | null;
  purchasePriceAmount: bigint | null;
  remark: string | null;
  series: string | null;
  trim: string | null;
  vehicleAgeMonths: number;
  vehicleId: string;
  vehicleSnapshot: Prisma.InputJsonObject;
};

type BuiltVehicleResidualForecastPreview = {
  dryRun: boolean;
  forecast: BuiltVehicleResidualForecast;
  pointCount: number;
  points: BuiltVehicleResidualForecastPoint[];
};

type VehicleResidualForecastWithRelations = VehicleResidualForecast & {
  curve?: VehicleResidualCurve | null;
  points?: VehicleResidualForecastPoint[];
  vehicle?: Vehicle | null;
};

type VehicleResidualForecastPointWithForecast = VehicleResidualForecastPoint & {
  forecast?: (VehicleResidualForecast & { curve?: VehicleResidualCurve | null; vehicle?: Vehicle | null }) | null;
};

type ResidualModelRunOutputWithRelations = ResidualModelRunOutput & {
  curve?: VehicleResidualCurve | null;
  forecast?: VehicleResidualForecast | null;
  vehicle?: Vehicle | null;
};

type ResidualModelRunWithOutputs = ResidualModelRun & {
  outputs?: ResidualModelRunOutputWithRelations[];
};

const OBSERVATION_ENTITY_TYPE = "vehicle_market_price_observation";
const BATCH_ENTITY_TYPE = "market_price_import_batch";
const CURVE_ENTITY_TYPE = "vehicle_residual_curve";
const FORECAST_ENTITY_TYPE = "vehicle_residual_forecast";
const FORECAST_POINT_ENTITY_TYPE = "vehicle_residual_forecast_point";
const MODEL_RUN_ENTITY_TYPE = "residual_model_run";
const RESIDUAL_MARKET_MODULE = "residual_market";
const DUPLICATE_MESSAGE = "该市场价格样本已存在，不能重复创建。";

const DEFAULT_CURVE_PRICE_TYPES = [
  MarketPriceType.TRANSACTION,
  MarketPriceType.AUCTION,
  MarketPriceType.DEALER_QUOTE,
  MarketPriceType.INTERNAL_SALE,
  MarketPriceType.LISTING
];
const DEFAULT_FORECAST_HORIZONS = [0, 6, 12, 24, 36];

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
    this.ensureModelRunManagePermission(input, user);
    const existingModelRun = input.modelRunId ? await this.findLinkableModelRun(input.modelRunId, input, input.dryRun) : null;
    const observations = await this.prisma.vehicleMarketPriceObservation.findMany({
      orderBy: [{ observedAt: "asc" }, { createdAt: "asc" }],
      where: buildCurveObservationWhere(input)
    });
    const preview = buildResidualCurvePreview(input, observations);

    if (preview.pointCount === 0) {
      throw new BadRequestException("符合条件的样本不足，无法生成残值曲线。");
    }

    if (input.dryRun) {
      return curveGenerationResponse(true, toCurvePreviewView(preview.curve), preview.points, preview, {
        warnings: ["当前为试算，不会创建或更新模型运行记录。"]
      });
    }

    const generationResult = await withUniqueBusinessNoRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const curve = await tx.vehicleResidualCurve.create({
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
        });

        if (existingModelRun) {
          const finishedAt = new Date();
          await tx.residualModelRun.update({
            data: buildExistingModelRunCurveLinkUpdate(existingModelRun, input, preview, curve, user.id, finishedAt),
            where: { id: existingModelRun.id }
          });
          const modelRunOutput = await tx.residualModelRunOutput.create({
            data: buildCurveModelRunOutputCreate(existingModelRun.id, curve, dto.remark),
            include: modelRunOutputInclude()
          });
          const modelRun = await tx.residualModelRun.findUniqueOrThrow({
            include: modelRunInclude(),
            where: { id: existingModelRun.id }
          });

          return { curve, modelRun, modelRunOutput };
        }

        if (input.autoCreateModelRun) {
          const finishedAt = new Date();
          const modelRun = await tx.residualModelRun.create({
            data: {
              ...buildAutoModelRunCreateData(input, preview, curve, user.id, finishedAt),
              runNo: createBusinessNo("RMR")
            }
          });
          const modelRunOutput = await tx.residualModelRunOutput.create({
            data: buildCurveModelRunOutputCreate(modelRun.id, curve, dto.remark),
            include: modelRunOutputInclude()
          });
          const modelRunWithOutputs = await tx.residualModelRun.findUniqueOrThrow({
            include: modelRunInclude(),
            where: { id: modelRun.id }
          });

          return { curve, modelRun: modelRunWithOutputs, modelRunOutput };
        }

        return { curve, modelRun: null, modelRunOutput: null };
      })
    );
    const { curve, modelRun, modelRunOutput } = generationResult;

    await this.writeCurveAudit(
      AuditAction.CREATE,
      curve.id,
      undefined,
      toCurveView(curve),
      user,
      context,
      curveAuditPayload(curve, { remark: dto.remark })
    );

    if (modelRun) {
      await this.writeModelRunAudit(
        input.autoCreateModelRun ? AuditAction.CREATE : AuditAction.UPDATE,
        modelRun.id,
        existingModelRun ? toModelRunView(existingModelRun) : undefined,
        toModelRunView(modelRun),
        user,
        context,
        modelRunAuditPayload(modelRun, {
          outputs: modelRunOutput ? [toModelRunOutputView(modelRunOutput)] : [],
          remark: dto.remark
        })
      );
    }

    return curveGenerationResponse(false, toCurveView(curve), curve.points, preview, {
      modelRun: modelRun ? toModelRunView(modelRun) : null,
      modelRunLinked: Boolean(modelRun),
      modelRunOutput: modelRunOutput ? toModelRunOutputView(modelRunOutput) : null,
      warnings: modelRun ? [] : ["本次残值曲线未关联模型运行记录。"]
    });
  }

  private ensureModelRunManagePermission(input: CurveGenerationInput, user: RequestUser) {
    if (!input.modelRunId && !input.autoCreateModelRun) {
      return;
    }
    if (!user.permissions.includes(PermissionCode.RESIDUAL_MODEL_RUN_MANAGE)) {
      throw new BadRequestException("缺少模型运行记录管理权限，不能关联或自动创建模型运行记录。");
    }
  }

  private async findLinkableModelRun(id: string, input: CurveGenerationInput, dryRun: boolean) {
    const run = await this.prisma.residualModelRun.findFirst({
      include: modelRunInclude(),
      where: { deletedAt: null, id }
    });

    if (!run) {
      throw new NotFoundException("残值模型运行记录不存在。");
    }

    assertModelRunTargetMatchesCurveInput(run, input);
    if (!dryRun) {
      assertModelRunCanReceiveCurveOutput(run);
    }

    return run;
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

  async generateVehicleForecast(
    vehicleId: string,
    dto: GenerateVehicleResidualForecastDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const input = buildForecastGenerationInput(dto);
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { deletedAt: null, id: vehicleId }
    });

    if (!vehicle) {
      throw new NotFoundException("车辆不存在。");
    }

    if (!vehicle.registrationDate) {
      throw new BadRequestException("车辆缺少初次上牌日期，无法计算车龄。");
    }

    const vehicleAgeMonths = diffMonths(input.asOfDate, vehicle.registrationDate);
    const selection = await this.selectForecastCurve(vehicle, input);
    const preview = buildVehicleResidualForecastPreview(vehicle, selection, input, vehicleAgeMonths);

    if (input.dryRun) {
      return vehicleForecastGenerationResponse(true, toForecastPreviewView(preview.forecast), preview.points, preview);
    }

    const forecast = await withUniqueBusinessNoRetry(() =>
      this.prisma.vehicleResidualForecast.create({
        data: {
          asOfDate: input.asOfDate,
          batteryCapacityKwh: preview.forecast.batteryCapacityKwh,
          batteryUsageType: preview.forecast.batteryUsageType,
          brand: preview.forecast.brand,
          createdBy: user.id,
          curveId: preview.forecast.curveId,
          curveSnapshot: preview.forecast.curveSnapshot,
          currentMileageKm: preview.forecast.currentMileageKm,
          currentSalePriceAmount: preview.forecast.currentSalePriceAmount,
          forecastMethod: preview.forecast.forecastMethod,
          forecastNo: createBusinessNo("VRF"),
          forecastStatus: VehicleResidualForecastStatus.GENERATED,
          inputSnapshot: preview.forecast.inputSnapshot,
          metrics: preview.forecast.metrics,
          model: preview.forecast.model,
          modelYear: preview.forecast.modelYear,
          points: { create: preview.points.map(toForecastPointCreateInput) },
          purchasePriceAmount: preview.forecast.purchasePriceAmount,
          remark: preview.forecast.remark,
          series: preview.forecast.series,
          trim: preview.forecast.trim,
          updatedBy: user.id,
          vehicleAgeMonths: preview.forecast.vehicleAgeMonths,
          vehicleId: preview.forecast.vehicleId,
          vehicleSnapshot: preview.forecast.vehicleSnapshot
        },
        include: {
          curve: true,
          points: { orderBy: { horizonMonth: "asc" } },
          vehicle: true
        }
      })
    );

    await this.writeForecastAudit(
      AuditAction.CREATE,
      forecast.id,
      undefined,
      toForecastView(forecast),
      user,
      context,
      forecastAuditPayload(forecast, {
        horizonMonths: input.horizonMonths,
        remark: input.remark
      })
    );

    return vehicleForecastGenerationResponse(false, toForecastView(forecast), forecast.points, preview);
  }

  async listVehicleForecasts(vehicleId: string, query: VehicleResidualForecastQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where: Prisma.VehicleResidualForecastWhereInput = {
      deletedAt: null,
      forecastStatus: query.forecastStatus,
      vehicleId
    };

    const [total, forecasts] = await Promise.all([
      this.prisma.vehicleResidualForecast.count({ where }),
      this.prisma.vehicleResidualForecast.findMany({
        include: {
          curve: true,
          points: { orderBy: { horizonMonth: "asc" } }
        },
        orderBy: [{ createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        where
      })
    ]);

    return {
      items: forecasts.map(toForecastView),
      page,
      pageSize,
      total
    };
  }

  async getLatestVehicleForecast(vehicleId: string) {
    const forecast = await this.prisma.vehicleResidualForecast.findFirst({
      include: {
        curve: true,
        points: { orderBy: { horizonMonth: "asc" } },
        vehicle: true
      },
      orderBy: { createdAt: "desc" },
      where: { deletedAt: null, vehicleId }
    });

    return forecast ? toForecastView(forecast) : null;
  }

  async getVehicleForecast(id: string) {
    const forecast = await this.prisma.vehicleResidualForecast.findFirst({
      include: {
        curve: true,
        points: { orderBy: { horizonMonth: "asc" } },
        vehicle: true
      },
      where: { deletedAt: null, id }
    });

    if (!forecast) {
      throw new NotFoundException("车辆残值预测不存在。");
    }

    return toForecastView(forecast);
  }

  async adoptVehicleForecastPoint(
    pointId: string,
    dto: AdoptVehicleResidualForecastPointDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.prisma.vehicleResidualForecastPoint.findFirst({
      include: {
        forecast: {
          include: {
            curve: true,
            vehicle: true
          }
        }
      },
      where: { id: pointId }
    });

    if (!before) {
      throw new NotFoundException("车辆残值预测点不存在。");
    }

    if (before.pointStatus === VehicleResidualForecastPointStatus.UNSUPPORTED) {
      throw new BadRequestException("暂不支持的预测点不能采用。");
    }

    const adoptedResidualAmount = requiredFenAmount(dto.adoptedResidualAmount, "adoptedResidualAmount");
    const adoptedAt = new Date();
    const updatedPoint = await this.prisma.$transaction(async (tx) => {
      const point = await tx.vehicleResidualForecastPoint.update({
        data: {
          adoptedAt,
          adoptedBy: user.id,
          adoptedResidualAmount,
          adoptRemark: normalizeOptionalText(dto.adoptRemark),
          pointStatus: VehicleResidualForecastPointStatus.ADOPTED
        },
        include: {
          forecast: {
            include: {
              curve: true,
              vehicle: true
            }
          }
        },
        where: { id: pointId }
      });

      await tx.vehicleResidualForecast.update({
        data: {
          forecastStatus: VehicleResidualForecastStatus.ADOPTED,
          updatedBy: user.id
        },
        where: { id: before.forecastId }
      });

      return point;
    });

    await this.writeForecastAudit(
      AuditAction.UPDATE,
      pointId,
      toForecastPointView(before),
      toForecastPointView(updatedPoint),
      user,
      context,
      forecastPointAuditPayload(updatedPoint, {
        adoptedResidualAmount,
        remark: dto.adoptRemark
      }),
      FORECAST_POINT_ENTITY_TYPE
    );

    return toForecastPointView(updatedPoint);
  }

  async voidVehicleForecast(
    id: string,
    dto: VoidVehicleResidualForecastDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.prisma.vehicleResidualForecast.findFirst({
      include: {
        curve: true,
        points: { orderBy: { horizonMonth: "asc" } },
        vehicle: true
      },
      where: { deletedAt: null, id }
    });

    if (!before) {
      throw new NotFoundException("车辆残值预测不存在。");
    }

    if (before.forecastStatus === VehicleResidualForecastStatus.VOIDED) {
      throw new BadRequestException("该车辆残值预测已作废，不能重复作废。");
    }

    const forecast = await this.prisma.vehicleResidualForecast.update({
      data: {
        forecastStatus: VehicleResidualForecastStatus.VOIDED,
        remark: mergeOperationRemark(before.remark, dto.remark),
        updatedBy: user.id
      },
      include: {
        curve: true,
        points: { orderBy: { horizonMonth: "asc" } },
        vehicle: true
      },
      where: { id }
    });

    await this.writeForecastAudit(
      AuditAction.UPDATE,
      forecast.id,
      toForecastView(before),
      toForecastView(forecast),
      user,
      context,
      forecastAuditPayload(forecast, { remark: dto.remark })
    );

    return toForecastView(forecast);
  }

  async listModelRuns(query: ResidualModelRunQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = buildModelRunWhere(query);

    const [total, runs] = await Promise.all([
      this.prisma.residualModelRun.count({ where }),
      this.prisma.residualModelRun.findMany({
        orderBy: [{ createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        where
      })
    ]);

    return {
      items: runs.map(toModelRunView),
      page,
      pageSize,
      total
    };
  }

  async getModelRun(id: string) {
    const run = await this.prisma.residualModelRun.findFirst({
      include: modelRunInclude(),
      where: { deletedAt: null, id }
    });

    if (!run) {
      throw new NotFoundException("残值模型运行记录不存在。");
    }

    return toModelRunView(run);
  }

  async createModelRun(
    dto: CreateResidualModelRunDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const data = buildModelRunCreateData(dto, user.id);
    const run = await withUniqueBusinessNoRetry(() =>
      this.prisma.residualModelRun.create({
        data: {
          ...data,
          runNo: createBusinessNo("RMR")
        }
      })
    );

    await this.writeModelRunAudit(
      AuditAction.CREATE,
      run.id,
      undefined,
      toModelRunView(run),
      user,
      context,
      modelRunAuditPayload(run, { remark: dto.remark })
    );

    return toModelRunView(run);
  }

  async completeModelRun(
    id: string,
    dto: CompleteResidualModelRunDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.prisma.residualModelRun.findFirst({
      include: modelRunInclude(),
      where: { deletedAt: null, id }
    });

    if (!before) {
      throw new NotFoundException("残值模型运行记录不存在。");
    }

    const completableStatuses: ResidualModelRunStatus[] = [
      ResidualModelRunStatus.CREATED,
      ResidualModelRunStatus.RUNNING
    ];
    if (!completableStatuses.includes(before.runStatus)) {
      throw new BadRequestException("只有已创建或运行中的模型运行记录可以标记完成。");
    }

    const outputCreates = await this.buildModelRunOutputCreates(dto.outputs ?? []);
    const finishedAt = new Date();
    const run = await this.prisma.$transaction(async (tx) => {
      await tx.residualModelRun.update({
        data: {
          finishedAt,
          metricsSnapshot: jsonObjectOrNull(dto.metricsSnapshot),
          outputSnapshot: jsonObjectOrNull(dto.outputSnapshot),
          remark: mergeOperationRemark(before.remark, dto.remark),
          runStatus: ResidualModelRunStatus.COMPLETED,
          updatedBy: user.id
        },
        where: { id }
      });

      if (outputCreates.length > 0) {
        await tx.residualModelRunOutput.createMany({
          data: outputCreates.map((output) => ({
            ...output,
            runId: id
          }))
        });
      }

      return tx.residualModelRun.findUniqueOrThrow({
        include: modelRunInclude(),
        where: { id }
      });
    });

    await this.writeModelRunAudit(
      AuditAction.UPDATE,
      run.id,
      toModelRunView(before),
      toModelRunView(run),
      user,
      context,
      modelRunAuditPayload(run, { outputs: dto.outputs ?? [], remark: dto.remark })
    );

    return toModelRunView(run);
  }

  async failModelRun(
    id: string,
    dto: FailResidualModelRunDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.prisma.residualModelRun.findFirst({
      include: modelRunInclude(),
      where: { deletedAt: null, id }
    });

    if (!before) {
      throw new NotFoundException("残值模型运行记录不存在。");
    }

    const immutableForFailureStatuses: ResidualModelRunStatus[] = [
      ResidualModelRunStatus.COMPLETED,
      ResidualModelRunStatus.CANCELLED
    ];
    if (immutableForFailureStatuses.includes(before.runStatus)) {
      throw new BadRequestException("已完成或已取消的模型运行记录不能标记失败。");
    }

    const run = await this.prisma.residualModelRun.update({
      data: {
        errorSnapshot: jsonObjectOrNull(dto.errorSnapshot),
        finishedAt: new Date(),
        remark: mergeOperationRemark(before.remark, dto.remark),
        runStatus: ResidualModelRunStatus.FAILED,
        updatedBy: user.id
      },
      include: modelRunInclude(),
      where: { id }
    });

    await this.writeModelRunAudit(
      AuditAction.UPDATE,
      run.id,
      toModelRunView(before),
      toModelRunView(run),
      user,
      context,
      modelRunAuditPayload(run, { remark: dto.remark })
    );

    return toModelRunView(run);
  }

  async cancelModelRun(
    id: string,
    dto: CancelResidualModelRunDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.prisma.residualModelRun.findFirst({
      include: modelRunInclude(),
      where: { deletedAt: null, id }
    });

    if (!before) {
      throw new NotFoundException("残值模型运行记录不存在。");
    }

    const immutableForCancelStatuses: ResidualModelRunStatus[] = [
      ResidualModelRunStatus.COMPLETED,
      ResidualModelRunStatus.FAILED,
      ResidualModelRunStatus.CANCELLED
    ];
    if (immutableForCancelStatuses.includes(before.runStatus)) {
      throw new BadRequestException("已完成、失败或已取消的模型运行记录不能取消。");
    }

    const run = await this.prisma.residualModelRun.update({
      data: {
        finishedAt: new Date(),
        remark: mergeOperationRemark(before.remark, dto.remark),
        runStatus: ResidualModelRunStatus.CANCELLED,
        updatedBy: user.id
      },
      include: modelRunInclude(),
      where: { id }
    });

    await this.writeModelRunAudit(
      AuditAction.UPDATE,
      run.id,
      toModelRunView(before),
      toModelRunView(run),
      user,
      context,
      modelRunAuditPayload(run, { remark: dto.remark })
    );

    return toModelRunView(run);
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

  private async selectForecastCurve(vehicle: Vehicle, input: ForecastGenerationInput): Promise<CurveSelection> {
    if (input.curveId) {
      const curve = await this.prisma.vehicleResidualCurve.findFirst({
        include: {
          points: { orderBy: { ageMonth: "asc" } }
        },
        where: {
          deletedAt: null,
          id: input.curveId
        }
      });

      if (!curve) {
        throw new NotFoundException("残值曲线不存在。");
      }

      const allowedStatuses: VehicleResidualCurveStatus[] = input.dryRun
        ? [VehicleResidualCurveStatus.ACTIVE, VehicleResidualCurveStatus.DRAFT]
        : [VehicleResidualCurveStatus.ACTIVE];

      if (!allowedStatuses.includes(curve.curveStatus)) {
        throw new BadRequestException(
          input.dryRun
            ? "试算只能使用草稿或生效中的残值曲线。"
            : "正式生成单车残值预测只能使用生效中的残值曲线。"
        );
      }

      return {
        candidateSummaries: [curveCandidateSummary(curve as ForecastCurve, 100, ["curveId"])],
        curve: curve as ForecastCurve,
        matchedFields: ["curveId"],
        score: 100
      };
    }

    const brand = normalizeOptionalText(vehicle.brand);
    const model = normalizeOptionalText(vehicle.model);

    if (!brand || !model) {
      throw new BadRequestException("车辆缺少品牌或车型，无法匹配生效残值曲线。");
    }

    const curves = await this.prisma.vehicleResidualCurve.findMany({
      include: {
        points: { orderBy: { ageMonth: "asc" } }
      },
      where: {
        brand: exactTextFilter(brand),
        curveStatus: VehicleResidualCurveStatus.ACTIVE,
        deletedAt: null,
        model: exactTextFilter(model)
      }
    });

    if (curves.length === 0) {
      throw new BadRequestException("未找到匹配的生效残值曲线，无法生成车辆残值预测。");
    }

    const ranked = curves
      .map((curve) => rankForecastCurve(curve as ForecastCurve, vehicle))
      .sort(compareCurveSelection);

    const selected = ranked[0];
    if (!selected) {
      throw new BadRequestException("未找到匹配的生效残值曲线，无法生成车辆残值预测。");
    }

    return {
      candidateSummaries: ranked.map((candidate) =>
        curveCandidateSummary(candidate.curve, candidate.score, candidate.matchedFields)
      ),
      curve: selected.curve,
      matchedFields: selected.matchedFields,
      score: selected.score
    };
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

  private async writeForecastAudit(
    action: AuditAction,
    entityId: string,
    before: unknown,
    after: unknown,
    user: RequestUser,
    context: RequestContext,
    payload: Record<string, unknown>,
    entityType = FORECAST_ENTITY_TYPE
  ) {
    await this.auditService.write({
      action,
      after: { ...payload, after },
      before: before === undefined ? undefined : { ...payload, before },
      entityId,
      entityType,
      ipAddress: context.ipAddress,
      module: RESIDUAL_MARKET_MODULE,
      operatorId: user.id,
      userAgent: context.userAgent
    });
  }

  private async buildModelRunOutputCreates(outputs: CompleteResidualModelRunOutputDto[]) {
    const data: Omit<Prisma.ResidualModelRunOutputUncheckedCreateInput, "runId">[] = [];

    for (const output of outputs) {
      const outputType = parseEnumValue(ResidualModelRunOutputType, output.outputType, "outputType");
      const curveId = normalizeOptionalText(output.curveId);
      const forecastId = normalizeOptionalText(output.forecastId);
      const vehicleId = normalizeOptionalText(output.vehicleId);

      if (outputType === ResidualModelRunOutputType.RESIDUAL_CURVE && !curveId) {
        throw new BadRequestException("残值曲线输出必须提供 curveId。");
      }

      if (outputType === ResidualModelRunOutputType.VEHICLE_FORECAST && !forecastId) {
        throw new BadRequestException("单车预测输出必须提供 forecastId。");
      }

      await this.assertModelRunOutputReferences({ curveId, forecastId, vehicleId });

      data.push({
        curveId,
        forecastId,
        outputNo: normalizeOptionalText(output.outputNo),
        outputSnapshot: jsonObjectOrNull(output.outputSnapshot),
        outputStatus: ResidualModelRunOutputStatus.ACTIVE,
        outputType,
        remark: normalizeOptionalText(output.remark),
        vehicleId
      });
    }

    return data;
  }

  private async assertModelRunOutputReferences(input: {
    curveId: string | null;
    forecastId: string | null;
    vehicleId: string | null;
  }) {
    if (input.curveId) {
      const curve = await this.prisma.vehicleResidualCurve.findFirst({
        select: { id: true },
        where: { deletedAt: null, id: input.curveId }
      });

      if (!curve) {
        throw new BadRequestException("关联的残值曲线不存在。");
      }
    }

    if (input.forecastId) {
      const forecast = await this.prisma.vehicleResidualForecast.findFirst({
        select: { id: true },
        where: { deletedAt: null, id: input.forecastId }
      });

      if (!forecast) {
        throw new BadRequestException("关联的单车残值预测不存在。");
      }
    }

    if (input.vehicleId) {
      const vehicle = await this.prisma.vehicle.findFirst({
        select: { id: true },
        where: { deletedAt: null, id: input.vehicleId }
      });

      if (!vehicle) {
        throw new BadRequestException("关联车辆不存在。");
      }
    }
  }

  private async writeModelRunAudit(
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
      entityType: MODEL_RUN_ENTITY_TYPE,
      ipAddress: context.ipAddress,
      module: RESIDUAL_MARKET_MODULE,
      operatorId: user.id,
      userAgent: context.userAgent
    });
  }
}

function buildModelRunWhere(query: ResidualModelRunQueryDto): Prisma.ResidualModelRunWhereInput {
  const createdAt: Prisma.DateTimeFilter = {};
  const where: Prisma.ResidualModelRunWhereInput = {
    deletedAt: null,
    modelVersion: query.modelVersion ? exactTextFilter(query.modelVersion) : undefined,
    runStatus: query.runStatus,
    runType: query.runType,
    targetBrand: query.targetBrand ? exactTextFilter(query.targetBrand) : undefined,
    targetModel: query.targetModel ? exactTextFilter(query.targetModel) : undefined,
    targetSeries: query.targetSeries ? exactTextFilter(query.targetSeries) : undefined,
    targetType: query.targetType
  };

  if (query.startDate) {
    createdAt.gte = parseDateOnly(query.startDate, "startDate");
  }

  if (query.endDate) {
    createdAt.lt = addDaysDateOnly(parseDateOnly(query.endDate, "endDate"), 1);
  }

  if (hasFilter(createdAt)) {
    where.createdAt = createdAt;
  }

  return where;
}

function buildModelRunCreateData(dto: CreateResidualModelRunDto, userId: string) {
  const runType = parseEnumValue(ResidualModelRunType, dto.runType, "runType");
  const runStatus = dto.runStatus
    ? parseEnumValue(ResidualModelRunStatus, dto.runStatus, "runStatus")
    : ResidualModelRunStatus.CREATED;

  const allowedInitialStatuses: ResidualModelRunStatus[] = [
    ResidualModelRunStatus.CREATED,
    ResidualModelRunStatus.RUNNING
  ];
  if (!allowedInitialStatuses.includes(runStatus)) {
    throw new BadRequestException("模型运行记录初始状态只能为 CREATED 或 RUNNING。");
  }

  const targetType = parseEnumValue(ResidualModelTargetType, dto.targetType, "targetType");
  const trainingDataStartDate = parseOptionalDateOnly(dto.trainingDataStartDate, "trainingDataStartDate");
  const trainingDataEndDate = parseOptionalDateOnly(dto.trainingDataEndDate, "trainingDataEndDate");

  if (trainingDataStartDate && trainingDataEndDate && trainingDataEndDate < trainingDataStartDate) {
    throw new BadRequestException("trainingDataEndDate 不能早于 trainingDataStartDate。");
  }

  return {
    algorithm: parseOptionalEnumValue(ResidualModelAlgorithm, dto.algorithm, "algorithm"),
    createdBy: userId,
    featureSnapshot: jsonObjectOrNull(dto.featureSnapshot),
    filterSnapshot: jsonObjectOrNull(dto.filterSnapshot),
    modelName: normalizeOptionalText(dto.modelName),
    modelProvider: normalizeOptionalText(dto.modelProvider),
    modelVersion: normalizeOptionalText(dto.modelVersion),
    parameterSnapshot: jsonObjectOrNull(dto.parameterSnapshot),
    remark: normalizeOptionalText(dto.remark),
    runName: normalizeOptionalText(dto.runName),
    runStatus,
    runType,
    sampleCount: optionalInteger(dto.sampleCount, "sampleCount", 0),
    startedAt: runStatus === ResidualModelRunStatus.RUNNING ? new Date() : null,
    targetBatteryCapacityKwh: optionalDecimal(dto.targetBatteryCapacityKwh, "targetBatteryCapacityKwh", 0),
    targetBatteryUsageType: parseOptionalEnumValue(
      VehicleBatteryUsageType,
      dto.targetBatteryUsageType,
      "targetBatteryUsageType"
    ),
    targetBrand: normalizeOptionalText(dto.targetBrand),
    targetModel: normalizeOptionalText(dto.targetModel),
    targetModelYear: optionalInteger(dto.targetModelYear, "targetModelYear", 0),
    targetSeries: normalizeOptionalText(dto.targetSeries),
    targetTrim: normalizeOptionalText(dto.targetTrim),
    targetType,
    trainingDataEndDate,
    trainingDataStartDate,
    updatedBy: userId
  } satisfies Omit<Prisma.ResidualModelRunUncheckedCreateInput, "runNo">;
}

function modelRunInclude() {
  return {
    outputs: {
      include: {
        curve: true,
        forecast: true,
        vehicle: true
      },
      orderBy: [{ createdAt: "asc" }]
    }
  } satisfies Prisma.ResidualModelRunInclude;
}

function modelRunOutputInclude() {
  return {
    curve: true,
    forecast: true,
    vehicle: true
  } satisfies Prisma.ResidualModelRunOutputInclude;
}

function assertModelRunCanReceiveCurveOutput(run: Pick<ResidualModelRun, "runStatus">) {
  const linkableStatuses: ResidualModelRunStatus[] = [ResidualModelRunStatus.CREATED, ResidualModelRunStatus.RUNNING];
  if (!linkableStatuses.includes(run.runStatus)) {
    throw new BadRequestException("当前模型运行记录状态不允许关联新的残值曲线输出。");
  }
}

function assertModelRunTargetMatchesCurveInput(run: ResidualModelRun, input: CurveGenerationInput) {
  const textFields: Array<[string | null, string | null, string]> = [
    [run.targetBrand, input.brand, "targetBrand"],
    [run.targetSeries, input.series, "targetSeries"],
    [run.targetModel, input.model, "targetModel"],
    [run.targetTrim, input.trim, "targetTrim"]
  ];

  for (const [runValue, inputValue] of textFields) {
    if (runValue && (!inputValue || runValue.trim().toLowerCase() !== inputValue.trim().toLowerCase())) {
      throw new BadRequestException("模型运行记录目标维度与本次残值曲线生成条件不一致。");
    }
  }

  if (run.targetModelYear !== null && run.targetModelYear !== input.modelYear) {
    throw new BadRequestException("模型运行记录目标维度与本次残值曲线生成条件不一致。");
  }
  if (run.targetBatteryCapacityKwh && !sameOptionalDecimal(run.targetBatteryCapacityKwh, input.batteryCapacityKwh)) {
    throw new BadRequestException("模型运行记录目标维度与本次残值曲线生成条件不一致。");
  }
  if (run.targetBatteryUsageType && run.targetBatteryUsageType !== input.batteryUsageType) {
    throw new BadRequestException("模型运行记录目标维度与本次残值曲线生成条件不一致。");
  }
}

function buildExistingModelRunCurveLinkUpdate(
  run: ResidualModelRun,
  input: CurveGenerationInput,
  preview: BuiltResidualCurvePreview,
  curve: VehicleResidualCurve,
  userId: string,
  finishedAt: Date
): Prisma.ResidualModelRunUncheckedUpdateInput {
  return {
    filterSnapshot: appendModelRunCurveGenerationSnapshot(run.filterSnapshot, buildCurveGenerationModelRunFilterSnapshot(input)),
    finishedAt,
    metricsSnapshot: appendModelRunCurveGenerationSnapshot(
      run.metricsSnapshot,
      buildCurveGenerationModelRunMetricsSnapshot(preview)
    ),
    outputSnapshot: appendModelRunCurveGenerationSnapshot(run.outputSnapshot, buildCurveGenerationModelRunOutputSnapshot(curve)),
    parameterSnapshot: appendModelRunCurveGenerationSnapshot(run.parameterSnapshot, buildCurveGenerationModelRunParameterSnapshot()),
    runStatus: ResidualModelRunStatus.COMPLETED,
    sampleCount: preview.sampleCount,
    startedAt: run.startedAt ?? finishedAt,
    trainingDataEndDate: run.trainingDataEndDate ?? input.sampleEndDate,
    trainingDataStartDate: run.trainingDataStartDate ?? input.sampleStartDate,
    updatedBy: userId
  };
}

function buildAutoModelRunCreateData(
  input: CurveGenerationInput,
  preview: BuiltResidualCurvePreview,
  curve: VehicleResidualCurve,
  userId: string,
  finishedAt: Date
): Omit<Prisma.ResidualModelRunUncheckedCreateInput, "runNo"> {
  const modelVersion = input.modelVersion ?? `statistical-baseline-${compactTimestamp(finishedAt)}`;

  return {
    algorithm: ResidualModelAlgorithm.STATISTICAL_MEDIAN,
    artifactUri: input.artifactUri,
    createdBy: userId,
    featureSnapshot: {
      curveGeneration: {
        features: ["ageMonth", "priceAmount", "confidenceScore", "mileageStats"],
        source: "VehicleMarketPriceObservation"
      }
    },
    filterSnapshot: { curveGeneration: buildCurveGenerationModelRunFilterSnapshot(input) },
    finishedAt,
    metricsSnapshot: { curveGeneration: buildCurveGenerationModelRunMetricsSnapshot(preview) },
    modelName: "statistical_median_curve",
    modelProvider: input.modelProvider ?? "internal",
    modelVersion,
    outputSnapshot: { curveGeneration: buildCurveGenerationModelRunOutputSnapshot(curve) },
    parameterSnapshot: { curveGeneration: buildCurveGenerationModelRunParameterSnapshot() },
    remark: input.remark,
    runName: input.modelRunName ?? `${input.brand} ${input.model} 残值曲线统计基线 ${compactTimestamp(finishedAt)}`,
    runStatus: ResidualModelRunStatus.COMPLETED,
    runType: ResidualModelRunType.STATISTICAL_BASELINE,
    sampleCount: preview.sampleCount,
    startedAt: finishedAt,
    targetBatteryCapacityKwh: input.batteryCapacityKwh,
    targetBatteryUsageType: input.batteryUsageType,
    targetBrand: input.brand,
    targetModel: input.model,
    targetModelYear: input.modelYear,
    targetSeries: input.series,
    targetTrim: input.trim,
    targetType: ResidualModelTargetType.RESIDUAL_CURVE,
    trainingDataEndDate: input.sampleEndDate,
    trainingDataStartDate: input.sampleStartDate,
    updatedBy: userId
  };
}

function buildCurveModelRunOutputCreate(
  runId: string,
  curve: VehicleResidualCurve,
  remark?: string | null
): Prisma.ResidualModelRunOutputUncheckedCreateInput {
  return {
    curveId: curve.id,
    outputNo: curve.curveNo,
    outputSnapshot: buildCurveGenerationModelRunOutputSnapshot(curve),
    outputStatus: ResidualModelRunOutputStatus.ACTIVE,
    outputType: ResidualModelRunOutputType.RESIDUAL_CURVE,
    remark: normalizeOptionalText(remark),
    runId
  };
}

function buildCurveGenerationModelRunFilterSnapshot(input: CurveGenerationInput): Prisma.InputJsonObject {
  return {
    ...curveFilterSnapshot(input),
    minSamplePerPoint: input.minSamplePerPoint
  };
}

function buildCurveGenerationModelRunMetricsSnapshot(preview: BuiltResidualCurvePreview): Prisma.InputJsonObject {
  const ageMonths = preview.points.map((point) => point.ageMonth);
  return {
    ageMonthCount: ageMonths.length,
    confidenceScore: preview.curve.confidenceScore,
    maxAgeMonth: ageMonths.length > 0 ? Math.max(...ageMonths) : null,
    minAgeMonth: ageMonths.length > 0 ? Math.min(...ageMonths) : null,
    pointCount: preview.pointCount,
    sampleCount: preview.sampleCount,
    skippedSampleCount: preview.skippedSampleCount
  };
}

function buildCurveGenerationModelRunOutputSnapshot(curve: VehicleResidualCurve): Prisma.InputJsonObject {
  return {
    batteryCapacityKwh: decimalToNumber(curve.batteryCapacityKwh),
    batteryUsageType: curve.batteryUsageType,
    brand: curve.brand,
    confidenceScore: curve.confidenceScore,
    curveId: curve.id,
    curveMethod: curve.curveMethod,
    curveNo: curve.curveNo,
    curveStatus: curve.curveStatus,
    model: curve.model,
    modelYear: curve.modelYear,
    pointCount: curve.pointCount,
    sampleCount: curve.sampleCount,
    series: curve.series,
    trim: curve.trim
  };
}

function buildCurveGenerationModelRunParameterSnapshot(): Prisma.InputJsonObject {
  return {
    aggregation: "ageMonth",
    curveMethod: VehicleResidualCurveMethod.STATISTICAL_MEDIAN,
    lowerBound: "p25PriceAmount",
    predictedResidualAmount: "medianPriceAmount",
    upperBound: "p75PriceAmount"
  };
}

function appendModelRunCurveGenerationSnapshot(
  value: Prisma.JsonValue | null,
  curveGeneration: Prisma.InputJsonObject
): Prisma.InputJsonObject {
  return {
    ...jsonValueToObject(value),
    curveGeneration
  };
}

function jsonValueToObject(value: Prisma.JsonValue | null): Prisma.InputJsonObject {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return {};
  }
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function toModelRunView(run: ResidualModelRunWithOutputs) {
  return {
    algorithm: run.algorithm,
    artifactUri: run.artifactUri,
    createdAt: run.createdAt.toISOString(),
    createdBy: run.createdBy,
    errorSnapshot: run.errorSnapshot,
    featureSnapshot: run.featureSnapshot,
    filterSnapshot: run.filterSnapshot,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    id: run.id,
    metricsSnapshot: run.metricsSnapshot,
    modelName: run.modelName,
    modelProvider: run.modelProvider,
    modelVersion: run.modelVersion,
    outputCount: run.outputs?.length,
    outputs: run.outputs?.map(toModelRunOutputView),
    outputSnapshot: run.outputSnapshot,
    parameterSnapshot: run.parameterSnapshot,
    remark: run.remark,
    runName: run.runName,
    runNo: run.runNo,
    runStatus: run.runStatus,
    runType: run.runType,
    sampleCount: run.sampleCount,
    startedAt: run.startedAt?.toISOString() ?? null,
    targetBatteryCapacityKwh: decimalToNumber(run.targetBatteryCapacityKwh),
    targetBatteryUsageType: run.targetBatteryUsageType,
    targetBrand: run.targetBrand,
    targetModel: run.targetModel,
    targetModelYear: run.targetModelYear,
    targetSeries: run.targetSeries,
    targetTrim: run.targetTrim,
    targetType: run.targetType,
    trainingDataEndDate: run.trainingDataEndDate ? formatDateOnly(run.trainingDataEndDate) : null,
    trainingDataStartDate: run.trainingDataStartDate ? formatDateOnly(run.trainingDataStartDate) : null,
    updatedAt: run.updatedAt.toISOString(),
    updatedBy: run.updatedBy
  };
}

function toModelRunOutputView(output: ResidualModelRunOutputWithRelations) {
  return {
    createdAt: output.createdAt.toISOString(),
    curve: output.curve ? toForecastCurveSummary(output.curve) : undefined,
    curveId: output.curveId,
    forecast: output.forecast ? toModelRunForecastSummary(output.forecast) : undefined,
    forecastId: output.forecastId,
    id: output.id,
    outputNo: output.outputNo,
    outputSnapshot: output.outputSnapshot,
    outputStatus: output.outputStatus,
    outputType: output.outputType,
    remark: output.remark,
    runId: output.runId,
    updatedAt: output.updatedAt.toISOString(),
    vehicle: output.vehicle ? toForecastVehicleSummary(output.vehicle) : undefined,
    vehicleId: output.vehicleId
  };
}

function toModelRunForecastSummary(forecast: VehicleResidualForecast) {
  return {
    asOfDate: formatDateOnly(forecast.asOfDate),
    batteryCapacityKwh: decimalToNumber(forecast.batteryCapacityKwh),
    batteryUsageType: forecast.batteryUsageType,
    brand: forecast.brand,
    curveId: forecast.curveId,
    forecastMethod: forecast.forecastMethod,
    forecastNo: forecast.forecastNo,
    forecastStatus: forecast.forecastStatus,
    id: forecast.id,
    model: forecast.model,
    modelYear: forecast.modelYear,
    series: forecast.series,
    trim: forecast.trim,
    vehicleId: forecast.vehicleId
  };
}

function modelRunAuditPayload(
  run: Pick<
    ResidualModelRun,
    "id" | "modelName" | "modelVersion" | "runNo" | "runStatus" | "runType" | "targetType"
  >,
  extra: { outputs?: unknown; remark?: string | null }
) {
  return {
    modelName: run.modelName,
    modelVersion: run.modelVersion,
    outputs: extra.outputs,
    remark: extra.remark,
    runId: run.id,
    runNo: run.runNo,
    runStatus: run.runStatus,
    runType: run.runType,
    targetType: run.targetType
  };
}

function jsonObjectOrNull(
  value: Record<string, unknown> | null | undefined
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  if (value == null) {
    return Prisma.JsonNull;
  }
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function addDaysDateOnly(date: Date, days: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
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
  const modelRunId = normalizeOptionalText(dto.modelRunId);
  const autoCreateModelRun = dto.autoCreateModelRun ?? false;
  if (modelRunId && autoCreateModelRun) {
    throw new BadRequestException("不能同时指定已有模型运行记录和自动创建模型运行记录。");
  }
  if (referencePriceAmount !== null && referencePriceAmount <= 0n) {
    throw new BadRequestException("referencePriceAmount 必须大于 0。");
  }

  return {
    artifactUri: normalizeOptionalText(dto.artifactUri),
    autoCreateModelRun,
    batteryCapacityKwh: optionalDecimal(dto.batteryCapacityKwh, "batteryCapacityKwh", 0),
    batteryUsageType: parseOptionalEnumValue(VehicleBatteryUsageType, dto.batteryUsageType, "batteryUsageType"),
    brand: requiredText(dto.brand, "brand"),
    curveName: normalizeOptionalText(dto.curveName),
    curveVersion: normalizeOptionalText(dto.curveVersion),
    dryRun: dto.dryRun ?? false,
    minSamplePerPoint: optionalInteger(dto.minSamplePerPoint, "minSamplePerPoint", 1) ?? 3,
    model: requiredText(dto.model, "model"),
    modelProvider: normalizeOptionalText(dto.modelProvider),
    modelRunId,
    modelRunName: normalizeOptionalText(dto.modelRunName),
    modelVersion: normalizeOptionalText(dto.modelVersion),
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

function buildForecastGenerationInput(dto: GenerateVehicleResidualForecastDto): ForecastGenerationInput {
  return {
    asOfDate: dto.asOfDate ? parseDateOnly(dto.asOfDate, "asOfDate") : todayDateOnly(),
    curveId: normalizeOptionalText(dto.curveId),
    dryRun: dto.dryRun ?? false,
    horizonMonths: normalizeForecastHorizons(dto.horizonMonths),
    remark: normalizeOptionalText(dto.remark)
  };
}

function normalizeForecastHorizons(horizonMonths: number[] | undefined) {
  if (horizonMonths === undefined || horizonMonths === null) {
    return DEFAULT_FORECAST_HORIZONS;
  }

  if (!Array.isArray(horizonMonths) || horizonMonths.length === 0) {
    throw new BadRequestException("horizonMonths 不能为空。");
  }
  if (horizonMonths.length > 10) {
    throw new BadRequestException("horizonMonths 最多支持 10 个预测点。");
  }

  const normalized = [...new Set(horizonMonths.map((horizon) => optionalInteger(horizon, "horizonMonths", 0)))];
  if (normalized.some((horizon) => horizon === null)) {
    throw new BadRequestException("horizonMonths 必须是大于等于 0 的整数。");
  }

  return (normalized as number[]).sort((left, right) => left - right);
}

function buildVehicleResidualForecastPreview(
  vehicle: Vehicle,
  selection: CurveSelection,
  input: ForecastGenerationInput,
  vehicleAgeMonths: number
): BuiltVehicleResidualForecastPreview {
  const points = input.horizonMonths.map((horizonMonth) =>
    buildVehicleResidualForecastPoint(vehicle, selection.curve, input.asOfDate, vehicleAgeMonths, horizonMonth)
  );
  const unsupportedCount = points.filter((point) => point.pointStatus === VehicleResidualForecastPointStatus.UNSUPPORTED).length;
  const exactCount = points.filter((point) => point.interpolationMethod === ResidualForecastInterpolationMethod.EXACT).length;
  const interpolationCount = points.filter(
    (point) => point.interpolationMethod === ResidualForecastInterpolationMethod.LINEAR_INTERPOLATION
  ).length;
  const forecast: BuiltVehicleResidualForecast = {
    asOfDate: input.asOfDate,
    batteryCapacityKwh: vehicle.batteryCapacityKwh,
    batteryUsageType: vehicle.batteryUsageType,
    brand: vehicle.brand,
    curveId: selection.curve.id,
    curveSnapshot: curveSummarySnapshot(selection.curve),
    currentMileageKm: vehicle.currentMileageKm,
    currentSalePriceAmount: vehicle.currentSalePriceAmount,
    forecastMethod: VehicleResidualForecastMethod.CURVE_STATISTICAL,
    forecastStatus: VehicleResidualForecastStatus.GENERATED,
    inputSnapshot: {
      amountUnit: "fen",
      asOfDate: formatDateOnly(input.asOfDate),
      curveMatch: {
        candidateSummaries: selection.candidateSummaries,
        matchedFields: selection.matchedFields,
        score: selection.score,
        selectedCurveId: selection.curve.id,
        selectedCurveNo: selection.curve.curveNo
      },
      dryRun: input.dryRun,
      horizonMonths: input.horizonMonths
    },
    metrics: {
      exactCount,
      horizonMonths: input.horizonMonths,
      interpolationCount,
      pointCount: points.length,
      unsupportedCount
    },
    model: vehicle.model,
    modelYear: vehicle.modelYear,
    purchasePriceAmount: vehicle.purchasePriceAmount,
    remark: input.remark,
    series: vehicle.series,
    trim: null,
    vehicleAgeMonths,
    vehicleId: vehicle.id,
    vehicleSnapshot: vehicleSummarySnapshot(vehicle)
  };

  return {
    dryRun: input.dryRun,
    forecast,
    pointCount: points.length,
    points
  };
}

function buildVehicleResidualForecastPoint(
  vehicle: Vehicle,
  curve: ForecastCurve,
  asOfDate: Date,
  vehicleAgeMonths: number,
  horizonMonth: number
): BuiltVehicleResidualForecastPoint {
  const targetDate = addMonthsDateOnly(asOfDate, horizonMonth);
  const targetAgeMonth = vehicleAgeMonths + horizonMonth;
  const usablePoints = curve.points
    .filter((point) => point.predictedResidualAmount !== null)
    .sort((left, right) => left.ageMonth - right.ageMonth);
  const exactPoint = usablePoints.find((point) => point.ageMonth === targetAgeMonth);

  if (exactPoint) {
    const predictedResidualAmount = exactPoint.predictedResidualAmount;
    return {
      confidenceScore: exactPoint.confidenceScore,
      horizonMonth,
      interpolationMethod: ResidualForecastInterpolationMethod.EXACT,
      lowerBoundAmount: exactPoint.lowerBoundAmount,
      matchedCurvePointAgeMonth: exactPoint.ageMonth,
      pointSnapshot: {
        curvePointId: exactPoint.id,
        method: ResidualForecastInterpolationMethod.EXACT
      },
      pointStatus: VehicleResidualForecastPointStatus.GENERATED,
      predictedResidualAmount,
      predictedResidualRateBps: calculateVehicleResidualRateBps(predictedResidualAmount, vehicle.purchasePriceAmount),
      targetAgeMonth,
      targetDate,
      upperBoundAmount: exactPoint.upperBoundAmount
    };
  }

  const lowerPoint = [...usablePoints].reverse().find((point) => point.ageMonth < targetAgeMonth);
  const upperPoint = usablePoints.find((point) => point.ageMonth > targetAgeMonth);

  if (lowerPoint && upperPoint) {
    const ratio = (targetAgeMonth - lowerPoint.ageMonth) / (upperPoint.ageMonth - lowerPoint.ageMonth);
    const predictedResidualAmount = interpolateBigInt(lowerPoint.predictedResidualAmount, upperPoint.predictedResidualAmount, ratio);
    const lowerBoundAmount = interpolateBigInt(lowerPoint.lowerBoundAmount, upperPoint.lowerBoundAmount, ratio);
    const upperBoundAmount = interpolateBigInt(lowerPoint.upperBoundAmount, upperPoint.upperBoundAmount, ratio);

    return {
      confidenceScore: interpolateNumber(lowerPoint.confidenceScore, upperPoint.confidenceScore, ratio),
      horizonMonth,
      interpolationMethod: ResidualForecastInterpolationMethod.LINEAR_INTERPOLATION,
      lowerBoundAmount,
      matchedCurvePointAgeMonth: null,
      pointSnapshot: {
        lowerAgeMonth: lowerPoint.ageMonth,
        lowerCurvePointId: lowerPoint.id,
        method: ResidualForecastInterpolationMethod.LINEAR_INTERPOLATION,
        ratio,
        upperAgeMonth: upperPoint.ageMonth,
        upperCurvePointId: upperPoint.id
      },
      pointStatus: VehicleResidualForecastPointStatus.GENERATED,
      predictedResidualAmount,
      predictedResidualRateBps: calculateVehicleResidualRateBps(predictedResidualAmount, vehicle.purchasePriceAmount),
      targetAgeMonth,
      targetDate,
      upperBoundAmount
    };
  }

  return {
    confidenceScore: null,
    horizonMonth,
    interpolationMethod: ResidualForecastInterpolationMethod.UNSUPPORTED_OUT_OF_RANGE,
    lowerBoundAmount: null,
    matchedCurvePointAgeMonth: null,
    pointSnapshot: {
      curveAgeMonthRange: {
        maxAgeMonth: usablePoints[usablePoints.length - 1]?.ageMonth ?? null,
        minAgeMonth: usablePoints[0]?.ageMonth ?? null
      },
      method: ResidualForecastInterpolationMethod.UNSUPPORTED_OUT_OF_RANGE,
      unsupportedReason: "目标车龄超出当前残值曲线范围，暂不做外推。"
    },
    pointStatus: VehicleResidualForecastPointStatus.UNSUPPORTED,
    predictedResidualAmount: null,
    predictedResidualRateBps: null,
    targetAgeMonth,
    targetDate,
    upperBoundAmount: null
  };
}

function rankForecastCurve(curve: ForecastCurve, vehicle: Vehicle): CurveSelection {
  const matchedFields = ["brand", "model"];
  let score = 0;

  if (sameOptionalText(curve.series, vehicle.series)) {
    score += 10;
    matchedFields.push("series");
  }
  if (curve.modelYear !== null && curve.modelYear !== undefined && curve.modelYear === vehicle.modelYear) {
    score += 10;
    matchedFields.push("modelYear");
  }
  if (sameOptionalDecimal(curve.batteryCapacityKwh, vehicle.batteryCapacityKwh)) {
    score += 10;
    matchedFields.push("batteryCapacityKwh");
  }
  if (curve.batteryUsageType && curve.batteryUsageType === vehicle.batteryUsageType) {
    score += 5;
    matchedFields.push("batteryUsageType");
  }

  return {
    candidateSummaries: [],
    curve,
    matchedFields,
    score
  };
}

function compareCurveSelection(left: CurveSelection, right: CurveSelection) {
  if (left.score !== right.score) {
    return right.score - left.score;
  }

  const leftEffectiveFrom = left.curve.effectiveFrom?.getTime() ?? 0;
  const rightEffectiveFrom = right.curve.effectiveFrom?.getTime() ?? 0;
  if (leftEffectiveFrom !== rightEffectiveFrom) {
    return rightEffectiveFrom - leftEffectiveFrom;
  }

  return right.curve.generatedAt.getTime() - left.curve.generatedAt.getTime();
}

function curveCandidateSummary(curve: ForecastCurve, score: number, matchedFields: string[]): Prisma.InputJsonObject {
  return {
    brand: curve.brand,
    curveId: curve.id,
    curveNo: curve.curveNo,
    effectiveFrom: curve.effectiveFrom ? formatDateOnly(curve.effectiveFrom) : null,
    generatedAt: curve.generatedAt.toISOString(),
    matchedFields,
    model: curve.model,
    modelYear: curve.modelYear,
    pointCount: curve.points.length,
    score
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

function diffMonths(later: Date, earlier: Date) {
  let months =
    (later.getUTCFullYear() - earlier.getUTCFullYear()) * 12 +
    (later.getUTCMonth() - earlier.getUTCMonth());

  if (later.getUTCDate() < earlier.getUTCDate()) {
    months -= 1;
  }

  return Math.max(0, months);
}

function addMonthsDateOnly(date: Date, months: number) {
  const targetMonth = date.getUTCMonth() + months;
  const targetYear = date.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const day = Math.min(date.getUTCDate(), lastDayOfTargetMonth);
  return new Date(Date.UTC(targetYear, normalizedMonth, day));
}

function interpolateBigInt(left: bigint | null, right: bigint | null, ratio: number) {
  if (left === null || right === null) {
    return null;
  }
  return BigInt(Math.round(Number(left) + (Number(right) - Number(left)) * ratio));
}

function interpolateNumber(left: number | null, right: number | null, ratio: number) {
  if (left === null || right === null) {
    return null;
  }
  return Math.round(left + (right - left) * ratio);
}

function calculateVehicleResidualRateBps(predictedResidualAmount: bigint | null, purchasePriceAmount: bigint | null) {
  if (predictedResidualAmount === null || purchasePriceAmount === null || purchasePriceAmount <= 0n) {
    return null;
  }
  return Math.round(Number(predictedResidualAmount) / Number(purchasePriceAmount) * 10000);
}

function sameOptionalText(left: string | null, right: string | null) {
  return Boolean(left && right && left.trim().toLowerCase() === right.trim().toLowerCase());
}

function sameOptionalDecimal(left: Prisma.Decimal | null, right: Prisma.Decimal | null) {
  return Boolean(left && right && left.toString() === right.toString());
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
  preview: BuiltResidualCurvePreview,
  options: {
    modelRun?: ReturnType<typeof toModelRunView> | null;
    modelRunLinked?: boolean;
    modelRunOutput?: ReturnType<typeof toModelRunOutputView> | null;
    warnings?: string[];
  } = {}
) {
  return {
    curve,
    dryRun,
    modelRun: options.modelRun ?? null,
    modelRunLinked: options.modelRunLinked ?? false,
    modelRunOutput: options.modelRunOutput ?? null,
    pointCount: preview.pointCount,
    points: points.map((point) => ("id" in point ? toCurvePointView(point) : toBuiltCurvePointView(point))),
    sampleCount: preview.sampleCount,
    skippedReasons: preview.skippedReasons,
    skippedSampleCount: preview.skippedSampleCount,
    warnings: options.warnings ?? []
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

function toForecastPointCreateInput(point: BuiltVehicleResidualForecastPoint) {
  return {
    confidenceScore: point.confidenceScore,
    horizonMonth: point.horizonMonth,
    interpolationMethod: point.interpolationMethod,
    lowerBoundAmount: point.lowerBoundAmount,
    matchedCurvePointAgeMonth: point.matchedCurvePointAgeMonth,
    pointSnapshot: point.pointSnapshot,
    pointStatus: point.pointStatus,
    predictedResidualAmount: point.predictedResidualAmount,
    predictedResidualRateBps: point.predictedResidualRateBps,
    targetAgeMonth: point.targetAgeMonth,
    targetDate: point.targetDate,
    upperBoundAmount: point.upperBoundAmount
  };
}

function vehicleForecastGenerationResponse(
  dryRun: boolean,
  forecast: ReturnType<typeof toForecastPreviewView> | ReturnType<typeof toForecastView>,
  points: BuiltVehicleResidualForecastPoint[] | VehicleResidualForecastPoint[],
  preview: BuiltVehicleResidualForecastPreview
) {
  return {
    dryRun,
    forecast,
    pointCount: preview.pointCount,
    points: points.map((point) => ("id" in point ? toForecastPointView(point) : toBuiltForecastPointView(point)))
  };
}

function toForecastPreviewView(forecast: BuiltVehicleResidualForecast) {
  return {
    asOfDate: formatDateOnly(forecast.asOfDate),
    batteryCapacityKwh: decimalToNumber(forecast.batteryCapacityKwh),
    batteryUsageType: forecast.batteryUsageType,
    brand: forecast.brand,
    createdAt: null,
    createdBy: null,
    curveId: forecast.curveId,
    curveSnapshot: forecast.curveSnapshot,
    currentMileageKm: forecast.currentMileageKm,
    currentSalePriceAmount: numberOrNull(forecast.currentSalePriceAmount),
    forecastMethod: forecast.forecastMethod,
    forecastNo: null,
    forecastStatus: forecast.forecastStatus,
    id: null,
    inputSnapshot: forecast.inputSnapshot,
    metrics: forecast.metrics,
    model: forecast.model,
    modelYear: forecast.modelYear,
    pointCount: null,
    points: undefined,
    purchasePriceAmount: numberOrNull(forecast.purchasePriceAmount),
    remark: forecast.remark,
    series: forecast.series,
    trim: forecast.trim,
    updatedAt: null,
    updatedBy: null,
    vehicleAgeMonths: forecast.vehicleAgeMonths,
    vehicleId: forecast.vehicleId,
    vehicleSnapshot: forecast.vehicleSnapshot
  };
}

function toForecastView(forecast: VehicleResidualForecastWithRelations) {
  return {
    asOfDate: formatDateOnly(forecast.asOfDate),
    batteryCapacityKwh: decimalToNumber(forecast.batteryCapacityKwh),
    batteryUsageType: forecast.batteryUsageType,
    brand: forecast.brand,
    createdAt: forecast.createdAt.toISOString(),
    createdBy: forecast.createdBy,
    curve: forecast.curve ? toForecastCurveSummary(forecast.curve) : undefined,
    curveId: forecast.curveId,
    curveSnapshot: forecast.curveSnapshot,
    currentMileageKm: forecast.currentMileageKm,
    currentSalePriceAmount: numberOrNull(forecast.currentSalePriceAmount),
    forecastMethod: forecast.forecastMethod,
    forecastNo: forecast.forecastNo,
    forecastStatus: forecast.forecastStatus,
    id: forecast.id,
    inputSnapshot: forecast.inputSnapshot,
    metrics: forecast.metrics,
    model: forecast.model,
    modelYear: forecast.modelYear,
    pointCount: forecast.points?.length,
    points: forecast.points?.map(toForecastPointView),
    purchasePriceAmount: numberOrNull(forecast.purchasePriceAmount),
    remark: forecast.remark,
    series: forecast.series,
    trim: forecast.trim,
    updatedAt: forecast.updatedAt.toISOString(),
    updatedBy: forecast.updatedBy,
    vehicle: forecast.vehicle ? toForecastVehicleSummary(forecast.vehicle) : undefined,
    vehicleAgeMonths: forecast.vehicleAgeMonths,
    vehicleId: forecast.vehicleId,
    vehicleSnapshot: forecast.vehicleSnapshot
  };
}

function toBuiltForecastPointView(point: BuiltVehicleResidualForecastPoint) {
  return {
    adoptedAt: null,
    adoptedBy: null,
    adoptedResidualAmount: null,
    adoptRemark: null,
    confidenceScore: point.confidenceScore,
    forecastId: null,
    horizonMonth: point.horizonMonth,
    id: null,
    interpolationMethod: point.interpolationMethod,
    lowerBoundAmount: numberOrNull(point.lowerBoundAmount),
    matchedCurvePointAgeMonth: point.matchedCurvePointAgeMonth,
    pointSnapshot: point.pointSnapshot,
    pointStatus: point.pointStatus,
    predictedResidualAmount: numberOrNull(point.predictedResidualAmount),
    predictedResidualRateBps: point.predictedResidualRateBps,
    targetAgeMonth: point.targetAgeMonth,
    targetDate: formatDateOnly(point.targetDate),
    upperBoundAmount: numberOrNull(point.upperBoundAmount)
  };
}

function toForecastPointView(point: VehicleResidualForecastPointWithForecast | VehicleResidualForecastPoint) {
  return {
    adoptedAt: point.adoptedAt ? point.adoptedAt.toISOString() : null,
    adoptedBy: point.adoptedBy,
    adoptedResidualAmount: numberOrNull(point.adoptedResidualAmount),
    adoptRemark: point.adoptRemark,
    confidenceScore: point.confidenceScore,
    createdAt: point.createdAt.toISOString(),
    forecastId: point.forecastId,
    horizonMonth: point.horizonMonth,
    id: point.id,
    interpolationMethod: point.interpolationMethod,
    lowerBoundAmount: numberOrNull(point.lowerBoundAmount),
    matchedCurvePointAgeMonth: point.matchedCurvePointAgeMonth,
    pointSnapshot: point.pointSnapshot,
    pointStatus: point.pointStatus,
    predictedResidualAmount: numberOrNull(point.predictedResidualAmount),
    predictedResidualRateBps: point.predictedResidualRateBps,
    targetAgeMonth: point.targetAgeMonth,
    targetDate: formatDateOnly(point.targetDate),
    updatedAt: point.updatedAt.toISOString(),
    upperBoundAmount: numberOrNull(point.upperBoundAmount)
  };
}

function toForecastCurveSummary(curve: VehicleResidualCurve) {
  return {
    batteryCapacityKwh: decimalToNumber(curve.batteryCapacityKwh),
    batteryUsageType: curve.batteryUsageType,
    brand: curve.brand,
    confidenceScore: curve.confidenceScore,
    curveMethod: curve.curveMethod,
    curveName: curve.curveName,
    curveNo: curve.curveNo,
    curveStatus: curve.curveStatus,
    effectiveFrom: curve.effectiveFrom ? formatDateOnly(curve.effectiveFrom) : null,
    id: curve.id,
    model: curve.model,
    modelYear: curve.modelYear,
    pointCount: curve.pointCount,
    series: curve.series,
    trim: curve.trim
  };
}

function toForecastVehicleSummary(vehicle: Vehicle) {
  return {
    batteryCapacityKwh: decimalToNumber(vehicle.batteryCapacityKwh),
    batteryUsageType: vehicle.batteryUsageType,
    brand: vehicle.brand,
    currentMileageKm: vehicle.currentMileageKm,
    currentSalePriceAmount: numberOrNull(vehicle.currentSalePriceAmount),
    id: vehicle.id,
    model: vehicle.model,
    modelYear: vehicle.modelYear,
    purchasePriceAmount: Number(vehicle.purchasePriceAmount),
    registrationDate: vehicle.registrationDate ? formatDateOnly(vehicle.registrationDate) : null,
    series: vehicle.series,
    vehicleNo: vehicle.vehicleNo
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

function forecastAuditPayload(
  forecast: VehicleResidualForecastWithRelations,
  extra: { horizonMonths?: number[]; remark?: string | null }
) {
  return {
    asOfDate: formatDateOnly(forecast.asOfDate),
    curveId: forecast.curveId,
    curveNo: forecast.curve?.curveNo ?? null,
    forecastId: forecast.id,
    forecastNo: forecast.forecastNo,
    horizonMonths: extra.horizonMonths ?? forecast.points?.map((point) => point.horizonMonth) ?? [],
    remark: extra.remark ?? null,
    vehicleId: forecast.vehicleId
  };
}

function forecastPointAuditPayload(
  point: VehicleResidualForecastPointWithForecast,
  extra: { adoptedResidualAmount?: bigint | null; remark?: string | null }
) {
  return {
    adoptedResidualAmount: numberOrNull(extra.adoptedResidualAmount ?? null),
    asOfDate: point.forecast?.asOfDate ? formatDateOnly(point.forecast.asOfDate) : null,
    curveId: point.forecast?.curveId ?? null,
    curveNo: point.forecast?.curve?.curveNo ?? null,
    forecastId: point.forecastId,
    forecastNo: point.forecast?.forecastNo ?? null,
    horizonMonths: [point.horizonMonth],
    remark: extra.remark ?? null,
    vehicleId: point.forecast?.vehicleId ?? null
  };
}

function curveSummarySnapshot(curve: ForecastCurve): Prisma.InputJsonObject {
  return {
    batteryCapacityKwh: decimalToNumber(curve.batteryCapacityKwh),
    batteryUsageType: curve.batteryUsageType,
    brand: curve.brand,
    confidenceScore: curve.confidenceScore,
    curveId: curve.id,
    curveMethod: curve.curveMethod,
    curveName: curve.curveName,
    curveNo: curve.curveNo,
    curveStatus: curve.curveStatus,
    effectiveFrom: curve.effectiveFrom ? formatDateOnly(curve.effectiveFrom) : null,
    generatedAt: curve.generatedAt.toISOString(),
    model: curve.model,
    modelYear: curve.modelYear,
    pointCount: curve.points.length,
    sampleCount: curve.sampleCount,
    series: curve.series,
    trim: curve.trim
  };
}

function vehicleSummarySnapshot(vehicle: Vehicle): Prisma.InputJsonObject {
  return {
    batteryCapacityKwh: decimalToNumber(vehicle.batteryCapacityKwh),
    batteryUsageType: vehicle.batteryUsageType,
    brand: vehicle.brand,
    currentMileageKm: vehicle.currentMileageKm,
    currentSalePriceAmount: numberOrNull(vehicle.currentSalePriceAmount),
    model: vehicle.model,
    modelYear: vehicle.modelYear,
    purchasePriceAmount: Number(vehicle.purchasePriceAmount),
    registrationDate: vehicle.registrationDate ? formatDateOnly(vehicle.registrationDate) : null,
    series: vehicle.series,
    vehicleId: vehicle.id,
    vehicleNo: vehicle.vehicleNo
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

function compactTimestamp(date: Date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0")
  ].join("");
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
