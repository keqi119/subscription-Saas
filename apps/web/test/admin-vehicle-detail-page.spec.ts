import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const routePath = join(repoRoot, "apps/web/src/app/vehicles/[id]/page.tsx");
const contentPath = join(
  repoRoot,
  "apps/web/src/components/vehicle-workspace/vehicle-workspace-content.tsx"
);
const actionsPath = join(
  repoRoot,
  "apps/web/src/components/vehicle-workspace/vehicle-detail-actions.tsx"
);

describe("admin vehicle detail page composition", () => {
  it("loads one vehicle and canonicalizes URL-owned workspace navigation", () => {
    const source = readFileSync(routePath, "utf8");

    expect(source).toContain("useParams");
    expect(source).toContain("useSearchParams");
    expect(source).toContain("parseVehicleWorkspaceLocation");
    expect(source).toContain("buildVehicleWorkspaceHref");
    expect(source).toContain("router.replace");
    expect(source).toContain("`/vehicles/${encodeURIComponent(vehicleId)}`");
    expect(source).not.toContain('apiFetch<VehicleDetailRecord[]>("/vehicles")');
    expect(source).not.toContain("vehicles/sale-price-reviews/due");
  });

  it("renders explicit loading, permission, and missing-vehicle states", () => {
    const source = readFileSync(routePath, "utf8");

    expect(source).toContain("正在加载车辆详情");
    expect(source).toContain("403：无权查看车辆详情");
    expect(source).toContain("车辆不存在或已删除");
    expect(source).toContain("VehicleDetailActions");
    expect(source).toContain("VehicleWorkspaceContent");
  });

  it("lazily mounts all six permitted tabs and retains visited tab caches", () => {
    const source = readFileSync(contentPath, "utf8");

    expect(source).toContain("VehicleOverviewTab");
    expect(source).toContain("VehicleDocumentsTab");
    expect(source).toContain("VehicleInsuranceBatteryTab");
    expect(source).toContain("VehicleListingTab");
    expect(source).toContain("VehicleValuationTab");
    expect(source).toContain("VehicleCapitalTab");
    expect(source).toContain("visitedTabs");
    expect(source).toContain("VehicleTabErrorBoundary");
    expect(source).toContain("hidden={tab !== activeTab}");
  });

  it("keeps single-vehicle mutations in the shared action component", () => {
    const source = readFileSync(actionsPath, "utf8");

    expect(source).toContain('method: "PATCH"');
    expect(source).toContain("/initialize-sale-price");
    expect(source).toContain("/review-sale-price");
    expect(source).toContain("/update-status");
    expect(source).toContain('permission="vehicle:update"');
    expect(source).toContain("canInitializeVehicleSalePrice");
    expect(source).toContain("canReviewVehicleSalePrice");
    expect(source).toContain("canUpdateVehicleStatus");
  });
});
