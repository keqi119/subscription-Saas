import { defineConfig } from "vitest/config";

const databaseTestFiles = [
  "test/asset-facts.repository.integration.spec.ts",
  "test/auto-debit-settlement.integration.spec.ts",
  "test/billing-automation.integration.spec.ts",
  "test/contract-segment.integration.spec.ts",
  "test/mileage-review-e2e.spec.ts",
  "test/sms.integration.spec.ts",
  "test/stage2-handover-pdf.integration.spec.ts",
  "test/stage2-handover-provider-reconciliation.integration.spec.ts",
  "test/stage2-handover-workflow.repository.spec.ts",
  "test/subscription-expiry-return.integration.spec.ts",
  "test/subscription-change-migration.integration.spec.ts",
  "test/subscription-journey-failure-recovery.e2e-spec.ts",
  "test/subscription-journey-golden-path.e2e-spec.ts",
  "test/subscription-journey-integrity.integration.spec.ts",
  "test/subscription-journey.repository.integration.spec.ts",
  "test/subscription-extension.integration.spec.ts"
];

export default defineConfig({
  test: {
    environment: "node",
    projects: [
      {
        test: {
          environment: "node",
          exclude: databaseTestFiles,
          include: ["test/**/*.spec.ts"],
          name: "unit",
          sequence: {
            groupOrder: 0
          }
        }
      },
      {
        test: {
          environment: "node",
          fileParallelism: false,
          include: databaseTestFiles,
          name: "database",
          sequence: {
            groupOrder: 1
          }
        }
      }
    ]
  }
});
