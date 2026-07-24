import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertApplyAllowed,
  buildOrderSnapshotPlan,
  buildQuoteSnapshotPlan,
  hasBlockingIssues,
  markPlanUpdated,
  parseBackfillMode,
  summarizeBackfill
} from "./quote-order-model-snapshot-backfill-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(repoRoot, ".tmp/quote-order-snapshot-backfill");
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
  throw new Error("DATABASE_URL is required for Quote / Order snapshot backfill.");
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
      applyError = "Quote / Order snapshot backfill apply blocked because unresolved or conflict records exist.";
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
    select: {
      deletedAt: true,
      displayName: true,
      enabled: true,
      id: true,
      legacyVehicleModel: true,
      modelCode: true
    },
    where: {
      deletedAt: null
    }
  });
  const quotes = await prisma.subscriptionQuote.findMany({
    select: {
      id: true,
      legacyVehicleModelSnapshot: true,
      modelDefinitionIdSnapshot: true,
      modelDisplayNameSnapshot: true,
      vehicleModel: true
    }
  });
  const orders = await prisma.subscriptionOrder.findMany({
    select: {
      id: true,
      legacyVehicleModelSnapshot: true,
      modelDefinitionIdSnapshot: true,
      modelDisplayNameSnapshot: true,
      quote: {
        select: {
          id: true,
          legacyVehicleModelSnapshot: true,
          modelDefinitionIdSnapshot: true,
          modelDisplayNameSnapshot: true,
          vehicleModel: true
        }
      },
      quoteId: true,
      vehicleModel: true
    }
  });

  const quotePlan = buildQuoteSnapshotPlan({ definitions, quotes });
  const orderPlan = buildOrderSnapshotPlan({ definitions, orders, quotePlan });

  return {
    definitions,
    plans: {
      order: orderPlan,
      quote: quotePlan
    }
  };
}

async function applyPlans(plans) {
  return prisma.$transaction(async (tx) => {
    const quote = markPlanUpdated(plans.quote, await applyQuotePlan(tx, plans.quote));
    const order = markPlanUpdated(plans.order, await applyOrderPlan(tx, plans.order));
    return { order, quote };
  });
}

async function applyQuotePlan(tx, plan) {
  let updated = 0;

  for (const update of plan.updates) {
    const result = await tx.subscriptionQuote.updateMany({
      data: {
        legacyVehicleModelSnapshot: update.legacyVehicleModelSnapshot,
        modelDefinitionIdSnapshot: update.modelDefinitionIdSnapshot,
        modelDisplayNameSnapshot: update.modelDisplayNameSnapshot
      },
      where: {
        id: update.id,
        legacyVehicleModelSnapshot: null,
        modelDefinitionIdSnapshot: null,
        modelDisplayNameSnapshot: null
      }
    });
    updated += result.count;
  }

  return updated;
}

async function applyOrderPlan(tx, plan) {
  let updated = 0;

  for (const update of plan.updates) {
    const result = await tx.subscriptionOrder.updateMany({
      data: {
        legacyVehicleModelSnapshot: update.legacyVehicleModelSnapshot,
        modelDefinitionIdSnapshot: update.modelDefinitionIdSnapshot,
        modelDisplayNameSnapshot: update.modelDisplayNameSnapshot
      },
      where: {
        id: update.id,
        legacyVehicleModelSnapshot: null,
        modelDefinitionIdSnapshot: null,
        modelDisplayNameSnapshot: null
      }
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
    auditNote:
      "Backfilled snapshots preserve the original string vehicleModel value and resolve current VehicleModelDefinition codes. They are additive explanation fields and do not modify original quote/order facts.",
    environment,
    generatedAt: new Date().toISOString(),
    mode,
    noOp: mode !== "apply" || applyBlocked,
    outOfScope: [
      "Vehicle",
      "VehiclePackage",
      "ProductPriceRule",
      "VehicleMarketPriceObservation",
      "VehicleResidualCurve",
      "VehicleResidualForecast",
      "ResidualModelRun",
      "PaymentRecord",
      "PaymentWriteOff",
      "ReceivableBill",
      "Contract"
    ],
    productionWarning:
      environment.isProduction && mode === "apply"
        ? "Production snapshot backfill requires backup and manual approval."
        : null,
    scope: ["SubscriptionQuote snapshot fields", "SubscriptionOrder snapshot fields"],
    summary,
    tables: {
      order: serializePlan(plans.order),
      quote: serializePlan(plans.quote)
    }
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
    "# Quote / Order Snapshot Backfill Report",
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

  lines.push(
    "",
    "## Audit Note",
    "",
    "Backfilled snapshots preserve the original string vehicleModel value and resolve current VehicleModelDefinition codes.",
    "They are additive explanation fields and do not modify original quote/order facts.",
    "",
    "## Out of Scope",
    "",
    ...report.outOfScope.map((item) => `- ${item}`),
    ""
  );

  return lines.join("\n");
}

function environmentSummary() {
  const appEnv = process.env.APP_ENV ?? null;
  const nodeEnv = process.env.NODE_ENV ?? null;
  const isProduction = appEnv === "production" || nodeEnv === "production";

  return {
    allowProductionBackfill: process.env.ALLOW_PRODUCTION_QUOTE_ORDER_SNAPSHOT_BACKFILL === "1",
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
