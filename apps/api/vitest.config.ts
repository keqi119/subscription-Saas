import { defineConfig } from "vitest/config";

const databaseTestFiles = [
  "test/billing-automation.integration.spec.ts",
  "test/sms.integration.spec.ts",
  "test/stage2-handover-pdf.integration.spec.ts",
  "test/stage2-handover-provider-reconciliation.integration.spec.ts",
  "test/stage2-handover-workflow.repository.spec.ts"
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
