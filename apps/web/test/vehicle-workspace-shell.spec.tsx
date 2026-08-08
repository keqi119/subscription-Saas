import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { VehicleOverviewTab } from "../src/components/vehicle-workspace/vehicle-overview-tab";
import { VehicleWorkspace } from "../src/components/vehicle-workspace/vehicle-workspace";
import type {
  VehicleWorkspaceTabProps,
  VehicleWorkspaceVehicle
} from "../src/components/vehicle-workspace/vehicle-workspace-types";

const vehicleFixture: VehicleWorkspaceVehicle = {
  acquisitionMode: "OWNED_CASH",
  assetLocation: "上海",
  batteryCapacityKwh: 75,
  batteryUsageType: "BUYOUT",
  brand: "NIO",
  currentMileageKm: 12880,
  currentSalePriceAmount: 26800000,
  id: "vehicle-1",
  insuranceCoverage: {
    commercial: { covered: true, effectiveFrom: "2026-03-01", effectiveTo: "2027-02-28" },
    compulsoryTraffic: { covered: true, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" },
    covered: true,
    evaluatedAt: "2026-08-08T00:00:00.000Z"
  },
  latestRegistrationDate: "2025-01-12",
  model: "ES6",
  modelDisplayName: "乐道 ES6",
  modelYear: 2025,
  nextSalePriceReviewAt: "2026-10-01",
  plateNo: "沪A12345",
  purchaseDate: "2025-01-05",
  registrationDate: "2025-01-10",
  salePriceStatus: "EFFECTIVE",
  series: "ES6",
  status: "AVAILABLE",
  updatedAt: "2026-08-08T00:00:00.000Z",
  vehicleNo: "VEH20260731152647G5GV",
  vin: "VIN1234567890"
};

const tabProps: VehicleWorkspaceTabProps = {
  onVehicleChanged: async () => undefined,
  permissions: new Set(["vehicle:view", "vehicle_document:view"]),
  vehicle: vehicleFixture
};

describe("vehicle workspace shell", () => {
  it("renders the vehicle identity and only visible primary tabs", () => {
    const html = renderToStaticMarkup(
      <VehicleWorkspace
        actions={<button type="button">编辑车辆</button>}
        activeTab="overview"
        onTabChange={() => undefined}
        vehicle={vehicleFixture}
        visibleTabs={["overview", "documents"]}
      >
        <VehicleOverviewTab {...tabProps} />
      </VehicleWorkspace>
    );

    expect(html).toContain("VEH20260731152647G5GV");
    expect(html).toContain("车辆概览");
    expect(html).toContain("权证资料");
    expect(html).not.toContain("资本与分润");
    expect(html).toContain("编辑车辆");
    expect(html).toContain("返回车辆列表");
    expect(html).toContain("沪A12345");
    expect(html).toContain("VIN1234567890");
    expect(html).toContain("¥268,000.00");
  });

  it("renders lightweight overview facts, events, links, and permitted shortcuts", () => {
    const html = renderToStaticMarkup(<VehicleOverviewTab {...tabProps} />);

    expect(html).toContain("核心状态");
    expect(html).toContain("AVAILABLE");
    expect(html).toContain("12,880 公里");
    expect(html).toContain("保险覆盖正常");
    expect(html).toContain("2026-10-01");
    expect(html).toContain("身份与登记");
    expect(html).toContain("2025-01-10");
    expect(html).toContain("电池基础");
    expect(html).toContain("75 kWh");
    expect(html).toContain("订单/租赁");
    expect(html).toContain("商品展示");
    expect(html).toContain("最近状态/里程事件");
    expect(html).toContain("快捷入口");
    expect(html).toContain("/orders?vehicleId=vehicle-1");
    expect(html).toContain("/vehicles/vehicle-1?tab=documents");
    expect(html).toContain("/vehicles/vehicle-1?tab=listing");
  });

  it.each([
    "上传权证",
    "新增保单",
    "绑定商品原件",
    "发起估值",
    "分润试算"
  ])("keeps heavy domain action %s out of the overview", (forbiddenText) => {
    const html = renderToStaticMarkup(<VehicleOverviewTab {...tabProps} />);
    expect(html).not.toContain(forbiddenText);
  });

  it("keeps the shell presentation-only without requiring refresh callbacks", () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(
          VehicleWorkspace,
          {
            activeTab: "documents",
            onTabChange: () => undefined,
            vehicle: vehicleFixture,
            visibleTabs: ["documents"]
          },
          createElement("div", null, "documents content")
        )
      )
    ).not.toThrow();
  });
});
