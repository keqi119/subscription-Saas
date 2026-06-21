import {
  Prisma,
  VehicleConditionItemArea,
  VehicleConditionItemResult,
  VehicleConditionItemSeverity,
  VehicleConditionItemType,
  VehicleConditionReportStatus,
  VehicleListingConditionGrade
} from "@prisma/client";
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { VehicleConditionReportService } from "../src/vehicle/vehicle-condition-report.service";

describe("VehicleConditionReportService", () => {
  it("creates, updates, and adds an item with same-vehicle listing media", async () => {
    const { prisma, service, user } = createHarness();

    const created = await service.createReport(
      "vehicle-1",
      {
        inspectionDate: "2026-06-21",
        inspectorOrg: "内部检测",
        odometerKm: 12000,
        overallGrade: VehicleListingConditionGrade.B,
        summary: "车况良好"
      },
      user
    );

    expect(created).toMatchObject({
      inspectorOrg: "内部检测",
      overallGrade: VehicleListingConditionGrade.B,
      reportStatus: VehicleConditionReportStatus.DRAFT
    });
    expect(prisma.vehicleConditionReport.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          createdBy: user.id,
          reportNo: expect.stringMatching(/^VCR-\d{8}-/),
          vehicleId: "vehicle-1"
        })
      })
    );

    const updated = await service.updateReport(
      "report-1",
      {
        batteryCycleCount: 320,
        batteryHealthPercent: 91,
        customerSummary: "客户可见摘要"
      },
      user
    );

    expect(updated).toMatchObject({
      batteryCycleCount: 320,
      batteryHealthPercent: 91,
      customerSummary: "客户可见摘要"
    });

    const item = await service.createItem("report-1", {
      area: VehicleConditionItemArea.EXTERIOR,
      itemType: VehicleConditionItemType.DEFECT,
      mediaIds: ["media-1"],
      partName: "右前门",
      result: VehicleConditionItemResult.ATTENTION,
      severity: VehicleConditionItemSeverity.MINOR,
      title: "轻微划痕"
    });

    expect(item).toMatchObject({
      mediaIds: ["media-1"],
      partName: "右前门",
      title: "轻微划痕"
    });
    expect(prisma.vehicleListingMedia.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerVisible: true,
          id: { in: ["media-1"] },
          vehicleId: "vehicle-1"
        })
      })
    );
  });

  it("rejects item media from other vehicles or hidden media", async () => {
    const { prisma, service } = createHarness();
    prisma.vehicleListingMedia.findMany.mockResolvedValueOnce([]);

    await expect(
      service.createItem("report-1", {
        area: VehicleConditionItemArea.EXTERIOR,
        itemType: VehicleConditionItemType.DEFECT,
        mediaIds: ["media-from-other-vehicle"]
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("publishes latest report, archives old published reports, and can archive current report", async () => {
    const { service, tx, user } = createHarness();

    const published = await service.publishReport("report-1", user);

    expect(tx.vehicleConditionReport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customerVisible: false,
          reportStatus: VehicleConditionReportStatus.ARCHIVED
        }),
        where: expect.objectContaining({
          id: { not: "report-1" },
          reportStatus: VehicleConditionReportStatus.PUBLISHED,
          vehicleId: "vehicle-1"
        })
      })
    );
    expect(tx.vehicleConditionReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customerVisible: true,
          reportStatus: VehicleConditionReportStatus.PUBLISHED
        }),
        where: { id: "report-1" }
      })
    );
    expect(published.reportStatus).toBe(VehicleConditionReportStatus.PUBLISHED);

    const archived = await service.archiveReport("report-1", user);
    expect(archived).toMatchObject({
      customerVisible: false,
      reportStatus: VehicleConditionReportStatus.ARCHIVED
    });
  });
});

function createHarness() {
  const vehicle = { deletedAt: null, id: "vehicle-1" };
  let report = createReport();
  const item = createItem();
  const tx = {
    vehicleConditionReport: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        report = { ...report, ...data };
        return report;
      }),
      updateMany: vi.fn(async () => ({ count: 1 }))
    }
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    vehicle: {
      findFirst: vi.fn(async () => vehicle)
    },
    vehicleConditionReport: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        report = { ...report, ...data };
        return report;
      }),
      findFirst: vi.fn(async () => report),
      findMany: vi.fn(async () => [report]),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        report = { ...report, ...data };
        return report;
      })
    },
    vehicleConditionReportItem: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...item, ...data })),
      findFirst: vi.fn(async () => ({
        ...item,
        report: {
          deletedAt: null,
          id: report.id,
          vehicleId: report.vehicleId
        }
      })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...item, ...data }))
    },
    vehicleListingMedia: {
      findMany: vi.fn(async () => [{ id: "media-1" }])
    }
  };
  const service = new VehicleConditionReportService(prisma as never);
  const user = {
    id: "user-1",
    menus: [],
    name: "Admin",
    permissions: ["vehicle:manage"],
    roles: [],
    username: "admin"
  };

  return { prisma, service, tx, user };
}

function createReport() {
  const now = new Date("2026-06-21T10:00:00.000Z");
  return {
    archivedAt: null,
    batteryCheckedAt: null,
    batteryCycleCount: null,
    batteryEstimatedRangeKm: null,
    batteryHealthPercent: null as Prisma.Decimal | null,
    batteryRemark: null,
    batteryWarrantyUntil: null,
    brakeSummary: null,
    chassisSummary: null,
    createdAt: now,
    createdBy: "user-1",
    customerSummary: null,
    customerVisible: false,
    deletedAt: null,
    exteriorSummary: null,
    glassLightSummary: null,
    hasFireDamage: false,
    hasFloodDamage: false,
    hasMajorAccident: false,
    hasStructuralDamage: false,
    id: "report-1",
    inspectionDate: new Date("2026-06-21T00:00:00.000Z"),
    inspectorName: null,
    inspectorOrg: null,
    interiorSummary: null,
    items: [],
    odometerKm: 12000,
    overallGrade: VehicleListingConditionGrade.B,
    publishedAt: null,
    repairSuggestion: null,
    reportNo: "VCR-20260621-0001",
    reportStatus: VehicleConditionReportStatus.DRAFT,
    safetyConclusion: null,
    summary: "车况良好",
    tireSummary: null,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleId: "vehicle-1"
  };
}

function createItem() {
  const now = new Date("2026-06-21T10:00:00.000Z");
  return {
    affectsSafety: false,
    area: VehicleConditionItemArea.EXTERIOR,
    createdAt: now,
    customerVisible: true,
    deletedAt: null,
    description: null,
    id: "item-1",
    itemType: VehicleConditionItemType.DEFECT,
    mediaIds: ["media-1"],
    partName: "右前门",
    repairRequired: false,
    reportId: "report-1",
    result: VehicleConditionItemResult.ATTENTION,
    severity: VehicleConditionItemSeverity.MINOR,
    sortOrder: 0,
    title: "轻微划痕",
    updatedAt: now
  };
}
