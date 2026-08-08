import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  isCatalogImageFailed,
  PortalCatalogCard
} from "../src/app/portal/catalog/portal-catalog-card";
import type { PortalCatalogVehicle } from "../src/lib/portal-types";

describe("PortalCatalogCard", () => {
  it("renders customer-readable facts and a cent-accurate price in stable regions", () => {
    const html = renderToStaticMarkup(
      <PortalCatalogCard onDetails={vi.fn()} vehicle={vehicle()} />
    );

    expect(html).toContain('data-testid="portal-catalog-card"');
    expect(html).toContain('data-testid="portal-catalog-title"');
    expect(html).toContain('data-testid="portal-catalog-location"');
    expect(html).toContain('data-testid="portal-catalog-price"');
    expect(html).toContain("NIO ES6 2024款");
    expect(html).not.toContain("NIO_ES6_2024");
    expect(html).toContain("上牌 2024-08");
    expect(html).toContain("20,000 km");
    expect(html).toContain("上海市闵行区北翟路1554弄53号宁达汽车广场");
    expect(html).toContain("¥0.01 / 月起");
    expect(html).toContain("查看详情");
    expect(html).toContain("75 kWh");
  });

  it("uses the customer title as image alternative text for a relative asset URL", () => {
    const html = renderToStaticMarkup(
      <PortalCatalogCard onDetails={vi.fn()} vehicle={vehicle()} />
    );

    expect(html).toContain('alt="NIO ES6 2024款"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('src="http://localhost:3001/uploads/vehicle-1.jpg"');
  });

  it("keeps an equal-purpose placeholder when the vehicle has no image", () => {
    const html = renderToStaticMarkup(
      <PortalCatalogCard
        onDetails={vi.fn()}
        vehicle={vehicle({ coverImageUrl: null })}
      />
    );

    expect(html).not.toContain("<img");
    expect(html).toContain('data-testid="portal-catalog-image-placeholder"');
    expect(html).toContain("暂无车辆图片");
  });

  it("shows the review copy when the monthly fee is missing", () => {
    const html = renderToStaticMarkup(
      <PortalCatalogCard
        onDetails={vi.fn()}
        vehicle={vehicle({ monthlyFeeFromAmount: null })}
      />
    );

    expect(html).toContain("月租审核后确认");
  });

  it("detects an image that failed before hydration attached its error listener", () => {
    expect(isCatalogImageFailed({ complete: true, naturalWidth: 0 })).toBe(true);
    expect(isCatalogImageFailed({ complete: true, naturalWidth: 128 })).toBe(false);
    expect(isCatalogImageFailed({ complete: false, naturalWidth: 0 })).toBe(false);
  });
});

function vehicle(overrides: Partial<PortalCatalogVehicle> = {}): PortalCatalogVehicle {
  return {
    available: true,
    batteryCapacityKwh: 75,
    batteryUsageType: "BAAS",
    batteryUsageTypeLabel: "BaaS / 电池租用",
    brand: "NIO",
    city: "上海市闵行区北翟路1554弄53号宁达汽车广场",
    coverImageUrl: "/uploads/vehicle-1.jpg",
    currentMileageKm: 20_000,
    customerModelDisplayName: "NIO/蔚来 ES NIO ES6 2024款 2024款",
    customerTags: ["75 kWh"],
    displayName: "NIO_ES6_2024",
    gallery: [],
    hasMajorAccident: false,
    id: "vehicle-1",
    model: "ES6",
    modelCode: "NIO_ES6_2024",
    modelDefinition: {
      customerDisplayName: "NIO ES6 2024款",
      displayName: "NIO_ES6_2024",
      id: "model-1",
      modelCode: "NIO_ES6_2024"
    },
    modelYear: 2024,
    monthlyFeeFromAmount: 1,
    registrationDate: "2024-08-17T00:00:00.000Z",
    series: "ES6",
    shortTitle: null,
    statusLabel: "可申请",
    tags: [],
    ...overrides
  };
}
