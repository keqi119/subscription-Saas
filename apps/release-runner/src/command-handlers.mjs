import { dbMigrateDeployHandler } from "./commands/db-migrate-deploy.mjs";
import { dbSchemaVerifyHandler } from "./commands/db-schema-verify.mjs";
import { stage1AcceptanceTargetVerifyHandler } from "./commands/stage1-acceptance-target-verify.mjs";
import { stage1ActiveSourceFactsRepairHandler } from "./commands/stage1-active-source-facts-repair.mjs";
import { stage1BillingMaintenanceEvidenceHandler } from "./commands/stage1-billing-maintenance-evidence.mjs";
import { stage1CleanAcceptanceBaselineHandler } from "./commands/stage1-clean-acceptance-baseline.mjs";
import { stage1PeriodBackfillHandler } from "./commands/stage1-period-backfill.mjs";
import { stage1ReturnClosureBackfillHandler } from "./commands/stage1-return-closure-backfill.mjs";
import { stage1Task9PreflightHandler } from "./commands/stage1-task9-preflight.mjs";
import { subscriptionSegmentBootstrapHandler } from "./commands/subscription-segment-bootstrap.mjs";

export const commandHandlers = new Map([
  ["release.verify@1", async ({ baseline }) => ({ baseline, terminalStatus: "PASSED" })],
  ["schema.migrate@1", async ({ baseline }) => ({ baseline, terminalStatus: "PASSED" })],
  ["repair.execute@1", async ({ baseline }) => ({ baseline, terminalStatus: "PASSED" })],
  ["evidence.export@1", async ({ baseline }) => ({ baseline, terminalStatus: "PASSED" })],
  ["db.migrate.deploy@1", dbMigrateDeployHandler],
  ["db.schema.verify@1", dbSchemaVerifyHandler],
  ["stage1.acceptance.target.verify@1", stage1AcceptanceTargetVerifyHandler],
  ["stage1.active-source-facts.repair@1", stage1ActiveSourceFactsRepairHandler],
  ["stage1.billing-maintenance.evidence@1", stage1BillingMaintenanceEvidenceHandler],
  ["stage1.clean-acceptance.baseline@1", stage1CleanAcceptanceBaselineHandler],
  ["stage1.period.backfill@1", stage1PeriodBackfillHandler],
  ["stage1.return-closure.backfill@1", stage1ReturnClosureBackfillHandler],
  ["stage1.task9.preflight@1", stage1Task9PreflightHandler],
  ["subscription.segment.bootstrap@1", subscriptionSegmentBootstrapHandler]
]);
