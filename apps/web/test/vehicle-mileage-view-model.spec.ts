import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildVehicleMileageTimelineItem,
  getDeliveryConfirmationAdjustmentState,
  getDeliveryConfirmationSourceHints,
  getVehicleMileageSourcePresentation,
  getVehicleMileageStatusPresentation
} from "../src/lib/vehicle-mileage-view-model";

const repoRoot = join(__dirname, "..", "..", "..");
const vehiclesPagePath = join(repoRoot, "apps/web/src/app/vehicles/page.tsx");
const vehicleDetailActionsPath = join(
  repoRoot,
  "apps/web/src/components/vehicle-workspace/vehicle-detail-actions.tsx"
);
const vehicleOverviewPath = join(
  repoRoot,
  "apps/web/src/components/vehicle-workspace/vehicle-overview-tab.tsx"
);

const confirmationDefaults = {
  deliveredAt: "2026-08-02T11:03:15.000Z",
  deliveredAtSource: "STAGE2_COMPLETED_AT" as const,
  fieldWorkOrderId: "work-order-1",
  handoverMileageKm: 28000,
  handoverMileageSource: "FIELD_WORK_ORDER" as const,
  stage2HandoverId: "handover-1"
};

describe("delivery confirmation mileage view model", () => {
  it("renders the authoritative Stage 2 and Field source hints", () => {
    expect(getDeliveryConfirmationSourceHints(confirmationDefaults)).toEqual({
      deliveredAt: "来源：Stage 2 双方签署完成时间",
      handoverMileageKm: "来源：Field 现场交接里程"
    });
  });

  it("marks only values changed from the authoritative defaults", () => {
    expect(
      getDeliveryConfirmationAdjustmentState(
        {
          deliveredAt: "2026-08-02T19:03:15+08:00",
          handoverMileageKm: 28000
        },
        confirmationDefaults
      )
    ).toEqual({ deliveredAt: false, handoverMileageKm: false });

    expect(
      getDeliveryConfirmationAdjustmentState(
        {
          deliveredAt: "2026-08-02T19:13:15+08:00",
          handoverMileageKm: 28000
        },
        confirmationDefaults
      )
    ).toEqual({ deliveredAt: true, handoverMileageKm: false });

    expect(
      getDeliveryConfirmationAdjustmentState(
        {
          deliveredAt: confirmationDefaults.deliveredAt,
          handoverMileageKm: 28010
        },
        confirmationDefaults
      )
    ).toEqual({ deliveredAt: false, handoverMileageKm: true });
  });
});

describe("vehicle mileage history view model", () => {
  it.each([
    ["VEHICLE_INITIALIZATION", "车辆初始化"],
    ["LEGACY_MIGRATION", "历史数据迁移"],
    ["DELIVERY_BASELINE", "交付基线"],
    ["MONTHLY_REVIEW", "月度里程复核"],
    ["RETURN_CONFIRMATION", "退车确认"],
    ["MANUAL_CORRECTION", "人工更正"]
  ])("maps %s to %s", (sourceType, label) => {
    expect(getVehicleMileageSourcePresentation(sourceType)).toEqual(
      expect.objectContaining({ label })
    );
  });

  it.each([
    ["ACTIVE", { color: "green", label: "有效" }],
    ["VOIDED", { color: "default", label: "已作废" }]
  ])("maps %s status", (status, expected) => {
    expect(getVehicleMileageStatusPresentation(status)).toEqual(expected);
  });

  it("builds a complete immutable reading timeline item", () => {
    expect(
      buildVehicleMileageTimelineItem({
        deltaKm: 750,
        id: "reading-2",
        mileageKm: 28750,
        order: { id: "order-1", orderNo: "ORD20260802071556GFEY" },
        recordedAt: "2026-09-02T11:03:15.000Z",
        sourceRecordId: "review-1",
        sourceType: "MONTHLY_REVIEW",
        status: "ACTIVE"
      })
    ).toEqual({
      color: "blue",
      deltaText: "+750 km",
      mileageText: "28,750 km",
      orderText: "ORD20260802071556GFEY",
      recordedAt: "2026-09-02T11:03:15.000Z",
      sourceLabel: "月度里程复核",
      sourceRecordId: "review-1",
      statusColor: "green",
      statusLabel: "有效"
    });
  });

  it("keeps creation mileage editable but removes it from existing vehicle edits", () => {
    const vehiclesPageSource = readFileSync(vehiclesPagePath, "utf8");
    const detailActionsSource = readFileSync(vehicleDetailActionsPath, "utf8");
    const overviewSource = readFileSync(vehicleOverviewPath, "utf8");
    const createFlow = functionDeclarationSource(vehiclesPageSource, "saveCreateVehicle");
    const editFlow = functionDeclarationSource(detailActionsSource, "saveEdit");

    expect(vehiclesPageSource).toContain('name="currentMileageKm"');
    expect(createFlow).toContain("currentMileageKm:");
    expect(editFlow).not.toContain("currentMileageKm:");
    expect(detailActionsSource).not.toContain('name="currentMileageKm"');
    expect(detailActionsSource).toContain("当前里程只能通过里程流程单据更新");
    expect(overviewSource).toContain('label="当前里程"');
    expect(overviewSource).toContain("最近状态/里程事件");
  });
});

function functionDeclarationSource(source: string, name: string) {
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const openBrace = source.indexOf("{", start);
  expect(openBrace).toBeGreaterThan(start);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to find function body: ${name}`);
}
