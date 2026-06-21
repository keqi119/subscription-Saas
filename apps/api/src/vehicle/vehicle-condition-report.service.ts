import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  Prisma,
  VehicleConditionItemResult,
  VehicleConditionItemSeverity,
  VehicleConditionReportStatus
} from "@prisma/client";
import { randomUUID } from "node:crypto";

import { RequestUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import {
  CreateVehicleConditionReportDto,
  CreateVehicleConditionReportItemDto,
  UpdateVehicleConditionReportDto,
  UpdateVehicleConditionReportItemDto
} from "./dto/vehicle-condition-report.dto";

const conditionReportInclude = {
  items: {
    orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }],
    where: { deletedAt: null }
  }
} satisfies Prisma.VehicleConditionReportInclude;

type ConditionReportWithItems = Prisma.VehicleConditionReportGetPayload<{
  include: typeof conditionReportInclude;
}>;

type ConditionReportItemRecord = Prisma.VehicleConditionReportItemGetPayload<Record<string, never>>;

@Injectable()
export class VehicleConditionReportService {
  constructor(private readonly prisma: PrismaService) {}

  async listReports(vehicleId: string) {
    await this.findVehicleOrThrow(vehicleId);
    const reports = await this.prisma.vehicleConditionReport.findMany({
      include: conditionReportInclude,
      orderBy: [{ inspectionDate: "desc" }, { createdAt: "desc" }],
      where: {
        deletedAt: null,
        vehicleId
      }
    });

    return reports.map(toReportView);
  }

  async createReport(vehicleId: string, dto: CreateVehicleConditionReportDto, user: RequestUser) {
    await this.findVehicleOrThrow(vehicleId);
    const report = await this.prisma.vehicleConditionReport.create({
      data: {
        createdBy: user.id,
        inspectionDate: parseOptionalDateOnly(dto.inspectionDate, "inspectionDate"),
        inspectorName: dto.inspectorName ?? null,
        inspectorOrg: dto.inspectorOrg ?? null,
        odometerKm: dto.odometerKm ?? null,
        overallGrade: dto.overallGrade ?? null,
        reportNo: dto.reportNo?.trim() || generateReportNo(),
        summary: dto.summary ?? null,
        updatedBy: user.id,
        vehicleId
      },
      include: conditionReportInclude
    });

    return toReportView(report);
  }

  async getReport(id: string) {
    return toReportView(await this.findReportOrThrow(id));
  }

  async updateReport(id: string, dto: UpdateVehicleConditionReportDto, user: RequestUser) {
    await this.findReportOrThrow(id);
    const report = await this.prisma.vehicleConditionReport.update({
      data: buildReportUpdateData(dto, user.id),
      include: conditionReportInclude,
      where: { id }
    });

    return toReportView(report);
  }

  async publishReport(id: string, user: RequestUser) {
    const report = await this.findReportOrThrow(id);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.vehicleConditionReport.updateMany({
        data: {
          archivedAt: now,
          customerVisible: false,
          reportStatus: VehicleConditionReportStatus.ARCHIVED,
          updatedBy: user.id
        },
        where: {
          deletedAt: null,
          id: { not: id },
          reportStatus: VehicleConditionReportStatus.PUBLISHED,
          vehicleId: report.vehicleId
        }
      });

      await tx.vehicleConditionReport.update({
        data: {
          archivedAt: null,
          customerVisible: true,
          publishedAt: now,
          reportStatus: VehicleConditionReportStatus.PUBLISHED,
          updatedBy: user.id
        },
        where: { id }
      });
    });

    return this.getReport(id);
  }

  async archiveReport(id: string, user: RequestUser) {
    await this.findReportOrThrow(id);
    const report = await this.prisma.vehicleConditionReport.update({
      data: {
        archivedAt: new Date(),
        customerVisible: false,
        reportStatus: VehicleConditionReportStatus.ARCHIVED,
        updatedBy: user.id
      },
      include: conditionReportInclude,
      where: { id }
    });

    return toReportView(report);
  }

  async createItem(reportId: string, dto: CreateVehicleConditionReportItemDto) {
    const report = await this.findReportOrThrow(reportId);
    const mediaIds = await this.validateMediaIds(report.vehicleId, dto.mediaIds);
    const item = await this.prisma.vehicleConditionReportItem.create({
      data: {
        affectsSafety: dto.affectsSafety ?? false,
        area: dto.area,
        customerVisible: dto.customerVisible ?? true,
        description: dto.description ?? null,
        itemType: dto.itemType,
        mediaIds,
        partName: dto.partName ?? null,
        repairRequired: dto.repairRequired ?? false,
        reportId,
        result: dto.result ?? VehicleConditionItemResult.UNKNOWN,
        severity: dto.severity ?? VehicleConditionItemSeverity.MINOR,
        sortOrder: dto.sortOrder ?? 0,
        title: dto.title ?? null
      }
    });

    return toItemView(item);
  }

  async updateItem(itemId: string, dto: UpdateVehicleConditionReportItemDto) {
    const item = await this.findItemWithReportOrThrow(itemId);
    const mediaIds = dto.mediaIds === undefined ? undefined : await this.validateMediaIds(item.report.vehicleId, dto.mediaIds);
    const data = buildItemUpdateData(dto, mediaIds);
    const nextItem = await this.prisma.vehicleConditionReportItem.update({
      data,
      where: { id: itemId }
    });

    return toItemView(nextItem);
  }

  async deleteItem(itemId: string) {
    await this.findItemWithReportOrThrow(itemId);
    const item = await this.prisma.vehicleConditionReportItem.update({
      data: {
        customerVisible: false,
        deletedAt: new Date()
      },
      where: { id: itemId }
    });

    return toItemView(item);
  }

  private async findVehicleOrThrow(vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: {
        deletedAt: null,
        id: vehicleId
      }
    });

    if (!vehicle) {
      throw new NotFoundException("vehicle not found");
    }

    return vehicle;
  }

  private async findReportOrThrow(id: string) {
    const report = await this.prisma.vehicleConditionReport.findFirst({
      include: conditionReportInclude,
      where: {
        deletedAt: null,
        id
      }
    });

    if (!report) {
      throw new NotFoundException("vehicle condition report not found");
    }

    return report;
  }

  private async findItemWithReportOrThrow(itemId: string) {
    const item = await this.prisma.vehicleConditionReportItem.findFirst({
      include: {
        report: {
          select: {
            deletedAt: true,
            id: true,
            vehicleId: true
          }
        }
      },
      where: {
        deletedAt: null,
        id: itemId
      }
    });

    if (!item || item.report.deletedAt) {
      throw new NotFoundException("vehicle condition report item not found");
    }

    return item;
  }

  private async validateMediaIds(vehicleId: string, mediaIds: string[] | null | undefined) {
    if (mediaIds === undefined) {
      return undefined;
    }

    const normalized = Array.from(
      new Set((mediaIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0))
    );

    if (normalized.length === 0) {
      return Prisma.JsonNull;
    }

    const rows = await this.prisma.vehicleListingMedia.findMany({
      select: { id: true },
      where: {
        customerVisible: true,
        deletedAt: null,
        id: { in: normalized },
        vehicleId
      }
    });

    if (rows.length !== normalized.length) {
      throw new BadRequestException("mediaIds must reference customer-visible media from the same vehicle");
    }

    return normalized;
  }
}

function buildReportUpdateData(dto: UpdateVehicleConditionReportDto, userId: string) {
  const data: Prisma.VehicleConditionReportUncheckedUpdateInput = {
    updatedBy: userId
  };

  assignIfDefined(data, "batteryCheckedAt", parseOptionalDateOnly(dto.batteryCheckedAt, "batteryCheckedAt"));
  assignIfDefined(data, "batteryCycleCount", dto.batteryCycleCount);
  assignIfDefined(data, "batteryEstimatedRangeKm", dto.batteryEstimatedRangeKm);
  assignIfDefined(data, "batteryHealthPercent", decimalOrNull(dto.batteryHealthPercent));
  assignIfDefined(data, "batteryRemark", dto.batteryRemark);
  assignIfDefined(data, "batteryWarrantyUntil", parseOptionalDateOnly(dto.batteryWarrantyUntil, "batteryWarrantyUntil"));
  assignIfDefined(data, "brakeSummary", dto.brakeSummary);
  assignIfDefined(data, "chassisSummary", dto.chassisSummary);
  assignIfDefined(data, "customerSummary", dto.customerSummary);
  assignIfDefined(data, "exteriorSummary", dto.exteriorSummary);
  assignIfDefined(data, "glassLightSummary", dto.glassLightSummary);
  assignIfDefined(data, "hasFireDamage", dto.hasFireDamage);
  assignIfDefined(data, "hasFloodDamage", dto.hasFloodDamage);
  assignIfDefined(data, "hasMajorAccident", dto.hasMajorAccident);
  assignIfDefined(data, "hasStructuralDamage", dto.hasStructuralDamage);
  assignIfDefined(data, "inspectionDate", parseOptionalDateOnly(dto.inspectionDate, "inspectionDate"));
  assignIfDefined(data, "inspectorName", dto.inspectorName);
  assignIfDefined(data, "inspectorOrg", dto.inspectorOrg);
  assignIfDefined(data, "interiorSummary", dto.interiorSummary);
  assignIfDefined(data, "odometerKm", dto.odometerKm);
  assignIfDefined(data, "overallGrade", dto.overallGrade);
  assignIfDefined(data, "repairSuggestion", dto.repairSuggestion);
  assignIfDefined(data, "safetyConclusion", dto.safetyConclusion);
  assignIfDefined(data, "summary", dto.summary);
  assignIfDefined(data, "tireSummary", dto.tireSummary);

  return data;
}

function buildItemUpdateData(
  dto: UpdateVehicleConditionReportItemDto,
  mediaIds: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined
) {
  const data: Prisma.VehicleConditionReportItemUncheckedUpdateInput = {};

  assignIfDefined(data, "affectsSafety", dto.affectsSafety);
  assignIfDefined(data, "area", dto.area);
  assignIfDefined(data, "customerVisible", dto.customerVisible);
  assignIfDefined(data, "description", dto.description);
  assignIfDefined(data, "itemType", dto.itemType);
  assignIfDefined(data, "mediaIds", mediaIds);
  assignIfDefined(data, "partName", dto.partName);
  assignIfDefined(data, "repairRequired", dto.repairRequired);
  assignIfDefined(data, "result", dto.result);
  assignIfDefined(data, "severity", dto.severity);
  assignIfDefined(data, "sortOrder", dto.sortOrder);
  assignIfDefined(data, "title", dto.title);

  return data;
}

function toReportView(report: ConditionReportWithItems) {
  return {
    archivedAt: report.archivedAt,
    batteryCheckedAt: report.batteryCheckedAt,
    batteryCycleCount: report.batteryCycleCount,
    batteryEstimatedRangeKm: report.batteryEstimatedRangeKm,
    batteryHealthPercent: decimalToNumber(report.batteryHealthPercent),
    batteryRemark: report.batteryRemark,
    batteryWarrantyUntil: report.batteryWarrantyUntil,
    brakeSummary: report.brakeSummary,
    chassisSummary: report.chassisSummary,
    createdAt: report.createdAt,
    createdBy: report.createdBy,
    customerSummary: report.customerSummary,
    customerVisible: report.customerVisible,
    deletedAt: report.deletedAt,
    exteriorSummary: report.exteriorSummary,
    glassLightSummary: report.glassLightSummary,
    hasFireDamage: report.hasFireDamage,
    hasFloodDamage: report.hasFloodDamage,
    hasMajorAccident: report.hasMajorAccident,
    hasStructuralDamage: report.hasStructuralDamage,
    id: report.id,
    inspectionDate: report.inspectionDate,
    inspectorName: report.inspectorName,
    inspectorOrg: report.inspectorOrg,
    interiorSummary: report.interiorSummary,
    items: report.items.map(toItemView),
    odometerKm: report.odometerKm,
    overallGrade: report.overallGrade,
    publishedAt: report.publishedAt,
    repairSuggestion: report.repairSuggestion,
    reportNo: report.reportNo,
    reportStatus: report.reportStatus,
    safetyConclusion: report.safetyConclusion,
    summary: report.summary,
    tireSummary: report.tireSummary,
    updatedAt: report.updatedAt,
    updatedBy: report.updatedBy,
    vehicleId: report.vehicleId
  };
}

function toItemView(item: ConditionReportItemRecord) {
  return {
    affectsSafety: item.affectsSafety,
    area: item.area,
    createdAt: item.createdAt,
    customerVisible: item.customerVisible,
    deletedAt: item.deletedAt,
    description: item.description,
    id: item.id,
    itemType: item.itemType,
    mediaIds: stringArray(item.mediaIds),
    partName: item.partName,
    repairRequired: item.repairRequired,
    reportId: item.reportId,
    result: item.result,
    severity: item.severity,
    sortOrder: item.sortOrder,
    title: item.title,
    updatedAt: item.updatedAt
  };
}

function assignIfDefined(target: Record<string, unknown>, key: string, value: unknown) {
  if (value !== undefined) {
    target[key] = value;
  }
}

function decimalOrNull(value: number | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  return value === null ? null : new Prisma.Decimal(value);
}

function decimalToNumber(value: Prisma.Decimal | null) {
  return value ? value.toNumber() : null;
}

function parseOptionalDateOnly(value: string | null | undefined, field: string) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value.trim() === "") {
    return null;
  }

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return date;
}

function stringArray(value: Prisma.JsonValue | null) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function generateReportNo() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `VCR-${today}-${randomUUID().slice(0, 8).toUpperCase()}`;
}
