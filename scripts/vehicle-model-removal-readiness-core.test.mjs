import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildVehicleModelRemovalReadinessReport,
  scanExternalEnumUsage
} from "./vehicle-model-removal-readiness-core.mjs";

test("scanExternalEnumUsage classifies API, report, CSV, and integration references", () => {
  const result = scanExternalEnumUsage([
    {
      content: "export class OrderReportQueryDto { vehicleModel?: VehicleModel }",
      path: "apps/api/src/report/dto/report.dto.ts"
    },
    {
      content: 'rows.push(["legacy 车型", row.vehicleModel]); return csvExport("orders", range, rows);',
      path: "apps/api/src/report/report.service.ts"
    },
    {
      content: "export function buildPayload(order) { return { vehicleModel: order.vehicleModel }; }",
      path: "apps/api/src/external/example-integration.ts"
    }
  ]);

  assert.equal(result.totalReferences, 3);
  assert.deepEqual(
    result.items.map((item) => item.category).sort(),
    ["API_CONTRACT", "CSV_EXPORT", "EXTERNAL_INTEGRATION"]
  );
});

test("buildVehicleModelRemovalReadinessReport combines runtime and external evidence", () => {
  const report = buildVehicleModelRemovalReadinessReport({
    externalUsage: {
      items: [
        {
          category: "API_CONTRACT",
          path: "apps/api/src/report/dto/report.dto.ts",
          riskLevel: "MEDIUM"
        }
      ],
      totalReferences: 1
    },
    runtimeEvents: [
      {
        decisionPath: "LEGACY_ENUM",
        legacyVehicleModelCode: "ET5",
        module: "product",
        operation: "quote.priceRule.resolve",
        riskLevel: "HIGH",
        usageKind: "BUSINESS_DECISION"
      },
      {
        decisionPath: "LEGACY_ENUM",
        legacyVehicleModelCode: "ET5",
        module: "report",
        operation: "orders.filter",
        riskLevel: "MEDIUM",
        usageKind: "FALLBACK"
      }
    ]
  });

  assert.equal(report.enumUsageCount, 3);
  assert.equal(report.businessDecisionUsageCount, 1);
  assert.equal(report.fallbackUsageCount, 1);
  assert.equal(report.externalUsageCount, 1);
  assert.equal(report.decision, "NOT_READY");
  assert.equal(report.riskClassification, "HIGH");
});
