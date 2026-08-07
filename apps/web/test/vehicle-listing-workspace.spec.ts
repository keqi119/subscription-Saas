import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  VEHICLE_LISTING_SECTIONS,
  getEligibleSourceDocuments,
  getPortalConditionPresentation,
  getSourceBindingPresentation,
  getVehicleListingReadiness,
  type VehicleListingSourceBindingView,
  type VehicleListingSourceDocumentView,
  type VehicleListingWorkspaceInput
} from "../src/lib/vehicle-listing-workspace";

const validListingWithoutSources: VehicleListingWorkspaceInput = {
  bindings: [],
  media: [{ customerVisible: true, isCover: true }],
  plans: [{ visible: true }],
  profile: { displayName: "蔚来 ES6 长租", listingStatus: "DRAFT", portalVisible: false }
};
const repoRoot = join(__dirname, "..", "..", "..");

describe("vehicle listing workspace model", () => {
  it("defines the approved five secondary sections", () => {
    expect(VEHICLE_LISTING_SECTIONS.map(({ key }) => key)).toEqual([
      "overview",
      "copy",
      "source-media",
      "plans",
      "condition-report"
    ]);
  });

  it("warns but does not reject publication when optional source images are absent", () => {
    const readiness = getVehicleListingReadiness(validListingWithoutSources);

    expect(readiness.listingComplete).toBe(true);
    expect(readiness.warnings).toContain("未引用车辆配置单原件");
    expect(readiness.warnings).toContain("未引用车辆检测报告原件");
  });

  it("keeps required listing gaps blocking", () => {
    const readiness = getVehicleListingReadiness({
      ...validListingWithoutSources,
      media: [],
      profile: { displayName: "", listingStatus: "DRAFT", portalVisible: false }
    });

    expect(readiness.listingComplete).toBe(false);
    expect(readiness.missingRequirements).toEqual(
      expect.arrayContaining(["缺少商品展示标题", "缺少客户可见封面图"])
    );
  });

  it("presents an exact bound document version without automatic updates", () => {
    expect(getSourceBindingPresentation(bindingFixture({ versionNo: 2 }))).toMatchObject({
      autoUpdates: false,
      fileName: "source-v2.jpg",
      versionLabel: "V2"
    });
  });

  it("filters candidates by section type, active state, and supported image MIME", () => {
    const candidates: VehicleListingSourceDocumentView[] = [
      documentFixture(),
      documentFixture({ id: "pdf", mimeType: "application/pdf" }),
      documentFixture({ documentStatus: "ARCHIVED", id: "archived" }),
      documentFixture({ documentType: "VEHICLE_INSPECTION_REPORT", id: "wrong-section" }),
      documentFixture({ id: "webp", mimeType: "image/webp" })
    ];

    expect(getEligibleSourceDocuments("CONFIGURATION_SHEET", candidates).map(({ id }) => id)).toEqual([
      "document-1",
      "webp"
    ]);
  });

  it("uses the exact source image ahead of a structured condition report", () => {
    expect(
      getPortalConditionPresentation({
        binding: bindingFixture({ section: "CONDITION_REPORT" }),
        latestPublishedReport: { id: "report-1" }
      })
    ).toEqual("SOURCE_DOCUMENT");
  });

  it("falls back to one structured condition report when no source is bound", () => {
    expect(
      getPortalConditionPresentation({ binding: null, latestPublishedReport: { id: "report-1" } })
    ).toEqual("STRUCTURED_REPORT");
    expect(getPortalConditionPresentation({ binding: null, latestPublishedReport: null })).toEqual("NONE");
  });

  it("binds exact source versions through controlled preview and confirmation", () => {
    const source = readFileSync(
      join(repoRoot, "apps/web/src/components/vehicle-workspace/vehicle-listing-tab.tsx"),
      "utf8"
    );

    expect(source).toContain("/listing-source-bindings/");
    expect(source).toContain('method: "PUT"');
    expect(source).toContain('method: "DELETE"');
    expect(source).toContain("上传新版本不会自动切换当前商品引用");
    expect(source).toContain("Modal.confirm");
    expect(source).toContain("buildAdminAssetUrl(candidate.previewUrl)");
    expect(source).toContain("SOURCE_DOCUMENT");
    expect(source).toContain("STRUCTURED_REPORT");
    expect(source).toContain("NONE");
  });
});

function bindingFixture(
  patch: Partial<VehicleListingSourceBindingView["document"]> &
    Partial<Pick<VehicleListingSourceBindingView, "section">> = {}
): VehicleListingSourceBindingView {
  return {
    document: {
      documentType: "VEHICLE_CONFIGURATION_SHEET",
      fileName: "source-v2.jpg",
      id: "document-1",
      mimeType: "image/jpeg",
      previewUrl: "/api/vehicle-documents/document-1/preview",
      versionNo: 1,
      ...patch
    },
    id: "binding-1",
    section: patch.section ?? "CONFIGURATION_SHEET",
    vehicleId: "vehicle-1"
  };
}

function documentFixture(
  patch: Partial<VehicleListingSourceDocumentView> = {}
): VehicleListingSourceDocumentView {
  return {
    createdAt: "2026-08-08T00:00:00.000Z",
    deletedAt: null,
    documentStatus: "ACTIVE",
    documentType: "VEHICLE_CONFIGURATION_SHEET",
    fileName: "source-v1.jpg",
    id: "document-1",
    mimeType: "image/jpeg",
    previewUrl: "/api/vehicle-documents/document-1/preview",
    versionNo: 1,
    ...patch
  };
}
