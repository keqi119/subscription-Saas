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
  VehicleMarketPriceObservation
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import { parseCsvRecords } from "./csv-parser";
import {
  CreateMarketPriceObservationDto,
  ImportMarketPriceCsvDto,
  MarketPriceImportBatchesQueryDto,
  MarketPriceObservationsQueryDto,
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

const OBSERVATION_ENTITY_TYPE = "vehicle_market_price_observation";
const BATCH_ENTITY_TYPE = "market_price_import_batch";
const RESIDUAL_MARKET_MODULE = "residual_market";
const DUPLICATE_MESSAGE = "该市场价格样本已存在，不能重复创建。";

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

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
