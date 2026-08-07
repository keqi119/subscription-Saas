import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PortalSourceDocumentImage } from "../src/components/portal/portal-source-document-image";

const repoRoot = join(__dirname, "..", "..", "..");

describe("portal vehicle source documents", () => {
  it("renders a controlled long image with no storage key", () => {
    const html = renderToStaticMarkup(
      <PortalSourceDocumentImage
        document={{
          previewUrl:
            "/api/portal/catalog/vehicles/v1/source-documents/CONFIGURATION_SHEET/preview",
          section: "CONFIGURATION_SHEET",
          title: "车辆配置单"
        }}
      />
    );

    expect(html).toContain("车辆配置单");
    expect(html).toContain("source-documents/CONFIGURATION_SHEET/preview");
    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain("storageKey");
  });

  it("refuses to render a PDF as an image", () => {
    const html = renderToStaticMarkup(
      <PortalSourceDocumentImage
        document={{
          previewUrl: "/api/portal/catalog/vehicles/v1/source-documents/CONDITION_REPORT/report.pdf",
          section: "CONDITION_REPORT",
          title: "车辆检测报告"
        }}
      />
    );

    expect(html).not.toContain("<img");
  });

  it("uses source-document, structured-report, and empty branches exclusively", () => {
    const source = readFileSync(
      join(repoRoot, "apps/web/src/app/portal/catalog/[id]/page.tsx"),
      "utf8"
    );

    expect(source).toContain("sourceDocuments.configurationSheet");
    expect(source).toContain('conditionDisplayMode === "SOURCE_DOCUMENT"');
    expect(source).toContain('conditionDisplayMode === "STRUCTURED_REPORT"');
    expect(source).toContain("PortalSourceDocumentImage");
    expect(source).toContain("暂无可展示的车况报告");
    expect(source).not.toContain("sourceDocuments.conditionReport.previewUrl");
  });
});
