import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertApplyAllowed,
  buildLowRiskTablePlan,
  hasBlockingIssues,
  markPlanUpdated,
  parseBackfillMode,
  summarizeBackfill
} from "./model-definition-backfill-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(repoRoot, ".tmp/model-definition-backfill");
const requireFromApi = createRequire(resolve(repoRoot, "apps/api/package.json"));
const [{ PrismaPg }, { PrismaClient }, { config }] = await Promise.all([
  import(pathToFileURL(requireFromApi.resolve("@prisma/adapter-pg")).href),
  import(pathToFileURL(requireFromApi.resolve("@prisma/client")).href),
  import(pathToFileURL(requireFromApi.resolve("dotenv")).href)
]);

config({ path: resolve(repoRoot, ".env") });
config({ path: resolve(repoRoot, "apps/api/.env") });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for modelDefinitionId low-risk backfill.");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg(normalizeLocalhostDatabaseUrl(databaseUrl))
});

async function main() {
  const mode = parseBackfillMode(process.argv.slice(2));
  assertApplyAllowed({ mode });

  const dryRunPlan = await buildDryRunPlan();
  let plans = dryRunPlan.plans;
  let applyBlocked = false;
  let applyError = null;

  if (mode === "apply") {
    if (hasBlockingIssues(plans)) {
      applyBlocked = true;
      applyError = "Backfill apply blocked because unresolved or conflict records exist.";
    } else {
      plans = await applyPlans(plans);
    }
  }

  const report = buildReport({
    applyBlocked,
    applyError,
    environment: environmentSummary(),
    mode,
    plans
  });

  await writeReports(report);
  console.log(JSON.stringify(report, null, 2));

  if (applyBlocked) {
    process.exitCode = 1;
  }
}

async function buildDryRunPlan() {
  const definitions = await prisma.vehicleModelDefinition.findMany({
    select: { deletedAt: true, enabled: true, id: true, legacyVehicleModel: true },
    where: { deletedAt: null, enabled: true, legacyVehicleModel: { not: null } }
  });
  const vehicles = await prisma.vehicle.findMany({
    select: { id: true, modelDefinitionId: true, vehicleModel: true }
  });
  const vehiclePackages = await prisma.vehiclePackage.findMany({
    select: { id: true, modelDefinitionId: true, vehicleModel: true }
  });
  const productPriceRules = await prisma.productPriceRule.findMany({
    select: { id: true, modelDefinitionId: true, vehicleModel: true }
  });

  return {
    definitions,
    plans: {
      productPriceRule: buildLowRiskTablePlan({
        definitions,
        records: productPriceRules,
        tableName: "ProductPriceRule"
      }),
      vehicle: buildLowRiskTablePlan({
        definitions,
        records: vehicles,
        tableName: "Vehicle"
      }),
      vehiclePackage: buildLowRiskTablePlan({
        definitions,
        records: vehiclePackages,
        tableName: "VehiclePackage"
      })
    }
  };
}

async function applyPlans(plans) {
  const result = await prisma.$transaction(async (tx) => ({
    productPriceRule: markPlanUpdated(plans.productPriceRule, await applyProductPriceRulePlan(tx, plans.productPriceRule)),
    vehicle: markPlanUpdated(plans.vehicle, await applyVehiclePlan(tx, plans.vehicle)),
    vehiclePackage: markPlanUpdated(plans.vehiclePackage, await applyVehiclePackagePlan(tx, plans.vehiclePackage))
  }));

  return result;
}

async function applyVehiclePlan(tx, plan) {
  let updated = 0;

  for (const update of plan.updates) {
    const result = await tx.vehicle.updateMany({
      data: { modelDefinitionId: update.modelDefinitionId },
      where: { id: update.id, modelDefinitionId: null }
    });
    updated += result.count;
  }

  return updated;
}

async function applyVehiclePackagePlan(tx, plan) {
  let updated = 0;

  for (const update of plan.updates) {
    const result = await tx.vehiclePackage.updateMany({
      data: { modelDefinitionId: update.modelDefinitionId },
      where: { id: update.id, modelDefinitionId: null }
    });
    updated += result.count;
  }

  return updated;
}

async function applyProductPriceRulePlan(tx, plan) {
  let updated = 0;

  for (const update of plan.updates) {
    const result = await tx.productPriceRule.updateMany({
      data: { modelDefinitionId: update.modelDefinitionId },
      where: { id: update.id, modelDefinitionId: null }
    });
    updated += result.count;
  }

  return updated;
}

function buildReport({ applyBlocked, applyError, environment, mode, plans }) {
  const summary = summarizeBackfill(plans);

  return {
    applyBlocked,
    applyError,
    generatedAt: new Date().toISOString(),
    mode,
    noOp: mode !== "apply" || applyBlocked,
    outOfScope: [
      "SubscriptionQuote",
      "SubscriptionOrder",
      "VehicleMarketPriceObservation",
      "VehicleResidualCurve",
      "VehicleResidualForecast",
      "ResidualModelRun"
    ],
    productionWarning:
      environment.isProduction && mode === "apply"
        ? "Production backfill requires backup and manual approval."
        : null,
    scope: ["Vehicle", "VehiclePackage", "ProductPriceRule"],
    summary,
    tables: {
      productPriceRule: serializePlan(plans.productPriceRule),
      vehicle: serializePlan(plans.vehicle),
      vehiclePackage: serializePlan(plans.vehiclePackage)
    },
    environment
  };
}

function serializePlan(plan) {
  return {
    conflicts: plan.conflicts,
    conflictCount: plan.conflicts.length,
    matched: plan.matched,
    skippedExisting: plan.skippedExisting,
    tableName: plan.tableName,
    total: plan.total,
    unresolved: plan.unresolved,
    unresolvedCount: plan.unresolved.length,
    updated: plan.updated,
    updates: plan.updates
  };
}

async function writeReports(report) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(resolve(outputDir, "latest.md"), renderMarkdownReport(report), "utf8");
}

function renderMarkdownReport(report) {
  const lines = [
    "# modelDefinitionId Low-risk Backfill Report",
    "",
    `Generated at: ${report.generatedAt}`,
    `Mode: ${report.mode}`,
    `No-op: ${report.noOp}`,
    "",
    "## Summary",
    "",
    "| Metric | Count |",
    "| --- | ---: |",
    `| total | ${report.summary.total} |`,
    `| matched | ${report.summary.matched} |`,
    `| updated | ${report.summary.updated} |`,
    `| skippedExisting | ${report.summary.skippedExisting} |`,
    `| unresolved | ${report.summary.unresolved} |`,
    `| conflicts | ${report.summary.conflicts} |`,
    "",
    "## Tables"
  ];

  for (const plan of Object.values(report.tables)) {
    lines.push(
      "",
      `### ${plan.tableName}`,
      "",
      "| Metric | Count |",
      "| --- | ---: |",
      `| total | ${plan.total} |`,
      `| matched | ${plan.matched} |`,
      `| updated | ${plan.updated} |`,
      `| skippedExisting | ${plan.skippedExisting} |`,
      `| unresolved | ${plan.unresolvedCount} |`,
      `| conflicts | ${plan.conflictCount} |`
    );
  }

  lines.push("", "## Out of Scope", "", ...report.outOfScope.map((item) => `- ${item}`), "");

  return lines.join("\n");
}

function environmentSummary() {
  const appEnv = process.env.APP_ENV ?? null;
  const nodeEnv = process.env.NODE_ENV ?? null;
  const isProduction = appEnv === "production" || nodeEnv === "production";

  return {
    allowProductionBackfill: process.env.ALLOW_PRODUCTION_MODEL_DEFINITION_BACKFILL === "1",
    appEnv,
    isProduction,
    nodeEnv
  };
}

function normalizeLocalhostDatabaseUrl(value) {
  const url = new URL(value);
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url.toString();
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
