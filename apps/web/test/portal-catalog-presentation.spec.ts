import { describe, expect, it } from "vitest";

import {
  buildPortalCatalogTags,
  buildPortalCatalogTitle,
  formatPortalCatalogMonth,
  formatPortalCatalogMonthlyFee
} from "../src/app/portal/catalog/portal-catalog-presentation";
import type { PortalCatalogVehicle } from "../src/lib/portal-types";

describe("portal catalog presentation", () => {
  it("uses the explicit short title before every other title", () => {
    expect(
      buildPortalCatalogTitle(
        vehicle({
          modelDefinition: {
            customerDisplayName: "NIO ES6 2024款",
            displayName: "NIO_ES6_2024",
            id: "model-1",
            modelCode: "NIO_ES6_2024"
          },
          shortTitle: "ES6 城市通勤版"
        })
      )
    ).toBe("ES6 城市通勤版");
  });

  it("uses the model-definition customer title before a repeated compatibility title", () => {
    expect(
      buildPortalCatalogTitle(
        vehicle({
          customerModelDisplayName: "NIO/蔚来 ES NIO ES6 2024款 2024款",
          modelDefinition: {
            customerDisplayName: "NIO ES6 2024款",
            displayName: "NIO_ES6_2024",
            id: "model-1",
            modelCode: "NIO_ES6_2024"
          },
          shortTitle: null
        })
      )
    ).toBe("NIO ES6 2024款");
  });

  it("does not use the exact internal model code as the fallback title", () => {
    expect(
      buildPortalCatalogTitle(
        vehicle({
          customerModelDisplayName: "NIO_ES6_2024",
          displayName: "NIO_ES6_2024",
          modelCode: "NIO_ES6_2024",
          modelDefinition: null,
          shortTitle: null
        })
      )
    ).toBe("NIO ES6 2024款");
  });

  it("falls back without repeating equal structured model tokens", () => {
    expect(
      buildPortalCatalogTitle(
        vehicle({
          brand: "NIO",
          customerModelDisplayName: "2024款 2024款",
          displayName: "NIO_ES6_2024",
          model: "ES6",
          modelDefinition: null,
          series: "ES6",
          shortTitle: null
        })
      )
    ).toBe("NIO ES6 2024款");
  });

  it("uses a stable title when every safe source is empty", () => {
    expect(
      buildPortalCatalogTitle(
        vehicle({
          brand: "",
          customerModelDisplayName: null,
          displayName: "",
          model: null,
          modelDefinition: null,
          modelYear: null,
          series: null,
          shortTitle: null
        })
      )
    ).toBe("待确认车型");
  });

  it.each([
    [1, "¥0.01 / 月起"],
    [100, "¥1 / 月起"],
    [12345, "¥123.45 / 月起"],
    [0, "¥0 / 月起"],
    [null, "月租审核后确认"],
    [undefined, "月租审核后确认"]
  ])("formats monthly fee %s without losing cents", (amount, expected) => {
    expect(formatPortalCatalogMonthlyFee(amount)).toBe(expected);
  });

  it("formats valid registration months and rejects invalid dates", () => {
    expect(formatPortalCatalogMonth("2024-08-17T00:00:00.000Z")).toBe("2024-08");
    expect(formatPortalCatalogMonth("not-a-date")).toBeNull();
    expect(formatPortalCatalogMonth(null)).toBeNull();
  });

  it("deduplicates tags and removes facts already displayed outside the tag region", () => {
    const tags = buildPortalCatalogTags(
      vehicle({
        batteryHealthPercent: 92,
        city: "上海市闵行区",
        conditionGrade: "A",
        customerTags: [
          "75 kWh",
          "75   kWh",
          "上海市闵行区",
          "2024款",
          "上牌 2024-08",
          "20,000 km"
        ],
        hasMajorAccident: false,
        registrationDate: "2024-08-17T00:00:00.000Z",
        tags: ["BaaS / 电池租用", "75 kWh"]
      })
    );

    expect(tags).toEqual([
      { label: "75 kWh" },
      { label: "BaaS / 电池租用" },
      { color: "blue", label: "车况 A" },
      { color: "green", label: "电池健康度 92%" },
      { color: "green", label: "未标记重大事故" },
      { label: "押金审核后确认" }
    ]);
  });

  it("treats zero battery health as a present value", () => {
    expect(
      buildPortalCatalogTags(vehicle({ batteryHealthPercent: 0 })).map((tag) => tag.label)
    ).toContain("电池健康度 0%");
  });
});

function vehicle(overrides: Partial<PortalCatalogVehicle> = {}): PortalCatalogVehicle {
  return {
    available: true,
    batteryCapacityKwh: 75,
    batteryUsageType: "BAAS",
    batteryUsageTypeLabel: "BaaS / 电池租用",
    brand: "NIO",
    city: "上海市闵行区",
    coverImageUrl: null,
    currentMileageKm: 20_000,
    customerModelDisplayName: "NIO_ES6_2024",
    displayName: "NIO_ES6_2024",
    gallery: [],
    id: "vehicle-1",
    model: "ES6",
    modelCode: "NIO_ES6_2024",
    modelDefinition: null,
    modelYear: 2024,
    series: "ES6",
    shortTitle: null,
    statusLabel: "可申请",
    tags: [],
    ...overrides
  };
}
