import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildVehicleModelRemovalReadinessReport,
  scanExternalEnumUsage,
  validateExternalConsumerRegistry
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

test("scanExternalEnumUsage ignores internal telemetry implementation references", () => {
  const result = scanExternalEnumUsage([
    {
      content:
        'export type VehicleModelExternalContractWarningInput = { surface: "CSV_EXPORT"; field: "vehicleModel" }',
      path: "apps/api/src/common/vehicle-model-usage-tracker.ts"
    }
  ]);

  assert.equal(result.totalReferences, 0);
  assert.deepEqual(result.items, []);
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

test("buildVehicleModelRemovalReadinessReport treats deprecation warnings as external usage", () => {
  const report = buildVehicleModelRemovalReadinessReport({
    externalUsage: {
      items: [],
      totalReferences: 0
    },
    runtimeEvents: [
      {
        decisionPath: "LEGACY_ENUM",
        legacyVehicleModelCode: "ET5",
        metadata: {
          consumerId: "report-api-vehicle-model-filter",
          field: "vehicleModel",
          replacement: "modelDefinitionId",
          surface: "REPORT_FILTER"
        },
        module: "report",
        operation: "DEPRECATED_VEHICLE_MODEL_FILTER",
        riskLevel: "MEDIUM",
        usageKind: "EXTERNAL_CONTRACT_DEPRECATION_WARNING"
      }
    ]
  });

  assert.equal(report.businessDecisionUsageCount, 0);
  assert.equal(report.enumUsageCount, 1);
  assert.equal(report.externalUsageCount, 1);
  assert.equal(report.decision, "NOT_READY");
  assert.equal(report.riskClassification, "MEDIUM");
});

test("validateExternalConsumerRegistry requires every external reference to be registered", () => {
  const result = validateExternalConsumerRegistry({
    consumers: [
      {
        consumerId: "report-api-vehicle-model-filter",
        evidencePath: "apps/api/src/report/dto/report.dto.ts",
        migrationStatus: "Owner assigned",
        owner: "Finance owner",
        replacement: "modelDefinitionId",
        risk: "Medium",
        surface: "API"
      }
    ],
    externalUsage: {
      items: [
        {
          category: "API_CONTRACT",
          path: "apps/api/src/report/dto/report.dto.ts",
          riskLevel: "MEDIUM"
        },
        {
          category: "CSV_EXPORT",
          path: "apps/api/src/report/report.service.ts",
          riskLevel: "LOW"
        }
      ],
      totalReferences: 2
    }
  });

  assert.equal(result.totalExternalReferences, 2);
  assert.equal(result.registeredReferences, 1);
  assert.equal(result.warningModeReady, false);
  assert.deepEqual(result.missingReferences.map((item) => item.path), ["apps/api/src/report/report.service.ts"]);
});

test("validateExternalConsumerRegistry blocks medium and high risk consumers without migration ownership", () => {
  const result = validateExternalConsumerRegistry({
    consumers: [
      {
        consumerId: "product-api-vehicle-model-contract",
        evidencePath: "apps/api/src/product/dto/product.dto.ts",
        migrationStatus: "Discovered",
        owner: "",
        replacement: "modelDefinitionId",
        risk: "Medium",
        surface: "API"
      }
    ],
    externalUsage: {
      items: [
        {
          category: "API_CONTRACT",
          path: "apps/api/src/product/dto/product.dto.ts",
          riskLevel: "MEDIUM"
        }
      ],
      totalReferences: 1
    }
  });

  assert.equal(result.warningModeReady, false);
  assert.deepEqual(result.blockingConsumers.map((consumer) => consumer.consumerId), [
    "product-api-vehicle-model-contract"
  ]);
});
