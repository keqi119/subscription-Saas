import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const sourcePath = join(
  repoRoot,
  "apps/web/src/components/vehicle-workspace/vehicle-insurance-battery-tab.tsx"
);

describe("vehicle insurance and battery workspace contract", () => {
  it("recomposes insurance, battery condition, and conditional BaaS data", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("/vehicle-insurance-policies?vehicleId=");
    expect(source).toContain("/insurance-policies");
    expect(source).toContain("/documents");
    expect(source).toContain("/condition-reports");
    expect(source).toContain("/baas-summary");
    expect(source).toContain("交强险");
    expect(source).toContain("商业险");
    expect(source).toContain('batteryUsageType === "BAAS"');
    expect(source).toContain("不需要 BaaS 服务");
    expect(source).toContain('reportStatus === "PUBLISHED"');
  });

  it("keeps all eight rights-document types outside this tab", () => {
    const source = readFileSync(sourcePath, "utf8");
    const rightsDocumentTypes = [
      "VEHICLE_REGISTRATION_CERTIFICATE",
      "VEHICLE_LICENSE",
      "VEHICLE_INSPECTION_REPORT",
      "VEHICLE_PURCHASE_AGREEMENT",
      "MOTOR_VEHICLE_INVOICE",
      "OWNER_IDENTITY_DOCUMENT",
      "VEHICLE_CONFIGURATION_SHEET",
      "PURCHASE_PAYMENT_VOUCHER"
    ];

    for (const documentType of rightsDocumentTypes) {
      expect(source).not.toContain(documentType);
    }
  });
});
