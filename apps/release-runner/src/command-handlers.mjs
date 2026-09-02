import { dbMigrateDeployHandler } from "./commands/db-migrate-deploy.mjs";
import { dbSchemaVerifyHandler } from "./commands/db-schema-verify.mjs";
import { stage1AcceptanceTargetVerifyHandler } from "./commands/stage1-acceptance-target-verify.mjs";
import { stage1Task9PreflightHandler } from "./commands/stage1-task9-preflight.mjs";

export const commandHandlers = new Map([
  ["release.verify@1", async ({ baseline }) => ({ baseline, terminalStatus: "PASSED" })],
  ["schema.migrate@1", async ({ baseline }) => ({ baseline, terminalStatus: "PASSED" })],
  ["repair.execute@1", async ({ baseline }) => ({ baseline, terminalStatus: "PASSED" })],
  ["evidence.export@1", async ({ baseline }) => ({ baseline, terminalStatus: "PASSED" })],
  ["db.migrate.deploy@1", dbMigrateDeployHandler],
  ["db.schema.verify@1", dbSchemaVerifyHandler],
  ["stage1.acceptance.target.verify@1", stage1AcceptanceTargetVerifyHandler],
  ["stage1.task9.preflight@1", stage1Task9PreflightHandler]
]);
